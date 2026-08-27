'use client';

import { useEffect, useMemo, useRef, useState } from 'react';
import { dateRange, isoDate, shortDate } from '@/lib/time';

const MONTHS = [
  'Январь', 'Февраль', 'Март', 'Апрель', 'Май', 'Июнь',
  'Июль', 'Август', 'Сентябрь', 'Октябрь', 'Ноябрь', 'Декабрь',
];
const WEEKDAYS = ['пн', 'вт', 'ср', 'чт', 'пт', 'сб', 'вс'];

/**
 * Календарь произвольного периода.
 *
 * Первый клик выбирает один день, второй — расширяет до диапазона,
 * следующий начинает выбор заново. Даты, по которым есть данные, подсвечены,
 * но выбрать можно любые: период не ограничен загруженной историей.
 */
export function DateRangePicker({
  from,
  to,
  availableDates,
  onChange,
}: {
  from: string;
  to: string;
  /** Даты с данными — подсвечиваются точкой. */
  availableDates: string[];
  onChange: (from: string, to: string) => void;
}) {
  const [open, setOpen] = useState(false);
  const [month, setMonth] = useState(() => startOfMonth(to));
  /** Первый клик незавершённого выбора: показываем предпросмотр диапазона. */
  const [anchor, setAnchor] = useState<string | null>(null);
  const [hover, setHover] = useState<string | null>(null);
  const rootRef = useRef<HTMLDivElement>(null);

  const withData = useMemo(() => new Set(availableDates), [availableDates]);

  // Закрытие по клику вне и по Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent | TouchEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') close();
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open]);

  /**
   * Размонтирование поповера откладывается на следующий тик.
   *
   * Если убрать его прямо в обработчике клика, браузер доставляет тот же click
   * кнопке-триггеру — ячейка, по которой кликнули, к этому моменту удалена
   * из DOM — и поповер открывается заново. Воспроизводилось и мышью, и тачем.
   */
  function close(): void {
    setAnchor(null);
    setHover(null);
    setTimeout(() => setOpen(false), 0);
  }

  function pick(date: string): void {
    if (!anchor) {
      // Первый клик — сразу применяем один день, чтобы не заставлять кликать дважды.
      setAnchor(date);
      onChange(date, date);
      return;
    }
    const [a, b] = anchor <= date ? [anchor, date] : [date, anchor];
    close();
    onChange(a, b);
  }

  // Пока диапазон не закрыт, подсвечиваем то, что получится при наведении.
  const previewFrom = anchor && hover ? (anchor <= hover ? anchor : hover) : from;
  const previewTo = anchor && hover ? (anchor <= hover ? hover : anchor) : to;

  const label =
    from === to ? formatLong(from) : `${shortDate(from)} — ${shortDate(to)}`;

  const presets = useMemo(() => {
    const last = availableDates[availableDates.length - 1];
    const first = availableDates[0];
    if (!last || !first) return [];
    return [
      { label: 'Последний день', from: last, to: last },
      { label: '7 дней', from: shiftDays(last, -6), to: last },
      { label: '30 дней', from: shiftDays(last, -29), to: last },
      { label: 'Все данные', from: first, to: last },
    ];
  }, [availableDates]);

  return (
    <div ref={rootRef} className="relative">
      <button
        type="button"
        onClick={() => {
          setMonth(startOfMonth(to));
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-[0.45rem] text-left text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
      >
        <span className="truncate">{label}</span>
        <span aria-hidden className="shrink-0 text-xs muted">
          📅
        </span>
      </button>

      {open && (
        <div
          role="dialog"
          aria-label="Выбор периода"
          className="surface absolute left-0 z-40 mt-1 w-[19rem] max-w-[calc(100vw-2rem)] p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, -1))}
              aria-label="Предыдущий месяц"
              className="rounded px-2 py-1 text-sm muted hover:opacity-70"
            >
              ‹
            </button>
            <span className="text-sm font-medium">
              {MONTHS[month.getMonth()]} {month.getFullYear()}
            </span>
            <button
              type="button"
              onClick={() => setMonth(addMonths(month, 1))}
              aria-label="Следующий месяц"
              className="rounded px-2 py-1 text-sm muted hover:opacity-70"
            >
              ›
            </button>
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] muted">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1">
                {d}
              </span>
            ))}
          </div>

          <div className="grid grid-cols-7 gap-0.5">
            {monthGrid(month).map((cell, i) =>
              cell === null ? (
                <span key={`empty-${i}`} />
              ) : (
                <DayCell
                  key={cell}
                  date={cell}
                  inMonth={cell.slice(0, 7) === isoDate(month).slice(0, 7)}
                  selected={cell >= previewFrom && cell <= previewTo}
                  edge={cell === previewFrom || cell === previewTo}
                  hasData={withData.has(cell)}
                  onPick={pick}
                  onHover={setHover}
                />
              ),
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] muted">
              {anchor
                ? 'Выбран один день. Кликните вторую дату для периода.'
                : 'Клик — один день, два клика — период.'}
            </p>
            {/* На телефоне «клик вне» неочевиден — даём явное завершение выбора. */}
            <button
              type="button"
              onClick={close}
              className="shrink-0 rounded-md border px-2 py-1 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              Готово
            </button>
          </div>

          {presets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
              {presets.map((p) => (
                <button
                  key={p.label}
                  type="button"
                  onClick={() => {
                    close();
                    onChange(p.from, p.to);
                  }}
                  className="rounded-md border px-2 py-1 text-xs muted hover:opacity-70"
                  style={{ borderColor: 'var(--border)' }}
                >
                  {p.label}
                </button>
              ))}
            </div>
          )}
        </div>
      )}
    </div>
  );
}

