'use client';

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { periodPresets, shiftDays } from '@/lib/periods';
import { dateRange, formatDay, isoDate, shortDate } from '@/lib/time';

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
 *
 * С клавиатуры календарь работает так же, как системный: стрелки ходят по
 * дням, PageUp/PageDown листают месяцы, Home и End прыгают на края недели,
 * Enter выбирает, Escape закрывает. До этого мышь была единственным способом
 * задать период — самый частый фильтр радара с клавиатуры был недоступен.
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
  /**
   * День под фокусом клавиатуры. В таблице дней в табуляцию попадает ровно
   * один день (приём известен как roving tabindex): иначе Tab пришлось бы
   * нажать тридцать раз, чтобы выйти из календаря.
   */
  const [cursor, setCursor] = useState<string>(to);
  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const gridRef = useRef<HTMLDivElement>(null);
  /** Фокус переносим на день только после того, как его подвинули с клавиатуры. */
  const moveFocus = useRef(false);

  const withData = useMemo(() => new Set(availableDates), [availableDates]);

  /**
   * Размонтирование поповера откладывается на следующий тик.
   *
   * Если убрать его прямо в обработчике клика, браузер доставляет тот же click
   * кнопке-триггеру — ячейка, по которой кликнули, к этому моменту удалена
   * из DOM — и поповер открывается заново. Воспроизводилось и мышью, и тачем.
   */
  const close = useCallback((returnFocus = false) => {
    setAnchor(null);
    setHover(null);
    moveFocus.current = false;
    setTimeout(() => {
      setOpen(false);
      // Закрыли с клавиатуры — фокус обязан вернуться на кнопку, иначе он
      // улетает в начало страницы и человек теряет место.
      if (returnFocus) triggerRef.current?.focus();
    }, 0);
  }, []);

  // Закрытие по клику вне и по Escape.
  useEffect(() => {
    if (!open) return;

    const onPointerDown = (e: MouseEvent | TouchEvent): void => {
      if (!rootRef.current?.contains(e.target as Node)) close();
    };
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') {
        e.preventDefault();
        close(true);
      }
    };

    document.addEventListener('mousedown', onPointerDown);
    document.addEventListener('touchstart', onPointerDown);
    document.addEventListener('keydown', onKey);
    return () => {
      document.removeEventListener('mousedown', onPointerDown);
      document.removeEventListener('touchstart', onPointerDown);
      document.removeEventListener('keydown', onKey);
    };
  }, [open, close]);

  // Курсор клавиатуры уехал в другой месяц — показываем тот месяц.
  useEffect(() => {
    if (!open) return;
    if (cursor.slice(0, 7) !== isoDate(month).slice(0, 7)) setMonth(startOfMonth(cursor));
  }, [cursor, month, open]);

  // Переносим фокус на день, к которому пришли стрелками.
  useEffect(() => {
    if (!open || !moveFocus.current) return;
    const el = gridRef.current?.querySelector<HTMLButtonElement>(`[data-day="${cursor}"]`);
    el?.focus();
  }, [cursor, open, month]);

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

  /** Стрелки, Home/End и PageUp/PageDown внутри сетки дней. */
  function onGridKey(e: React.KeyboardEvent): void {
    const STEP: Record<string, number> = {
      ArrowLeft: -1,
      ArrowRight: 1,
      ArrowUp: -7,
      ArrowDown: 7,
    };

    if (e.key in STEP) {
      e.preventDefault();
      moveFocus.current = true;
      setCursor((c) => shiftDays(c, STEP[e.key]));
      return;
    }
    if (e.key === 'PageUp' || e.key === 'PageDown') {
      e.preventDefault();
      moveFocus.current = true;
      setCursor((c) => isoDate(addMonths(new Date(`${c}T00:00:00`), e.key === 'PageUp' ? -1 : 1)));
      return;
    }
    if (e.key === 'Home' || e.key === 'End') {
      e.preventDefault();
      moveFocus.current = true;
      // Понедельник или воскресенье той же недели.
      const d = new Date(`${cursor}T00:00:00`);
      const offset = (d.getDay() + 6) % 7;
      setCursor(shiftDays(cursor, e.key === 'Home' ? -offset : 6 - offset));
    }
  }

  // Пока диапазон не закрыт, подсвечиваем то, что получится при наведении.
  const aim = hover ?? (moveFocus.current ? cursor : null);
  const previewFrom = anchor && aim ? (anchor <= aim ? anchor : aim) : from;
  const previewTo = anchor && aim ? (anchor <= aim ? aim : anchor) : to;

  const label =
    from === to ? formatLong(from) : `${shortDate(from)} — ${shortDate(to)}`;

  const presets = useMemo(() => periodPresets(availableDates), [availableDates]);

  return (
    <div ref={rootRef} className="relative">
      <button
        ref={triggerRef}
        type="button"
        onClick={() => {
          setMonth(startOfMonth(to));
          setCursor(to);
          moveFocus.current = false;
          setOpen((v) => !v);
        }}
        aria-expanded={open}
        aria-haspopup="dialog"
        className="date-trigger flex w-full items-center justify-between gap-2 rounded-lg border px-2.5 py-[0.55rem] text-left text-sm"
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
          aria-modal="false"
          aria-label="Выбор периода"
          className="surface absolute left-0 z-40 mt-1 w-[19rem] max-w-[calc(100vw-2rem)] p-3 shadow-lg"
        >
          <div className="mb-2 flex items-center justify-between gap-2">
            <MonthButton
              label="‹"
              title="Предыдущий месяц"
              onClick={() => setMonth(addMonths(month, -1))}
            />
            <span className="text-sm font-medium" aria-live="polite">
              {MONTHS[month.getMonth()]} {month.getFullYear()}
            </span>
            <MonthButton
              label="›"
              title="Следующий месяц"
              onClick={() => setMonth(addMonths(month, 1))}
            />
          </div>

          <div className="grid grid-cols-7 gap-0.5 text-center text-[10px] muted">
            {WEEKDAYS.map((d) => (
              <span key={d} className="py-1">
                {d}
              </span>
            ))}
          </div>

          <div ref={gridRef} className="grid grid-cols-7 gap-0.5" onKeyDown={onGridKey}>
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
                  /* В табуляцию попадает один день — тот, на котором курсор. */
                  focusable={cell === cursor}
                  onPick={(d) => {
                    setCursor(d);
                    pick(d);
                  }}
                  onHover={setHover}
                />
              ),
            )}
          </div>

          <div className="mt-2 flex items-center justify-between gap-2">
            <p className="text-[11px] muted">
              {anchor
                ? 'Выбран один день. Кликните вторую дату для периода.'
                : 'Клик — один день, два клика — период. Стрелки — по дням.'}
            </p>
            {/* На телефоне «клик вне» неочевиден — даём явное завершение выбора. */}
            <button
              type="button"
              onClick={() => close(true)}
              className="shrink-0 rounded-md border px-2.5 py-1.5 text-xs"
              style={{ borderColor: 'var(--border)' }}
            >
              Готово
            </button>
          </div>

          {presets.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5 border-t pt-2" style={{ borderColor: 'var(--border)' }}>
              {presets.map((p) => (
                <button
                  key={p.key}
                  type="button"
                  onClick={() => {
                    close();
                    onChange(p.from, p.to);
                  }}
                  className="rounded-md border px-2.5 py-1.5 text-xs muted hover:opacity-70"
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

/** Стрелка листания месяца: 36 пикселей вместо прежних 26 — попасть пальцем. */
function MonthButton({
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
      aria-label={title}
      title={title}
      className="flex size-9 items-center justify-center rounded text-sm muted hover:opacity-70"
    >
      {label}
    </button>
  );
}

function DayCell({
  date,
  inMonth,
  selected,
  edge,
  hasData,
  focusable,
  onPick,
  onHover,
}: {
  date: string;
  inMonth: boolean;
  selected: boolean;
  edge: boolean;
  hasData: boolean;
  focusable: boolean;
  onPick: (d: string) => void;
  onHover: (d: string | null) => void;
}) {
  const day = Number(date.slice(8, 10));

  return (
    <button
      type="button"
      data-day={date}
      tabIndex={focusable ? 0 : -1}
      onClick={(e) => {
        // Без этого клик доходит до кнопки-триггера и открывает поповер заново
        // сразу после того, как выбор диапазона его закрыл.
        e.stopPropagation();
        onPick(date);
      }}
      onMouseEnter={() => onHover(date)}
      onMouseLeave={() => onHover(null)}
      aria-label={formatLong(date) + (hasData ? ', есть данные' : '')}
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
  return formatDay(iso, { day: 'numeric', month: 'long', year: 'numeric' });
}
