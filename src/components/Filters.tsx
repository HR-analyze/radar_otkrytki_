'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useRef, useState, useTransition } from 'react';
import { CRITERION_ORDER, type CriterionKey, type ThresholdConfig } from '@/lib/types';
import { DateRangePicker } from './DateRangePicker';

export interface FilterState {
  from: string;
  to: string;
  region?: string;
  criterion?: CriterionKey | 'all';
  status?: string;
  shop?: string;
}

export interface ShopOption {
  code: string;
  name: string;
}

/**
 * Фильтры выпадающими списками, а не чипами: РМ-ов десять, критериев шесть —
 * на телефоне чипы занимали пол-экрана и переносились на пять строк.
 * Нативный <select> на мобильных открывается системным пикером.
 * Период — календарь произвольного диапазона (см. DateRangePicker).
 */
export function Filters({
  base,
  state,
  regions,
  dates,
  config,
  shops,
  showCriterion = true,
  showStatus = true,
}: {
  base: string;
  state: FilterState;
  regions: string[];
  dates: string[];
  config: ThresholdConfig;
  /** Список лавок для подсказок. Не передан — поля «Лавка» не будет. */
  shops?: ShopOption[];
  showCriterion?: boolean;
  showStatus?: boolean;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  /**
   * Патч кладём поверх текущего URL, а не поверх пропа state: state приходит
   * с сервера и обновляется через рендер, поэтому два быстрых переключения
   * подряд затирали друг друга.
   */
  const apply = useCallback(
    (patch: Partial<FilterState>) => {
      const q = new URLSearchParams(searchParams.toString());

      for (const [key, value] of Object.entries(patch)) {
        setOrDelete(q, key, value === 'all' ? undefined : value);
      }

      const query = q.toString();
      startTransition(() =>
        router.push(query ? `${base}?${query}` : base, { scroll: false }),
      );
    },
    [base, router, searchParams],
  );

  return (
    <div
      className={`surface grid gap-3 p-3 sm:grid-cols-2 ${shops ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}
      style={{ cursor: pending ? 'progress' : undefined }}
    >
      <Field label="Период">
        <DateRangePicker
          from={state.from}
          to={state.to}
          availableDates={dates}
          onChange={(from, to) => apply({ from, to })}
        />
      </Field>

      <Field label="РМ">
        <select
          value={state.region ?? ''}
          onChange={(e) => apply({ region: e.target.value || undefined })}
        >
          <option value="">Все</option>
          {regions.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
        </select>
      </Field>

      {shops && (
        <Field label="Лавка">
          <ShopFilter
            value={state.shop ?? ''}
            shops={shops}
            onChange={(shop) => apply({ shop })}
          />
        </Field>
      )}

      {showCriterion && (
        <Field label="Критерий">
          <select
            value={state.criterion ?? 'all'}
            onChange={(e) => apply({ criterion: e.target.value as CriterionKey | 'all' })}
          >
            <option value="all">Общий результат</option>
            {CRITERION_ORDER.map((c) => (
              <option key={c} value={c}>
                {config.criteria[c]?.title ?? c}
              </option>
            ))}
          </select>
        </Field>
      )}

      {showStatus && (
        <Field label="Статус">
          <select
            value={state.status ?? 'all'}
            onChange={(e) => apply({ status: e.target.value })}
          >
            <option value="all">Любой</option>
            <option value="red">🔴 Только красные</option>
            <option value="yellow">🟡 Есть жёлтые</option>
            <option value="green">🟢 Есть зелёные</option>
          </select>
        </Field>
      )}
    </div>
  );
}

/**
 * Поиск лавки: поле ввода со списком подсказок, а не выпадающий список на
 * восемьдесят строк. Код набирается за два символа, название — за три, и
 * «М1» при этом означает ровно М1, а не М1 вместе с М10–М19 (см. matchesShop).
 *
 * URL меняется не на каждую букву: полсекунды тишины — тогда запрос.
 */
function ShopFilter({
  value,
  shops,
  onChange,
}: {
  value: string;
  shops: ShopOption[];
  onChange: (value: string | undefined) => void;
}) {
  const [draft, setDraft] = useState(value);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Значение могли поменять снаружи — например, кнопкой «назад» в браузере.
  useEffect(() => setDraft(value), [value]);

  function edit(next: string) {
    setDraft(next);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => onChange(next.trim() || undefined), 400);
  }

  return (
    <div className="relative">
      <input
        value={draft}
        onChange={(e) => edit(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'Enter') {
            if (timer.current) clearTimeout(timer.current);
            onChange(draft.trim() || undefined);
          }
          if (e.key === 'Escape') {
            setDraft('');
            onChange(undefined);
          }
        }}
        list="radar-shops"
        placeholder="Все"
        aria-label="Лавка: код или название"
        className="w-full rounded-lg border px-3 py-2 pr-8 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
      />
      {draft && (
        <button
          type="button"
          onClick={() => {
            setDraft('');
            onChange(undefined);
          }}
          title="Сбросить"
          aria-label="Сбросить фильтр по лавке"
          className="absolute top-1/2 right-2 -translate-y-1/2 text-sm muted"
        >
          ✕
        </button>
      )}
      <datalist id="radar-shops">
        {shops.map((s) => (
          <option key={s.code} value={s.code}>
            {s.name}
          </option>
        ))}
      </datalist>
    </div>
  );
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs muted">{label}</span>
      {children}
    </label>
  );
}

function setOrDelete(q: URLSearchParams, key: string, value: string | undefined): void {
  if (value) q.set(key, value);
  else q.delete(key);
}
