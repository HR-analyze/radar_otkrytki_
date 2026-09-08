'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import { CRITERION_ORDER, type CriterionKey, type ThresholdConfig } from '@/lib/types';
import { ClearButton } from './ClearButton';
import { DateRangePicker } from './DateRangePicker';
import { ShopSearch, type ShopOption } from './ShopFilter';
import { STATUS_FILTER_TITLE } from './Status';

export interface FilterState {
  from: string;
  to: string;
  region?: string;
  criterion?: CriterionKey | 'all';
  status?: string;
  shop?: string;
}

export interface RegionOptions {
  current: string[];
  /** Прежние РМ: остаются в списке ради истории — см. roster-history.ts. */
  past: string[];
}

export type { ShopOption };

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
  criterionDefault = 'all',
}: {
  base: string;
  state: FilterState;
  regions: RegionOptions;
  dates: string[];
  config: ThresholdConfig;
  /** Список лавок для подсказок. Не передан — поля «Лавка» не будет. */
  shops?: ShopOption[];
  showCriterion?: boolean;
  showStatus?: boolean;
  /**
   * Критерий, предвыбранный на странице (радар открывается на витрине).
   * Нужен здесь, чтобы знать, какое значение в URL не писать, — см. apply.
   */
  criterionDefault?: CriterionKey | 'all';
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
        /**
         * В URL держим только то, что отличается от значения по умолчанию —
         * иначе ссылка обрастает `criterion=all&status=all`.
         *
         * Исключение — критерий на странице с предвыбором: «Общий результат»
         * там приходится писать явно (`criterion=all`), иначе, сняв фильтр,
         * человек снова получал бы предвыбранную витрину.
         */
        const fallback = key === 'criterion' ? criterionDefault : 'all';
        setOrDelete(q, key, value === fallback ? undefined : value);
      }

      const query = q.toString();
      startTransition(() =>
        router.push(query ? `${base}?${query}` : base, { scroll: false }),
      );
    },
    [base, criterionDefault, router, searchParams],
  );

  return (
    <div
      className={`surface grid gap-3 p-3 sm:grid-cols-2 ${shops ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}
      style={{ cursor: pending ? 'progress' : undefined }}
    >
      {/* Период сбрасывается не в пустоту, а в значение по умолчанию (текущий
          месяц, см. defaultRange): период без границ бессмысленен. Крестик
          поэтому появляется только когда даты стоят в ссылке явно. */}
      <Field
        label="Период"
        onClear={
          searchParams.has('from') || searchParams.has('to')
            ? () => apply({ from: undefined, to: undefined })
            : undefined
        }
      >
        <DateRangePicker
          from={state.from}
          to={state.to}
          availableDates={dates}
          onChange={(from, to) => apply({ from, to })}
        />
      </Field>

      <Field
        label="РМ"
        onClear={state.region ? () => apply({ region: undefined }) : undefined}
      >
        <select
          value={state.region ?? ''}
          onChange={(e) => apply({ region: e.target.value || undefined })}
        >
          <option value="">Все</option>
          {regions.current.map((r) => (
            <option key={r} value={r}>
              {r}
            </option>
          ))}
          {/* Ушедшие остаются в списке за те месяцы, где они отвечали за лавки:
              иначе сравнить их показатели с показателями преемника нельзя. */}
          {regions.past.length > 0 && (
            <optgroup label="Уже не в справочнике">
              {regions.past.map((r) => (
                <option key={r} value={r}>
                  {r}
                </option>
              ))}
            </optgroup>
          )}
          {/* Выбранный РМ мог выпасть из списка при смене периода. Оставляем
              его видимым, иначе поле показывало бы чужое имя. */}
          {state.region &&
            !regions.current.includes(state.region) &&
            !regions.past.includes(state.region) && (
              <optgroup label="Вне выбранного периода">
                <option value={state.region}>{state.region}</option>
              </optgroup>
            )}
        </select>
      </Field>

      {shops && (
        <Field label="Лавка">
          <ShopSearch
            value={state.shop ?? ''}
            shops={shops}
            onChange={(shop) => apply({ shop })}
            listId="radar-shops"
          />
        </Field>
      )}

      {showCriterion && (
        <Field
          label="Критерий"
          /* Сброс возвращает предвыбор страницы, а не «Общий результат»:
             радар открывается на витрине, туда же и откатываемся. */
          onClear={
            (state.criterion ?? criterionDefault) !== criterionDefault
              ? () => apply({ criterion: criterionDefault })
              : undefined
          }
        >
          <select
            value={state.criterion ?? criterionDefault}
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
        <Field
          label="Статус"
          onClear={
            state.status && state.status !== 'all'
              ? () => apply({ status: 'all' })
              : undefined
          }
        >
          <select
            value={state.status ?? 'all'}
            onChange={(e) => apply({ status: e.target.value })}
          >
            <option value="all">Любой</option>
            <option value="red">{STATUS_FILTER_TITLE.red}</option>
            <option value="yellow">{STATUS_FILTER_TITLE.yellow}</option>
            <option value="green">{STATUS_FILTER_TITLE.green}</option>
          </select>
        </Field>
      )}
    </div>
  );
}

/**
 * Подпись + само поле. `onClear` не передан — крестика нет: значит фильтр
 * стоит в значении по умолчанию и сбрасывать нечего.
 *
 * Кнопка живёт внутри <label> намеренно: по спецификации клик по интерактивному
 * потомку не пробрасывается на связанный контрол, так что сброс не открывает
 * заодно и выпадающий список.
 */
function Field({
  label,
  children,
  onClear,
}: {
  label: string;
  children: React.ReactNode;
  onClear?: () => void;
}) {
  return (
    <label className="flex min-w-0 flex-col gap-1">
      <span className="text-xs muted">{label}</span>
      <div className={`relative ${onClear ? 'has-clear' : ''}`}>
        {children}
        {onClear && <ClearButton onClick={onClear} label={`Сбросить фильтр «${label}»`} />}
      </div>
    </label>
  );
}

function setOrDelete(q: URLSearchParams, key: string, value: string | undefined): void {
  if (value) q.set(key, value);
  else q.delete(key);
}
