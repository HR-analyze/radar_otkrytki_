'use client';

import { useRouter } from 'next/navigation';
import { createPortal } from 'react-dom';
import { useCallback, useEffect, useRef, useState } from 'react';
import { plural } from '@/lib/plural';

/**
 * Кнопка «Загрузить выгрузки» — способ добавить данные, не заходя в репозиторий.
 *
 * До неё новый день добавлялся только руками через git, то есть данными мог
 * заниматься лишь тот, у кого есть доступ к репозиторию. Кнопка делает ровно то
 * же самое, но за человека, и главное — сразу показывает, что именно система
 * поняла в файле: тип выгрузки, дни, объём. «Файл загружен» без этого
 * бесполезно: перепутанный или пустой файл выглядел бы точно так же.
 */

/** Совпадает с MAX_UPLOAD_BYTES на сервере. */
const MAX_FILE_BYTES = 4 * 1024 * 1024;
/** Serverless-функция Vercel не принимает тело больше 4.5 МБ — режем пачку заранее. */
const MAX_BATCH_BYTES = 3.5 * 1024 * 1024;
const TOKEN_KEY = 'radar.uploadToken';

/** Сколько ждём пересборку после коммита: обычно минута-полторы. */
const POLL_INTERVAL_MS = 10_000;
const POLL_LIMIT = 42;

interface UploadStatus {
  mode: 'disk' | 'github' | 'unavailable';
  hint: string;
  tokenRequired: boolean;
  fingerprint: string;
  dates: { from: string | null; to: string | null; count: number };
}

type FileResult =
  | {
      ok: true;
      name: string;
      savedAs: string;
      summary: string;
      warnings: number;
    }
  | { ok: false; name: string; error: string };

interface UploadResponse {
  ok: boolean;
  visible?: 'now' | 'after-deploy' | 'manual';
  notes?: string[];
  commitUrl?: string;
  files?: FileResult[];
  error?: string;
}

type Stage = 'idle' | 'sending' | 'waiting' | 'done' | 'failed';

