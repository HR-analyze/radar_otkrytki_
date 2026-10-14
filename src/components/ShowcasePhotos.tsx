'use client';

import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useDialog } from '@/lib/use-dialog';
import { FIELD_STYLE, humanDate } from './showcase-ui';

/**
 * Фото витрины в строке редактора: значок «📷 2/5» и окно со снимками.
 *
 * К лавке за день прикладывают от 1 до 5 фото (см. showcase-photos.ts). Окно
 * общее для обоих редакторов — дневного и полавочного: ключ, как и у
 * процентов, «дата + лавка».
 *
 * Снимок с телефона весит 3–8 МБ, а на точке часто мобильный интернет. Перед
 * отправкой фото ужимается здесь же, в браузере, до 1600 px по длинной
 * стороне — это 200–500 КБ, и на витрине по-прежнему видно каждую полку.
 * Отправляется по одному файлу за запрос: один большой запрос с пятью
 * снимками рвётся на плохой связи целиком, а так доезжает хотя бы часть, и
 * видно, какая именно.
 */

/** Столько же, сколько принимает сервер (MAX_PHOTOS в showcase-photos.ts). */
const MAX_PHOTOS = 5;
const MAX_SIDE = 1600;
const JPEG_QUALITY = 0.82;

interface Photo {
  id: string;
  size: number;
  createdAt: string;
}

export function ShowcasePhotos({
  date,
  shopCode,
  count,
  readOnly,
  onCount,
}: {
  date: string;
  shopCode: string;
  /** Сколько фото уже есть — из ответа /api/showcase, до открытия окна. */
  count: number;
  readOnly: boolean;
  onCount: (count: number) => void;
}) {
  const [open, setOpen] = useState(false);

  // Без фото и без права добавлять — значок ни о чём, только шум в строке.
  if (readOnly && count === 0) return <span className="order-3 w-16 shrink-0" />;

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        title={
          count > 0
            ? `Фото витрины: ${count} из ${MAX_PHOTOS}`
            : `Добавить фото витрины — от 1 до ${MAX_PHOTOS}`
        }
        aria-label={`Фото витрины, ${shopCode}, ${date}: ${count} из ${MAX_PHOTOS}`}
        className="order-3 w-16 shrink-0 rounded-lg border px-2 py-1.5 text-xs tabular-nums"
        style={{ ...FIELD_STYLE, opacity: count > 0 ? 1 : 0.6 }}
      >
        📷 {count > 0 ? `${count}/${MAX_PHOTOS}` : '+'}
      </button>
      {open && (
        <PhotosDialog
          date={date}
          shopCode={shopCode}
          readOnly={readOnly}
          onCount={onCount}
          onClose={() => setOpen(false)}
        />
      )}
    </>
  );
}