function DayCell({
  date,
  inMonth,
  selected,
  edge,
  hasData,
  onPick,
  onHover,
}: {
  date: string;
  inMonth: boolean;
  selected: boolean;
  edge: boolean;
  hasData: boolean;
  onPick: (d: string) => void;
  onHover: (d: string | null) => void;
}) {
  const day = Number(date.slice(8, 10));

  return (
    <button
      type="button"
      onClick={(e) => {
        // Без этого клик доходит до кнопки-триггера и открывает поповер заново
        // сразу после того, как выбор диапазона его закрыл.
        e.stopPropagation();
        onPick(date);
      }}
      onMouseEnter={() => onHover(date)}
      onMouseLeave={() => onHover(null)}
      aria-label={formatLong(date)}
      aria-pressed={selected}
      className="relative flex h-8 items-center justify-center rounded text-xs"
      style={{
        background: edge ? 'var(--text)' : selected ? 'var(--neutral-soft)' : 'transparent',
        color: edge ? 'var(--surface)' : inMonth ? 'var(--text)' : 'var(--muted)',
        opacity: inMonth ? 1 : 0.45,
        fontWeight: edge ? 600 : 400,
      }}
    >
      {day}
      {hasData && !edge && (
        <span
          aria-hidden
          className="absolute bottom-1 size-1 rounded-full"
          style={{ background: 'var(--muted)' }}
        />
      )}
    </button>
  );
}

/* ------------------------------- календарь -------------------------------- */

function startOfMonth(iso: string): Date {
  const d = new Date(`${iso}T00:00:00`);
  return new Date(d.getFullYear(), d.getMonth(), 1);
}

function addMonths(d: Date, n: number): Date {
  return new Date(d.getFullYear(), d.getMonth() + n, 1);
}

function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return isoDate(d);
}

/** Сетка месяца с добивкой до полных недель, неделя начинается с понедельника. */
function monthGrid(month: Date): (string | null)[] {
  const first = new Date(month.getFullYear(), month.getMonth(), 1);
  const last = new Date(month.getFullYear(), month.getMonth() + 1, 0);

  const lead = (first.getDay() + 6) % 7; // getDay(): 0 — воскресенье
  const gridStart = new Date(first);
  gridStart.setDate(first.getDate() - lead);

  const trail = (7 - ((last.getDay() + 6) % 7) - 1 + 7) % 7;
  const gridEnd = new Date(last);
  gridEnd.setDate(last.getDate() + trail);

  return dateRange(isoDate(gridStart), isoDate(gridEnd));
}

function formatLong(iso: string): string {
  return new Date(`${iso}T00:00:00`).toLocaleDateString('ru-RU', {
    day: 'numeric',
    month: 'long',
    year: 'numeric',
  });
}