export function UploadButton() {
  const router = useRouter();
  const [open, setOpen] = useState(false);
  const [status, setStatus] = useState<UploadStatus | null>(null);
  const [stage, setStage] = useState<Stage>('idle');
  const [results, setResults] = useState<FileResult[]>([]);
  const [notes, setNotes] = useState<string[]>([]);
  const [error, setError] = useState<string | null>(null);
  const [token, setToken] = useState('');
  const [dragging, setDragging] = useState(false);
  const [mounted, setMounted] = useState(false);
  /** Какой период дашборд отдаёт после загрузки — подтверждение, что данные доехали. */
  const [covered, setCovered] = useState<string | null>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const alive = useRef(true);

  useEffect(() => setMounted(true), []);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  useEffect(() => {
    if (!open) return;
    setToken((t) => t || readToken());
    void fetch('/api/upload/status')
      .then((r) => r.json())
      .then((s: UploadStatus) => setStatus(s))
      .catch(() => setStatus(null));
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  /**
   * Ждём, пока пересборка после коммита доедет до сайта. Признак — сменившийся
   * отпечаток выгрузок в снимке: даты для этого не годятся, файл могли перезалить
   * за тот же день.
   */
  const waitForRebuild = useCallback(
    async (before: string) => {
      for (let i = 0; i < POLL_LIMIT; i++) {
        await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));
        if (!alive.current) return;

        try {
          const fresh = (await (await fetch('/api/upload/status')).json()) as UploadStatus;
          if (fresh.fingerprint && fresh.fingerprint !== before) {
            if (!alive.current) return;
            setCovered(describeCoverage(fresh));
            setStage('done');
            router.refresh();
            return;
          }
        } catch {
          // Во время деплоя сайт минуту недоступен — это нормально, ждём дальше.
        }
      }
      if (alive.current) setStage('failed');
    },
    [router],
  );

  async function upload(selected: File[]) {
    // Отпечаток «до»: по его смене видно, что пересборка доехала. Если статус
    // ещё не успел загрузиться, спрашиваем сейчас — иначе ожидание закончилось
    // бы на первом же опросе, ничего не дождавшись.
    let before = status?.fingerprint ?? '';
    if (!before) {
      try {
        const fresh = (await (await fetch('/api/upload/status')).json()) as UploadStatus;
        before = fresh.fingerprint ?? '';
      } catch {
        // Не страшно: без отпечатка просто не будет автообновления страницы.
      }
    }

    setStage('sending');
    setResults([]);
    setNotes([]);
    setError(null);
    setCovered(null);

    const tooBig = selected.filter((f) => f.size > MAX_FILE_BYTES);
    const sendable = selected.filter((f) => f.size <= MAX_FILE_BYTES);
    const collected: FileResult[] = tooBig.map((f) => ({
      ok: false,
      name: f.name,
      error: `Файл весит ${Math.round(f.size / 1024 / 1024)} МБ — больше ${MAX_FILE_BYTES / 1024 / 1024} МБ загрузить нельзя.`,
    }));

    let visible: UploadResponse['visible'];
    const gathered: string[] = [];

    try {
      for (const batch of batches(sendable)) {
        const body = new FormData();
        for (const f of batch) body.append('files', f, f.name);

        const res = await fetch('/api/upload', {
          method: 'POST',
          headers: token ? { 'x-radar-upload-token': token } : undefined,
          body,
        });
        const data = (await res.json()) as UploadResponse;

        collected.push(...(data.files ?? []));
        gathered.push(...(data.notes ?? []));
        visible = data.visible ?? visible;

        if (!res.ok) {
          if (res.status === 401) forgetToken();
          throw new Error(data.error ?? `Сервер ответил ${res.status}`);
        }
        if (token) rememberToken(token);
      }
    } catch (e) {
      setResults(collected);
      setNotes(gathered);
      setError(e instanceof Error ? e.message : 'Сеть недоступна');
      setStage('failed');
      return;
    }

    setResults(collected);
    setNotes(gathered);

    if (collected.every((r) => !r.ok)) {
      setError('Ни один файл не распознан');
      setStage('failed');
      return;
    }

    if (visible === 'now') {
      setStage('done');
      router.refresh();
      void fetch('/api/upload/status')
        .then((r) => r.json())
        .then((fresh: UploadStatus) => alive.current && setCovered(describeCoverage(fresh)))
        .catch(() => {});
      return;
    }
    if (visible === 'manual') {
      setStage('done');
      return;
    }

    setStage('waiting');
    void waitForRebuild(before);
  }

  const busy = stage === 'sending' || stage === 'waiting';

  return (
    <>
      <button
        type="button"
        onClick={() => setOpen(true)}
        className="rounded-md border px-3 py-1.5 text-sm transition-opacity hover:opacity-80"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        {stage === 'waiting' ? 'Загрузка · идёт пересборка…' : '⬆ Загрузить выгрузки'}
      </button>

      {open &&
        mounted &&
        createPortal(
          /* Через портал в body: у шапки backdrop-blur, а он делает её
             containing block для position: fixed — окно, отрисованное внутри,
             обрезалось бы по высоте шапки. */
          <div
            className="fixed inset-0 z-[100] flex items-start justify-center overflow-y-auto p-4 sm:p-8"
            style={{
              background: 'color-mix(in srgb, #0f172a 55%, transparent)',
            }}
            onClick={() => setOpen(false)}
          >
            <div
              role="dialog"
              aria-modal="true"
              aria-label="Загрузка выгрузок"
              className="surface w-full max-w-2xl p-5"
              onClick={(e) => e.stopPropagation()}
            >
              <div className="flex items-start justify-between gap-4">
                <div>
                  <h2 className="text-lg font-semibold tracking-tight">Загрузить выгрузки</h2>
                  <p className="mt-1 text-xs muted">
                    {status?.hint ?? 'Проверяю, куда можно сохранить файлы…'}
                  </p>
                </div>
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  className="rounded-md border px-2 py-1 text-sm"
                  style={{ borderColor: 'var(--border)' }}
                  aria-label="Закрыть"
                >
                  ✕
                </button>
              </div>

              {status?.mode === 'unavailable' ? (
                <p
                  className="mt-4 rounded-lg border p-3 text-sm"
                  style={{ borderColor: 'var(--yellow)' }}
                >
                  {status.hint}
                </p>
              ) : (
                <>
                  {status?.tokenRequired && (
                    <label className="mt-4 block text-sm">
                      <span className="muted">Код загрузки</span>
                      <input
                        type="password"
                        value={token}
                        onChange={(e) => setToken(e.target.value)}
                        placeholder="общий код команды"
                        className="mt-1 w-full rounded-lg border px-3 py-2 text-sm"
                        style={{
                          borderColor: 'var(--border)',
                          background: 'var(--surface)',
                          color: 'var(--text)',
                        }}
                      />
                    </label>
                  )}

                  <div
                    onDragOver={(e) => {
                      e.preventDefault();
                      setDragging(true);
                    }}
                    onDragLeave={() => setDragging(false)}
                    onDrop={(e) => {
                      e.preventDefault();
                      setDragging(false);
                      const dropped = [...e.dataTransfer.files];
                      if (dropped.length && !busy) void upload(dropped);
                    }}
                    className="mt-4 flex flex-col items-center gap-2 rounded-xl border border-dashed px-4 py-7 text-center"
                    style={{
                      borderColor: dragging ? 'var(--text)' : 'var(--border)',
                      background: dragging ? 'var(--neutral-soft)' : 'transparent',
                    }}
                  >
                    <p className="text-sm">Перетащите сюда файлы выгрузок или</p>
                    <button
                      type="button"
                      onClick={() => inputRef.current?.click()}
                      disabled={busy}
                      className="rounded-md border px-3 py-1.5 text-sm disabled:opacity-50"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                      }}
                    >
                      {stage === 'sending' ? 'Проверяю файлы…' : 'Выбрать файлы'}
                    </button>
                    <p className="text-xs muted">
                      .xls и .xlsx · «выходы», «водители», книга «Витрины», «Время поставки»
                    </p>
                    <input
                      ref={inputRef}
                      type="file"
                      multiple
                      accept=".xls,.xlsx"
                      className="hidden"
                      onChange={(e) => {
                        const chosen = [...(e.target.files ?? [])];
                        e.target.value = '';
                        if (chosen.length) void upload(chosen);
                      }}
                    />
                  </div>

                  {results.length > 0 && (
                    <ul className="mt-4 flex flex-col gap-2">
                      {results.map((r, i) => (
                        <li
                          key={`${r.name}-${i}`}
                          className="rounded-lg border p-3 text-sm"
                          style={{
                            borderColor: r.ok ? 'var(--border)' : 'var(--red)',
                            background: r.ok ? 'transparent' : 'var(--red-soft)',
                          }}
                        >
                          <div className="flex items-baseline gap-2">
                            <span>{r.ok ? '✅' : '⛔'}</span>
                            <span className="font-medium break-all">{r.name}</span>
                          </div>
                          {r.ok ? (
                            <>
                              <p className="mt-1">{r.summary}</p>
                              <p className="mt-0.5 text-xs muted">
                                Сохранён как {r.savedAs}
                                {r.warnings > 0 && ` · предупреждений при разборе: ${r.warnings}`}
                              </p>
                            </>
                          ) : (
                            <p className="mt-1">{r.error}</p>
                          )}
                        </li>
                      ))}
                    </ul>
                  )}

                  {notes.map((n) => (
                    <p key={n} className="mt-2 text-xs muted">
                      {n}
                    </p>
                  ))}

                  {stage === 'waiting' && (
                    <p className="mt-4 text-sm">
                      ⏳ Файлы приняты, дашборд пересобирается. Обычно это минута-полторы — страница
                      обновится сама, окно можно не держать открытым.
                    </p>
                  )}
                  {stage === 'done' && (
                    <p className="mt-4 text-sm" style={{ color: 'var(--green)' }}>
                      ✅ Готово. Данные на дашборде{covered ? `: ${covered}` : ''}.
                    </p>
                  )}
                  {error && (
                    <p className="mt-4 text-sm" style={{ color: 'var(--red)' }}>
                      {error}
                    </p>
                  )}
                  {stage === 'failed' && !error && (
                    <p className="mt-4 text-sm">
                      Пересборка идёт дольше обычного. Файлы приняты — обновите страницу через
                      несколько минут.
                    </p>
                  )}
                </>
              )}
            </div>
          </div>,
          document.body,
        )}
    </>
  );
}