function PhotosDialog({
  date,
  shopCode,
  readOnly,
  onCount,
  onClose,
}: {
  date: string;
  shopCode: string;
  readOnly: boolean;
  onCount: (count: number) => void;
  onClose: () => void;
}) {
  const dialogRef = useRef<HTMLDivElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const [photos, setPhotos] = useState<Photo[] | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useDialog(true, dialogRef);

  // Пока фото летит на сервер, окно не закрывается: иначе непонятно, доехало ли.
  const busyRef = useRef(busy);
  // Родитель передаёт onCount новой функцией на каждый рендер; через ref
  // загрузка списка не перезапускается от каждой цифры в соседнем поле.
  const onCountRef = useRef(onCount);
  useEffect(() => {
    busyRef.current = busy;
    onCountRef.current = onCount;
  }, [busy, onCount]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && !busyRef.current) onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  useEffect(() => {
    let alive = true;
    void fetch(`/api/showcase/photos?date=${date}&shop=${encodeURIComponent(shopCode)}`)
      .then((r) => r.json())
      .then((body: { ok: boolean; photos?: Photo[]; error?: string }) => {
        if (!alive) return;
        if (!body.ok) throw new Error(body.error ?? 'Не удалось загрузить фото');
        setPhotos(body.photos ?? []);
        onCountRef.current(body.photos?.length ?? 0);
      })
      .catch((e: unknown) => alive && setError(e instanceof Error ? e.message : 'Сеть недоступна'));
    return () => {
      alive = false;
    };
  }, [date, shopCode]);

  const have = photos?.length ?? 0;
  const left = MAX_PHOTOS - have;

  function apply(next: Photo[]) {
    setPhotos(next);
    onCountRef.current(next.length);
  }

  async function upload(selected: File[]) {
    setError(null);
    if (selected.length === 0) return;
    if (selected.length > left) {
      setError(
        left === 0
          ? `Уже ${MAX_PHOTOS} фото — больше нельзя. Удалите лишнее, чтобы добавить новое.`
          : `Можно добавить ещё ${left} из ${MAX_PHOTOS}, а выбрано ${selected.length}.`,
      );
      return;
    }

    try {
      for (const [i, file] of selected.entries()) {
        setBusy(
          selected.length > 1 ? `Отправляю ${i + 1} из ${selected.length}…` : 'Отправляю фото…',
        );
        const body = new FormData();
        body.append('date', date);
        body.append('shop', shopCode);
        body.append('files', await shrink(file), jpegName(file.name));

        const res = await fetch('/api/showcase/photos', { method: 'POST', body });
        const data = (await res.json()) as { ok: boolean; photos?: Photo[]; error?: string };
        if (data.photos) apply(data.photos);
        if (!res.ok || !data.ok) throw new Error(data.error ?? `Сервер ответил ${res.status}`);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Сеть недоступна — фото не отправлено');
    } finally {
      setBusy(null);
      if (fileRef.current) fileRef.current.value = '';
    }
  }

  async function remove(id: string) {
    if (!window.confirm('Удалить это фото? Вернуть его будет нельзя.')) return;
    setError(null);
    setBusy('Удаляю…');
    try {
      const res = await fetch(`/api/showcase/photos/${id}`, { method: 'DELETE' });
      const data = (await res.json()) as { ok: boolean; photos?: Photo[]; error?: string };
      if (data.photos) apply(data.photos);
      else if (res.status === 404) apply((photos ?? []).filter((p) => p.id !== id));
      if (!res.ok && res.status !== 404) throw new Error(data.error ?? `Сервер ответил ${res.status}`);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Сеть недоступна');
    } finally {
      setBusy(null);
    }
  }

  return createPortal(
    /* Через портал в body — как окно загрузки выгрузок: внутри строки списка
       position: fixed обрезался бы родителем с overflow: hidden. */
    <div
      className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:p-8"
      style={{ background: 'color-mix(in srgb, #0f172a 55%, transparent)' }}
      onClick={() => !busy && onClose()}
    >
      <div
        ref={dialogRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="photos-title"
        className="surface w-full max-w-2xl p-5"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="flex items-start justify-between gap-4">
          <div>
            <h2 id="photos-title" className="text-lg font-semibold">
              📷 Фото витрины · {shopCode}
            </h2>
            <p className="mt-0.5 text-sm muted">
              {humanDate(date)} · {photos == null ? '…' : `${have} из ${MAX_PHOTOS}`}
            </p>
          </div>
          <button
            type="button"
            onClick={onClose}
            disabled={!!busy}
            aria-label="Закрыть"
            className="rounded-lg border px-3 py-1.5 text-sm disabled:opacity-40"
            style={FIELD_STYLE}
          >
            ✕
          </button>
        </div>

        {error && (
          <p className="surface mt-4 p-3 text-sm ink-red" style={{ borderColor: 'var(--red)' }}>
            {error}
          </p>
        )}

        <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-3">
          {photos?.map((p, i) => (
            <figure key={p.id} className="relative">
              {/* Открывается в новой вкладке в полном размере: увеличить полку
                  на телефоне проще там, чем в окне поверх списка. */}
              <a href={`/api/showcase/photos/${p.id}`} target="_blank" rel="noreferrer">
                <img
                  src={`/api/showcase/photos/${p.id}`}
                  alt={`Витрина ${shopCode}, ${humanDate(date)}, фото ${i + 1}`}
                  loading="lazy"
                  className="aspect-[4/3] w-full rounded-lg border object-cover"
                  style={{ borderColor: 'var(--border)' }}
                />
              </a>
              {!readOnly && (
                <button
                  type="button"
                  onClick={() => void remove(p.id)}
                  disabled={!!busy}
                  title="Удалить фото"
                  aria-label={`Удалить фото ${i + 1}`}
                  className="absolute top-1.5 right-1.5 rounded-md border px-2 py-0.5 text-xs disabled:opacity-40"
                  style={FIELD_STYLE}
                >
                  🗑
                </button>
              )}
            </figure>
          ))}

          {!readOnly && photos != null && left > 0 && (
            <label
              className={`flex aspect-[4/3] cursor-pointer flex-col items-center justify-center gap-1 rounded-lg border border-dashed text-sm ${busy ? 'pointer-events-none opacity-50' : ''}`}
              style={{ borderColor: 'var(--border)' }}
            >
              <span className="text-2xl">＋</span>
              <span>Добавить фото</span>
              <span className="text-xs muted">ещё {left} из {MAX_PHOTOS}</span>
              <input
                ref={fileRef}
                type="file"
                accept="image/jpeg,image/png,image/webp,image/*"
                multiple
                disabled={!!busy}
                onChange={(e) => void upload([...(e.target.files ?? [])])}
                className="sr-only"
              />
            </label>
          )}
        </div>

        {photos == null && !error && <p className="mt-4 text-sm muted">Загружаю фото…</p>}
        {photos?.length === 0 && readOnly && <p className="mt-4 text-sm muted">Фото нет.</p>}
        <p className="mt-4 text-xs muted" aria-live="polite">
          {busy ??
            (readOnly
              ? 'Просмотр: добавлять и удалять фото здесь нельзя.'
              : `От 1 до ${MAX_PHOTOS} фото на лавку за день. Можно выбрать несколько сразу; перед отправкой они ужимаются, так что и с мобильного интернета уходят быстро. Клик по фото — открыть в полном размере.`)}
        </p>
      </div>
    </div>,
    document.body,
  );
}

/**
 * Ужимает снимок до MAX_SIDE по длинной стороне и перекодирует в JPEG.
 * Не получилось (браузер не умеет формат, например HEIC на компьютере) —
 * уходит исходный файл, а сервер честно скажет, что не принял.
 */
async function shrink(file: File): Promise<Blob> {
  try {
    // createImageBitmap по умолчанию учитывает поворот из EXIF — иначе
    // снимки с телефона ложились бы на бок.
    const bitmap = await createImageBitmap(file);
    const scale = Math.min(1, MAX_SIDE / Math.max(bitmap.width, bitmap.height));
    const canvas = document.createElement('canvas');
    canvas.width = Math.round(bitmap.width * scale);
    canvas.height = Math.round(bitmap.height * scale);
    const ctx = canvas.getContext('2d');
    if (!ctx) return file;
    // Белый фон: прозрачный PNG в JPEG иначе становится чёрным.
    ctx.fillStyle = '#fff';
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    bitmap.close();
    const blob = await new Promise<Blob | null>((resolve) =>
      canvas.toBlob(resolve, 'image/jpeg', JPEG_QUALITY),
    );
    // Маленький скриншот перекодирование может и раздуть — тогда шлём как есть.
    return blob && (blob.size < file.size || !/^image\/(jpeg|png|webp)$/.test(file.type))
      ? blob
      : file;
  } catch {
    return file;
  }
}

function jpegName(name: string): string {
  return name.replace(/\.[^.]+$/, '') + '.jpg';
}
