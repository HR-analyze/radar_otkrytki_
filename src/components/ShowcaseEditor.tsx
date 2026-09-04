'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { plural } from '@/lib/plural';
import type { Status } from '@/lib/types';

/**
 * Редактор наполнения витрин.
 *
 * Раньше эти проценты жили в Excel-книге: её правили руками и перезаливали
 * целиком. Здесь то же самое делается на месте, и заточено оно под один
 * сценарий — человек садится и проходит день по списку лавок:
 *
 *  · день переключается стрелками, значение вводится числом, Enter — вниз;
 *  · сохраняется само, через полсекунды после ввода, без кнопки «Сохранить»:
 *    забыть нажать её — значит потерять работу;
 *  · статус 🟢/🟡/🔴 появляется прямо в строке, сразу видно, что получилось;
 *  · счётчик «заполнено N из 80» показывает, сколько ещё осталось.
 */

interface ShopRow {
  code: string;
  name: string;
  region: string | null;
  percent: number | null;
  status: Status;
  /** Короткая пометка: «не привезли ягоды», «витрину чинили». */
  note: string;
}

interface DayData {
  ok: boolean;
  date: string;
  editable: boolean;
  hint: string;
  tokenRequired: boolean;
  updatedAt: string | null;
  thresholds: { green: number; yellow: number };
  knownDates: string[];
  filledByDate: Record<string, number>;
  shops: ShopRow[];
  error?: string;
}

type SaveState = 'idle' | 'saving' | 'saved' | 'error';

const TOKEN_KEY = 'radar.uploadToken';
/** Пауза после последнего нажатия клавиши, чтобы не слать запрос на каждую цифру. */
const SAVE_DEBOUNCE_MS = 500;
/** Столько же, сколько принимает сервер (см. /api/showcase). */
const MAX_NOTE = 300;

