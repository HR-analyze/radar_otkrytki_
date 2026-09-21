'use client';

import { plural } from '@/lib/plural';
import { formatDay, formatMoment } from '@/lib/time';
import type { Status } from '@/lib/types';
import type { SaveState } from './use-showcase-edits';

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
