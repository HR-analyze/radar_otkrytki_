'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { plural } from '@/lib/plural';
import {
  defaultShowcaseRange,
  lastDaysRange,
  monthRange,
  shiftShowcaseRange,
  type ShowcaseRange,
} from '@/lib/showcase-range';
import { todayIso } from '@/lib/time';
import type { Status } from '@/lib/types';
import { ClearButton } from './ClearButton';
import {
  EmptyFilter,
  FILL_SLOTS,
  FIELD_STYLE,
  FillInputs,
  SaveBadge,
  StepButton,
  TokenInput,
  UndoButton,
  humanDate,
  type FillField,
} from './showcase-ui';
import { useShowcaseEdits, type SavedRow } from './use-showcase-edits';

/**
 * Второй способ заполнения: **выбрана лавка — в списке дни.**
 *
 * Дневной редактор (ShowcaseDayEditor) хорош, пока заполняют за сегодня. Но
 * половина работы — это дозаполнить задним числом: лавка неделю не попадала в
 * отчёт, РМ прислал цифры за пять дней сразу, после отпуска накопился хвост.
 * В дневном режиме каждая такая цифра стоит переключения даты, ожидания
 * загрузки восьмидесяти лавок и поиска своей строки глазами — пять цифр
 * превращаются в пять кругов по экрану.
 *
 * Здесь разрез повёрнут: лавка выбирается один раз, дни идут списком сверху
 * вниз, и пять цифр вводятся подряд, как в столбик Excel. Enter — следующий
 * день, «→» рядом с лавкой — следующая лавка того же РМ.
 *
 * Данные те же самые: обе вкладки правят одну таблицу «дата + лавка» и шлют
 * одинаковые правки в /api/showcase. Переключение режима ничего не теряет —
 * очередь дописывается перед сменой (см. useShowcaseEdits).
 */

interface DayRow {
  date: string;
  /** Утренний замер. */
  percent: number | null;
  /** Замер в 16:00. */
  afternoonPercent: number | null;
  /** Статус итога дня — среднего двух замеров. */
  status: Status;
  note: string;
  updatedAt: string | null;
}

interface ShopOption {
  code: string;
  name: string;
  region: string | null;
}

interface ShopData {
  ok: boolean;
  mode: 'shop';
  from: string;
  to: string;
  editable: boolean;
  hint: string;
  tokenRequired: boolean;
  thresholds: { green: number; yellow: number };
  shop: {
    code: string;
    name: string;
    region: string | null;
    opensAt: string | null;
    /** День, с которого лавка закрыта: дальше этой даты строк не будет. */
    closedFrom: string | null;
  };
  shops: ShopOption[];
  days: DayRow[];
  error?: string;
}

