'use client';

import type { KeyboardEvent } from 'react';
import { averagePercent } from '@/lib/day-fill';
import { plural } from '@/lib/plural';
import { formatDay, formatMoment } from '@/lib/time';
import type { Status } from '@/lib/types';
import type { EditField, SaveState } from './use-showcase-edits';

/**
 * Мелочь, общая для обоих редакторов витрин — дневного и полавочного.
 *
 * Оба показывают одни и те же данные с разных сторон, и выглядеть одинаково
 * они должны буквально: разъехавшиеся статусы или две разные надписи
 * «Сохранено» читались бы как два разных механизма записи, хотя он один.
 */

/** Поля ввода везде на вкладке одинаковые — тема задаётся переменными CSS. */
export const FIELD_STYLE = {
  borderColor: 'var(--border)',
  background: 'var(--surface)',
  color: 'var(--text)',
} as const;

/** Пока правка летит на сервер, статус считаем на месте — по тем же порогам. */
export function statusOf(
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

/**
 * Замеры наполнения за день. Утренний был всегда, второй — в 16:00: витрину,
 * полную с утра и пустую после обеда, одним замером не поймать.
 */
export const FILL_SLOTS = [
  { field: 'percent', label: 'утро', title: 'Утренний замер' },
  { field: 'afternoonPercent', label: '16:00', title: 'Замер в 16:00' },
] as const satisfies readonly { field: EditField; label: string; title: string }[];

export type FillField = (typeof FILL_SLOTS)[number]['field'];

/**
 * Статус итога дня, пока правка летит на сервер: среднее набранных замеров.
 * Та же формула, что у сервера (averagePercent — общая, см. dayFill), иначе
 * статус в строке менялся бы в момент сохранения. Пустой замер в среднее не
 * входит: набран один — статус по нему.
 */
export function dayStatusOf(
  values: readonly string[],
  thresholds: { green: number; yellow: number },
): Status {
  const numbers = values
    .filter((v) => v !== '')
    // Запятая — как на сервере: «95,5» там принимается, значит и здесь число.
    .map((v) => Number(v.replace(',', '.')))
    .filter(Number.isFinite);
  if (numbers.length === 0) return 'no_data';
  const day = numbers.length === 1 ? numbers[0] : averagePercent(numbers[0], numbers[1]);
  return statusOf(String(day), thresholds);
}

/**
 * Оба замера и статус итога — одна группа полей, общая для дневного и
 * полавочного редакторов. Навигация стрелками у редакторов своя (по лавкам
 * или по дням), поэтому клавиши и ссылки на поля отдаются наружу.
 */
export function FillInputs({
  values,
  thresholds,
  disabled,
  ariaSuffix,
  onChange,
  onKeyDown,
  register,
}: {
  values: Record<FillField, string>;
  thresholds: { green: number; yellow: number };
  disabled: boolean;
  /** «М12» или «М12, 2026-09-21» — чтобы программа чтения с экрана различала поля. */
  ariaSuffix: string;
  onChange: (field: FillField, raw: string) => void;
  onKeyDown: (field: FillField, e: KeyboardEvent<HTMLInputElement>) => void;
  register: (field: FillField, el: HTMLInputElement | null) => void;
}) {
  const status = dayStatusOf(
    FILL_SLOTS.map((slot) => values[slot.field]),
    thresholds,
  );
  return (
    <div className="order-2 flex items-center gap-1.5">
      {FILL_SLOTS.map((slot) => (
        <label key={slot.field} className="flex items-center gap-1" title={slot.title}>
          <span className="text-xs muted tabular-nums">{slot.label}</span>
          <input
            ref={(el) => register(slot.field, el)}
            value={values[slot.field]}
            onChange={(e) => onChange(slot.field, e.target.value)}
            onKeyDown={(e) => onKeyDown(slot.field, e)}
            onFocus={(e) => e.target.select()}
            disabled={disabled}
            inputMode="decimal"
            placeholder="—"
            aria-label={`${slot.title}, ${ariaSuffix}`}
            className="w-14 rounded-lg border px-2 py-1.5 text-right text-sm tabular-nums disabled:opacity-50"
            style={FIELD_STYLE}
          />
        </label>
      ))}
      <span className="w-4 text-xs muted">%</span>
      <span
        className={`st-${status} w-18 shrink-0 whitespace-nowrap rounded px-2 py-1 text-center text-xs font-medium`}
        title="Итог дня — среднее двух замеров"
      >
        {statusLabel(status)}
      </span>
    </div>
  );
}

/**
 * Фильтр «только незаполненные»: по какому замеру. Утром всё, что в 16:00, ещё
 * пусто, и общий фильтр «хоть один замер пуст» показывал бы весь список.
 */
export function EmptyFilter({
  value,
  onChange,
  noun,
}: {
  value: FillField | '';
  onChange: (value: FillField | '') => void;
  /** «лавка» или «день» — для подсказки. */
  noun: string;
}) {
  return (
    <label
      className="flex items-center gap-2 text-sm"
      title={`Список фиксируется на момент выбора: заполненный ${noun} остаётся на месте, пока его не спрятать вручную`}
    >
      <span>только незаполненные:</span>
      {/* Ширина — на обёртке: select растягивается на всю ширину родителя. */}
      <span className="w-24">
        <select
          value={value}
          onChange={(e) => onChange(e.target.value as FillField | '')}
          aria-label="Только незаполненные"
        >
          <option value="">нет</option>
          {FILL_SLOTS.map((slot) => (
            <option key={slot.field} value={slot.field}>
              {slot.label}
            </option>
          ))}
        </select>
      </span>
    </label>
  );
}

export function statusLabel(status: Status): string {
  if (status === 'green') return '🟢 ок';
  if (status === 'yellow') return '🟡 ниже';
  if (status === 'red') return '🔴 мало';
  return '—';
}

/** «пн, 31 августа» — чтобы не гадать, какой это день недели. */
export function humanDate(date: string): string {
  return formatDay(date, { weekday: 'short', day: 'numeric', month: 'long' });
}

/** Когда правку сохранили — по Москве, как и всё время на дашборде. */
export function when(iso: string): string {
  return `${formatMoment(iso)} МСК`;
}

export function StepButton({
  label,
  title,
  onClick,
  disabled = false,
}: {
  label: string;
  title: string;
  onClick: () => void;
  disabled?: boolean;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={title}
      disabled={disabled}
      /* 44 пикселя: стрелками «вчера/завтра» пользуются с телефона чаще
         всего, а прежние 36 в высоту заставляли целиться. */
      className="flex size-11 items-center justify-center rounded-lg border text-sm disabled:opacity-40"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {label}
    </button>
  );
}

/**
 * Состояние сохранения читает и программа чтения с экрана: aria-live
 * проговаривает изменения, не уводя фокус из поля ввода. Раньше это был
 * немой серый текст, который к тому же не гас.
 */
export function SaveBadge({
  save,
  queued,
  updatedAt,
}: {
  save: SaveState;
  queued: number;
  updatedAt?: string | null;
}) {
  return (
    <span className="text-xs" aria-live="polite">
      {save === 'saving' && <span className="muted">Сохраняю…</span>}
      {save === 'saved' && <span className="ink-green">✅ Сохранено</span>}
      {save === 'error' && (
        <span className="ink-red">
          ⚠ Не сохранено
          {queued > 0 && `: ${queued} ${plural(queued, 'правка', 'правки', 'правок')} в очереди`}
        </span>
      )}
      {save === 'idle' && queued > 0 && <span className="muted">Правки в очереди: {queued}</span>}
      {save === 'idle' && queued === 0 && updatedAt && (
        <span className="muted">Последняя правка: {when(updatedAt)}</span>
      )}
    </span>
  );
}

/** Отмена последнего изменения: без неё стёртый процент восстановить нечем. */
export function UndoButton({ count, label, onClick }: { count: number; label: string; onClick: () => void }) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={`Отменить: ${label} (Ctrl+Z)`}
      className="rounded-lg border px-2.5 py-1.5 text-xs"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      ↩ Отменить ({count})
    </button>
  );
}

export function TokenInput({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <input
      type="password"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder="код доступа"
      className="ml-auto w-40 rounded-lg border px-3 py-2 text-sm"
      style={FIELD_STYLE}
    />
  );
}