/* Доступ к localStorage бросает исключение там, где сайту запрещены данные
   (приватное окно, корпоративная политика): код загрузки — удобство, из-за
   которого панель падать не должна. */
function readToken(): string {
  try {
    return localStorage.getItem(TOKEN_KEY) ?? '';
  } catch {
    return '';
  }
}

function rememberToken(value: string): void {
  try {
    localStorage.setItem(TOKEN_KEY, value);
  } catch {
    // Не запомнили — код спросят ещё раз.
  }
}

function forgetToken(): void {
  try {
    localStorage.removeItem(TOKEN_KEY);
  } catch {
    // Нечего забывать.
  }
}

/** «19.08 — 31.08, 13 дней» — чем дашборд отвечает после загрузки. */
function describeCoverage(status: UploadStatus): string | null {
  const { from, to, count } = status.dates ?? {};
  if (!from || !to) return null;
  const short = (iso: string) => iso.split('-').reverse().slice(0, 2).join('.');
  return `${short(from)} — ${short(to)}, ${count} ${plural(count, 'день', 'дня', 'дней')}`;
}

/** Пачки не больше MAX_BATCH_BYTES: тело запроса на Vercel ограничено. */
function batches(files: readonly File[]): File[][] {
  const out: File[][] = [];
  let current: File[] = [];
  let size = 0;

  for (const file of files) {
    if (current.length > 0 && size + file.size > MAX_BATCH_BYTES) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(file);
    size += file.size;
  }
  if (current.length > 0) out.push(current);
  return out;
}