/** Быстрые периоды: то, за что дозаполняют чаще всего. */
const PRESETS: { key: string; label: string; range: () => ShowcaseRange }[] = [
  { key: '7d', label: '7 дней', range: () => lastDaysRange(7) },
  { key: '14d', label: '14 дней', range: () => lastDaysRange(14) },
  { key: 'month', label: 'этот месяц', range: () => monthRange(todayIso().slice(0, 7)) },
  {
    key: 'prev',
    label: 'прошлый месяц',
    range: () => {
      const [y, m] = todayIso().split('-').map(Number);
      const prev = new Date(y, m - 2, 1);
      return monthRange(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
    },
  },
];

export function ShowcaseShopEditor({
  shopCode,
  onShopCode,
  region,
  onRegion,
}: {
  /** Пусто — какую лавку открыть, решает сервер: первую в справочнике. */
  shopCode: string;
  onShopCode: (code: string) => void;
  region: string;
  onRegion: (region: string) => void;
}) {
  const [range, setRange] = useState<ShowcaseRange>(() => defaultShowcaseRange());
  const [data, setData] = useState<ShopData | null>(null);
  /** По какому замеру показывать только незаполненные; пусто — показывать всё. */
  const [onlyEmpty, setOnlyEmpty] = useState<FillField | ''>('');
  // Тот же замок, что и в дневном режиме: строка не должна выпрыгивать
  // из-под курсора на первой же цифре (см. ShowcaseDayEditor).
  const [emptyLock, setEmptyLock] = useState<Set<string>>(new Set());
  const onlyEmptyRef = useRef(onlyEmpty);
  useEffect(() => {
    onlyEmptyRef.current = onlyEmpty;
  }, [onlyEmpty]);
  /** Поля ввода по ключу «дата|замер»: Enter ведёт вниз по тому же замеру. */
  const inputs = useRef<Map<string, HTMLInputElement>>(new Map());

  const applySaved = useCallback((rows: SavedRow[]) => {
    setData((prev) =>
      prev
        ? {
            ...prev,
            days: prev.days.map((d) => {
              const saved = rows.find((x) => x.date === d.date && x.shopCode === prev.shop.code);
              return saved
                ? {
                    ...d,
                    percent: saved.percent,
                    afternoonPercent: saved.afternoonPercent,
                    status: saved.status,
                    note: saved.note,
                  }
                : d;
            }),
          }
        : prev,
    );
  }, []);

  const edits = useShowcaseEdits(applySaved);
  const { reset, setError } = edits;

  const load = useCallback(
    async (shop: string, from: string, to: string) => {
      // Пустой код — «открой первую лавку справочника»: редактор должен
      // показать хоть что-то, а не пустой экран с просьбой выбрать.
      const query = new URLSearchParams({ shop: shop || '*', from, to });
      const res = await fetch(`/api/showcase?${query}`);
      const body = (await res.json()) as ShopData;
      setData(body);
      // Фильтр читаем через ref: перезагружать лавку из-за его смены незачем.
      const field = onlyEmptyRef.current;
      setEmptyLock(new Set((body.days ?? []).filter((d) => field && d[field] == null).map((d) => d.date)));
      if (!body.ok) {
        setError(body.error ?? 'Не удалось загрузить лавку');
        return;
      }
      // Сервер мог подправить и лавку (пустой код), и границы окна
      // (слишком длинное, залезающее в будущее) — подхватываем его ответ.
      if (body.shop.code !== shop) onShopCode(body.shop.code);
      if (body.from !== from || body.to !== to) setRange({ from: body.from, to: body.to });
    },
    [onShopCode, setError],
  );

  useEffect(() => {
    reset();
    void load(shopCode, range.from, range.to);
  }, [shopCode, range.from, range.to, load, reset]);

  const code = data?.shop.code ?? shopCode;
  const days = data?.days ?? [];
  const thresholds = data?.thresholds ?? { green: 1, yellow: 1 };
  const readOnly = data ? !data.editable : false;
  const today = todayIso();

  const percentOf = useCallback(
    (day: DayRow, field: FillField): string =>
      edits.draft(day.date, code, field) ?? (day[field] == null ? '' : String(day[field])),
    [edits, code],
  );
  const noteOf = useCallback(
    (day: DayRow): string => edits.draft(day.date, code, 'note') ?? day.note,
    [edits, code],
  );

  const shops = data?.shops ?? [];
  const regions = useMemo(
    () => [...new Set(shops.map((s) => s.region).filter(Boolean))].sort() as string[],
    [shops],
  );
  /** Лавки, по которым ходят стрелки «←/→»: выбранный РМ сужает обход. */
  const walk = useMemo(
    () => shops.filter((s) => !region || s.region === region),
    [shops, region],
  );

  const step = (by: number) => {
    if (walk.length === 0) return;
    const at = walk.findIndex((s) => s.code === code);
    // Не нашли (лавка чужого РМ) — начинаем обход сначала, а не бросаем.
    const next = walk[(Math.max(at, 0) + by + walk.length) % walk.length];
    if (next) onShopCode(next.code);
  };

  const visible = useMemo(
    () => days.filter((d) => !onlyEmpty || emptyLock.has(d.date) || percentOf(d, onlyEmpty) === ''),
    [days, onlyEmpty, emptyLock, percentOf],
  );

  const filled = (field: FillField) => days.filter((d) => percentOf(d, field) !== '').length;
  const doneInView = onlyEmpty ? visible.filter((d) => percentOf(d, onlyEmpty) !== '').length : 0;
  const relock = (field: FillField | '' = onlyEmpty) =>
    setEmptyLock(new Set(field ? days.filter((d) => percentOf(d, field) === '').map((d) => d.date) : []));

  function focusAt(index: number, field: FillField) {
    const day = visible[index];
    if (day) inputs.current.get(`${day.date}|${field}`)?.focus();
  }

  const activePreset = PRESETS.find((p) => {
    const r = p.range();
    return r.from === range.from && r.to === range.to;
  })?.key;

  return (
    <div className="flex flex-col gap-4">
      {/* --- Лавка --- */}
      <div className="surface flex flex-wrap items-center gap-3 p-3">
        <div className="flex items-center gap-1">
          <StepButton
            label="←"
            title="Предыдущая лавка"
            onClick={() => step(-1)}
            disabled={walk.length < 2}
          />
          <select
            value={code}
            onChange={(e) => onShopCode(e.target.value)}
            aria-label="Лавка"
            className="w-44"
          >
            {/* Здесь, в отличие от дневного списка, лавка не фильтр, а предмет
                работы: показываем код с названием, чтобы не гадать, та ли. */}
            {(walk.some((s) => s.code === code) ? walk : shops).map((s) => (
              <option key={s.code} value={s.code}>
                {s.code} {s.name.replace(/^[А-ЯA-Z]+\d+\s*/i, '')}
              </option>
            ))}
          </select>
          <StepButton
            label="→"
            title="Следующая лавка"
            onClick={() => step(1)}
            disabled={walk.length < 2}
          />
        </div>

        <div className={`relative w-56 ${region ? 'has-clear' : ''}`}>
          <select
            value={region}
            onChange={(e) => onRegion(e.target.value)}
            aria-label="Региональный менеджер"
          >
            <option value="">Все РМ</option>
            {regions.map((r) => (
              <option key={r} value={r}>
                {r}
              </option>
            ))}
          </select>
          {region && <ClearButton onClick={() => onRegion('')} label="Сбросить фильтр по РМ" />}
        </div>

        {data?.shop.opensAt && (
          <span
            className="st-yellow rounded px-1.5 py-0.5 text-xs font-medium tabular-nums"
            title={`Лавка открывается с ${data.shop.opensAt}, а не с общих 08:00`}
          >
            🕙 с {data.shop.opensAt}
          </span>
        )}

        <span className="text-sm">
          Заполнено{' '}
          {FILL_SLOTS.map((slot, i) => (
            <span key={slot.field}>
              {i > 0 && ' · '}
              {slot.label} <b className="tabular-nums">{filled(slot.field)}</b>
            </span>
          ))}{' '}
          из {days.length} {plural(days.length, 'дня', 'дней', 'дней')}
        </span>

        <SaveBadge save={edits.save} queued={edits.queued} />

        {edits.undo.length > 0 && !readOnly && (
          <UndoButton
            count={edits.undo.length}
            label={edits.undo[edits.undo.length - 1].label}
            onClick={edits.undoLast}
          />
        )}

        {data?.tokenRequired && <TokenInput value={edits.token} onChange={edits.setToken} />}
      </div>

      {/* --- Период --- */}
      <div className="flex flex-wrap items-center gap-2">
        <StepButton
          label="←"
          title="Предыдущие столько же дней"
          onClick={() => setRange((r) => shiftShowcaseRange(r, -1))}
        />
        <input
          type="date"
          value={range.from}
          max={range.to}
          onChange={(e) => e.target.value && setRange((r) => ({ ...r, from: e.target.value }))}
          aria-label="Первый день периода"
          className="rounded-lg border px-3 py-2 text-sm"
          style={FIELD_STYLE}
        />
        <span className="text-sm muted">—</span>
        <input
          type="date"
          value={range.to}
          max={today}
          onChange={(e) => e.target.value && setRange((r) => ({ ...r, to: e.target.value }))}
          aria-label="Последний день периода"
          className="rounded-lg border px-3 py-2 text-sm"
          style={FIELD_STYLE}
        />
        <StepButton
          label="→"
          title="Следующие столько же дней"
          onClick={() => setRange((r) => shiftShowcaseRange(r, 1))}
          disabled={range.to >= today}
        />

        {PRESETS.map((p) => (
          <button
            key={p.key}
            type="button"
            onClick={() => setRange(p.range())}
            aria-pressed={activePreset === p.key}
            className="rounded-lg border px-3 py-2 text-sm"
            style={{
              borderColor: activePreset === p.key ? 'var(--text)' : 'var(--border)',
              background: 'var(--surface)',
              color: 'var(--text)',
            }}
          >
            {p.label}
          </button>
        ))}

        <EmptyFilter
          value={onlyEmpty}
          noun="день"
          onChange={(next) => {
            setOnlyEmpty(next);
            relock(next);
          }}
        />
        {onlyEmpty && doneInView > 0 && (
          <button
            type="button"
            onClick={() => relock()}
            className="rounded-lg border px-3 py-2 text-sm"
            style={FIELD_STYLE}
          >
            Спрятать заполненные ({doneInView})
          </button>
        )}
      </div>

      {readOnly && (
        <p className="surface p-3 text-sm" style={{ borderColor: 'var(--yellow)' }}>
          {data?.hint}
        </p>
      )}
      {edits.error && (
        <p className="surface p-3 text-sm ink-red" style={{ borderColor: 'var(--red)' }}>
          {edits.error}
        </p>
      )}
      {data?.shop.closedFrom && (
        <p className="surface p-3 text-sm" style={{ borderColor: 'var(--yellow)' }}>
          Лавка закрыта с {humanDate(data.shop.closedFrom)} — дни после закрытия в списке не
          показываются, прошлые остаются как были.
        </p>
      )}

      {/* --- Дни выбранной лавки --- */}
      <div className="surface overflow-hidden">
        {data == null ? (
          <p className="p-6 text-sm muted">Загружаю лавку…</p>
        ) : visible.length === 0 ? (
          <p className="p-6 text-sm muted">
            {days.length === 0
              ? 'В этом периоде у лавки нет ни одного рабочего дня.'
              : 'Все дни периода заполнены.'}
          </p>
        ) : (
          <ul>
            {visible.map((day, i) => {
              return (
                <li
                  key={day.date}
                  className="flex flex-wrap items-center gap-x-3 gap-y-1.5 border-t px-3 py-2 first:border-0"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {/* Дата — то же место, что код лавки в дневном списке: слева,
                      фиксированной ширины, чтобы столбик не «дышал». Ширина с
                      запасом под «вс, 20 сентября» и пометку «сегодня». */}
                  <span className="w-48 shrink-0 text-sm font-medium">
                    {humanDate(day.date)}
                    {day.date === today && <span className="ml-2 text-xs muted">сегодня</span>}
                  </span>

                  {/* Порядок Tab тот же, что в дневном режиме: утро → 16:00 →
                      комментарий того же дня → утро следующего. */}
                  <FillInputs
                    values={{
                      percent: percentOf(day, 'percent'),
                      afternoonPercent: percentOf(day, 'afternoonPercent'),
                    }}
                    thresholds={thresholds}
                    disabled={readOnly}
                    ariaSuffix={`${code}, ${day.date}`}
                    register={(field, el) => {
                      const key = `${day.date}|${field}`;
                      if (el) inputs.current.set(key, el);
                      else inputs.current.delete(key);
                    }}
                    onChange={(field, raw) =>
                      edits.edit(
                        day.date,
                        code,
                        field,
                        raw,
                        percentOf(day, field),
                        `${day.date}: наполнение, ${FILL_SLOTS.find((x) => x.field === field)!.label}`,
                      )
                    }
                    onKeyDown={(field, e) => {
                      if (e.key === 'Enter' || e.key === 'ArrowDown') {
                        e.preventDefault();
                        focusAt(i + 1, field);
                      }
                      if (e.key === 'ArrowUp') {
                        e.preventDefault();
                        focusAt(i - 1, field);
                      }
                    }}
                  />

                  <input
                    value={noteOf(day)}
                    onChange={(e) =>
                      edits.edit(
                        day.date,
                        code,
                        'note',
                        e.target.value,
                        noteOf(day),
                        `${day.date}: комментарий`,
                      )
                    }
                    onKeyDown={(e) => {
                      if (e.key === 'Enter') {
                        e.preventDefault();
                        focusAt(i + 1, 'percent');
                      }
                    }}
                    disabled={readOnly}
                    placeholder="комментарий"
                    title={noteOf(day) || 'Комментарий к лавке за этот день'}
                    aria-label={`Комментарий, ${code}, ${day.date}`}
                    className="showcase-note order-1 min-w-0 flex-1 basis-40 rounded-lg px-2 py-1.5 text-sm disabled:opacity-50 sm:max-w-xs"
                  />
                </li>
              );
            })}
          </ul>
        )}
      </div>

      <p className="text-xs muted">
        Режим для дозаполнения задним числом: лавка выбирается один раз, дни идут сверху вниз,
        свежий — первым. Замеров два — утро и 16:00, статус — итог дня, среднее двух. Enter
        или ↓ — следующий день, ↑ — предыдущий (по тому же замеру), Tab — следующее поле того же
        дня. Стрелки слева от названия переводят на соседнюю лавку, не сбрасывая период; выбранный
        РМ сужает обход. Период меняется стрелками «←/→» на свою же длину или быстрыми кнопками;
        дальше сегодняшнего дня он не уходит — витрину за завтра заполнять нечем. Пустое поле
        означает «в этот день не заполняли», и это не то же самое, что 0%. Правки сохраняются
        сами и ложатся ровно в тот день, в строке которого набраны.
      </p>
    </div>
  );
}