export function ShowcaseEditor({ initialDate }: { initialDate: string }) {
  const router = useRouter();
  const [date, setDate] = useState(initialDate);
  const [data, setData] = useState<DayData | null>(null);
  const [drafts, setDrafts] = useState<Record<string, string>>({});
  const [noteDrafts, setNoteDrafts] = useState<Record<string, string>>({});
  const [save, setSave] = useState<SaveState>('idle');
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState('');
  const [region, setRegion] = useState('');
  const [onlyEmpty, setOnlyEmpty] = useState(false);
  const [token, setToken] = useState('');

  // Копим правки по полям: процент и комментарий у одной лавки правят
  // независимо, и отправить нужно ровно то, что человек трогал.
  const pending = useRef<Map<string, { percent?: string; note?: string }>>(new Map());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const inputs = useRef<Map<string, HTMLInputElement>>(new Map());

  useEffect(() => {
    try {
      setToken(localStorage.getItem(TOKEN_KEY) ?? '');
    } catch {
      // Приватное окно — код спросим заново.
    }
  }, []);

  const load = useCallback(async (day: string) => {
    const res = await fetch(`/api/showcase?date=${day}`);
    const body = (await res.json()) as DayData;
    setData(body);
    setDrafts({});
    setNoteDrafts({});
    setSave('idle');
    setError(body.ok ? null : (body.error ?? 'Не удалось загрузить день'));
  }, []);

  useEffect(() => {
    void load(date);
  }, [date, load]);

  /** Отправляем накопленные правки одной пачкой. */
  const flush = useCallback(async () => {
    const batch = [...pending.current.entries()];
    if (batch.length === 0) return;
    pending.current.clear();

    setSave('saving');
    try {
      const res = await fetch('/api/showcase', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(token ? { 'x-radar-upload-token': token } : {}),
        },
        body: JSON.stringify({
          edits: batch.map(([shopCode, fields]) => ({
            date,
            shopCode,
            // Ключ кладём только для тронутого поля: иначе правка комментария
            // стёрла бы процент, и наоборот.
            ...(fields.percent !== undefined ? { percent: fields.percent || null } : {}),
            ...(fields.note !== undefined ? { note: fields.note } : {}),
          })),
        }),
      });
      const body = (await res.json()) as {
        ok: boolean;
        error?: string;
        saved?: { shopCode: string; percent: number | null; status: Status; note: string }[];
      };
      if (!res.ok || !body.ok) throw new Error(body.error ?? `Сервер ответил ${res.status}`);

      // Красим строки по ответу сервера, а не по своей догадке о порогах.
      setData((prev) =>
        prev
          ? {
              ...prev,
              shops: prev.shops.map((s) => {
                const saved = body.saved?.find((x) => x.shopCode === s.code);
                return saved
                  ? { ...s, percent: saved.percent, status: saved.status, note: saved.note }
                  : s;
              }),
            }
          : prev,
      );
      setSave('saved');
      setError(null);
      router.refresh();
    } catch (e) {
      setSave('error');
      setError(e instanceof Error ? e.message : 'Не удалось сохранить');
    }
  }, [date, router, token]);

  // Незаписанное не должно теряться при уходе со страницы.
  useEffect(() => {
    const onLeave = () => {
      if (pending.current.size > 0) void flush();
    };
    window.addEventListener('beforeunload', onLeave);
    return () => {
      window.removeEventListener('beforeunload', onLeave);
      onLeave();
    };
  }, [flush]);

  function queue(code: string, patch: { percent?: string; note?: string }) {
    pending.current.set(code, { ...pending.current.get(code), ...patch });
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => void flush(), SAVE_DEBOUNCE_MS);
  }

  function change(code: string, raw: string) {
    const value = raw.replace(',', '.').replace(/[^\d.]/g, '').slice(0, 5);
    setDrafts((d) => ({ ...d, [code]: value }));
    queue(code, { percent: value });
  }

  function changeNote(code: string, raw: string) {
    const value = raw.slice(0, MAX_NOTE);
    setNoteDrafts((d) => ({ ...d, [code]: value }));
    queue(code, { note: value });
  }

  const shops = data?.shops ?? [];
  const regions = useMemo(
    () => [...new Set(shops.map((s) => s.region).filter(Boolean))].sort() as string[],
    [shops],
  );

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return shops.filter((s) => {
      if (region && s.region !== region) return false;
      if (onlyEmpty && percentOf(s, drafts) !== '') return false;
      if (!q) return true;
      return `${s.code} ${s.name}`.toLowerCase().includes(q);
    });
  }, [shops, region, onlyEmpty, query, drafts]);

  const filled = shops.filter((s) => percentOf(s, drafts) !== '').length;
  const readOnly = data ? !data.editable : false;

  function focusNext(index: number) {
    const next = visible[index + 1];
    if (next) inputs.current.get(next.code)?.focus();
  }

  return (
    <div className="flex flex-col gap-4">
      {/* --- День и состояние сохранения --- */}
      <div className="surface flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-1">
          <StepButton label="←" title="Предыдущий день" onClick={() => setDate(shift(date, -1))} />
          <input
            type="date"
            value={date}
            onChange={(e) => e.target.value && setDate(e.target.value)}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          />
          <StepButton label="→" title="Следующий день" onClick={() => setDate(shift(date, 1))} />
        </div>

        {/* Нативное поле даты показывает формат системы — подписываем по-русски. */}
        <span className="text-sm font-medium">{humanDate(date)}</span>

        <span className="text-sm">
          Заполнено <b className="tabular-nums">{filled}</b> из {shops.length}{' '}
          {plural(shops.length, 'лавки', 'лавок', 'лавок')}
        </span>

        <span className="text-xs muted">
          {save === 'saving' && 'Сохраняю…'}
          {save === 'saved' && '✅ Сохранено'}
          {save === 'idle' && data?.updatedAt && `Последняя правка: ${when(data.updatedAt)}`}
        </span>

        {data?.tokenRequired && (
          <input
            type="password"
            value={token}
            onChange={(e) => {
              setToken(e.target.value);
              try {
                localStorage.setItem(TOKEN_KEY, e.target.value);
              } catch {
                // не запомнили — спросим ещё раз
              }
            }}
            placeholder="код доступа"
            className="ml-auto w-40 rounded-lg border px-3 py-2 text-sm"
            style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
          />
        )}
      </div>

      {readOnly && (
        <p className="surface p-3 text-sm" style={{ borderColor: 'var(--yellow)' }}>
          {data?.hint}
        </p>
      )}
      {error && (
        <p className="surface p-3 text-sm" style={{ borderColor: 'var(--red)', color: 'var(--red)' }}>
          {error}
        </p>
      )}

      {/* --- Фильтры: список из 80 лавок нужно уметь сузить --- */}
      <div className="flex flex-wrap items-center gap-2">
        <input
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Поиск: М12 или Покровка"
          className="w-56 rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
        />
        <div className="w-56">
          <select
            value={region}
            onChange={(e) => setRegion(e.target.value)}
            aria-label="Региональный менеджер"
          >
            <option value="">Все РМ</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
        </div>
        <label className="flex items-center gap-2 text-sm">
          <input type="checkbox" checked={onlyEmpty} onChange={(e) => setOnlyEmpty(e.target.checked)} />
          только незаполненные
        </label>
      </div>

      {/* --- Собственно список --- */}
      <div className="surface overflow-hidden">
        {data == null ? (
          <p className="p-6 text-sm muted">Загружаю день…</p>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm muted">Под фильтры не попала ни одна лавка.</p>
        ) : (
          <ul>
            {visible.map((shop, i) => {
              const value = percentOf(shop, drafts);
              return (
                <li
                  key={shop.code}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3 py-2 first:border-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  <span className="w-12 shrink-0 text-sm font-medium tabular-nums">{shop.code}</span>
                  <span className="min-w-0 flex-1 truncate text-sm" title={shop.name}>
                    {shop.name.replace(/^[А-ЯA-Z]+\d+\s*/i, '')}
                    {shop.region && <span className="ml-2 text-xs muted">{shop.region}</span>}
                  </span>

                  {/* Комментарий: поле без рамки, пока пустое, — восемьдесят
                      строк с рамками превратили бы список в решётку. Рамка
                      появляется, когда в поле что-то есть или на нём фокус. */}
                  <input
                    value={noteOf(shop, noteDrafts)}
                    onChange={(e) => changeNote(shop.code, e.target.value)}
                    disabled={readOnly}
                    placeholder="комментарий"
                    title={noteOf(shop, noteDrafts) || 'Комментарий к лавке за этот день'}
                    aria-label={`Комментарий, ${shop.code}`}
                    className="showcase-note min-w-0 flex-1 basis-40 rounded-lg px-2 py-1.5 text-sm disabled:opacity-50 sm:max-w-xs"
                  />

                  <div className="flex items-center gap-1.5">
                    <input
                      ref={(el) => {
                        if (el) inputs.current.set(shop.code, el);
                        else inputs.current.delete(shop.code);
                      }}
                      value={value}
                      onChange={(e) => change(shop.code, e.target.value)}
                      onKeyDown={(e) => {
                        if (e.key === 'Enter' || e.key === 'ArrowDown') {
                          e.preventDefault();
                          focusNext(i);
                        }
                        if (e.key === 'ArrowUp') {
                          e.preventDefault();
                          const prev = visible[i - 1];
                          if (prev) inputs.current.get(prev.code)?.focus();
                        }
                      }}
                      onFocus={(e) => e.target.select()}
                      disabled={readOnly}
                      inputMode="decimal"
                      placeholder="—"
                      aria-label={`Наполнение витрины, ${shop.code}`}
                      className="w-20 rounded-lg border px-2 py-1.5 text-right text-sm tabular-nums disabled:opacity-50"
                      style={{
                        borderColor: 'var(--border)',
                        background: 'var(--surface)',
                        color: 'var(--text)',
                      }}
                    />
                    <span className="w-4 text-xs muted">%</span>
                    <span
                      className={`st-${statusOf(shop, value, data.thresholds)} w-16 shrink-0 rounded px-2 py-1 text-center text-xs font-medium`}
                    >
                      {label(statusOf(shop, value, data.thresholds))}
                    </span>
                  </div>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs muted">
        Значение вводится в процентах. Enter или ↓ — следующая лавка, ↑ — предыдущая. Пустое поле
        означает «в этот день не заполняли»: такая лавка в средние значения не входит. Комментарий
        рядом — свободный текст на случай «не привезли ягоды»; на цифры он не влияет. Сохраняется
        само.
      </p>
    </div>
  );
}

function noteOf(shop: ShopRow, drafts: Record<string, string>): string {
  const draft = drafts[shop.code];
  return draft !== undefined ? draft : shop.note;
}

function percentOf(shop: ShopRow, drafts: Record<string, string>): string {
  const draft = drafts[shop.code];
  if (draft !== undefined) return draft;
  return shop.percent == null ? '' : String(shop.percent);
}

/** Пока правка летит на сервер, статус считаем на месте — по тем же порогам. */
function statusOf(
  shop: ShopRow,
  value: string,
  thresholds: { green: number; yellow: number },
): Status {
  if (value === '') return 'no_data';
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 'no_data';

  const share = percent / 100;
  if (share >= thresholds.green) return 'green';
  if (share >= thresholds.yellow) return 'yellow';
  return 'red';
}

function label(status: Status): string {
  if (status === 'green') return '🟢 ок';
  if (status === 'yellow') return '🟡 ниже';
  if (status === 'red') return '🔴 мало';
  return '—';
}

function shift(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}

/** «пн, 31 августа» — чтобы не гадать, какой это день недели. */
function humanDate(date: string): string {
  try {
    return new Date(`${date}T00:00:00`).toLocaleDateString('ru-RU', {
      weekday: 'short',
      day: 'numeric',
      month: 'long',
    });
  } catch {
    return date;
  }
}

function when(iso: string): string {
  try {
    return new Date(iso).toLocaleString('ru-RU', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return iso;
  }
}

function StepButton({
  label,
  title,
  onClick,
}: {
  label: string;
  title: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      className="rounded-lg border px-3 py-2 text-sm"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {label}
    </button>
  );
}
