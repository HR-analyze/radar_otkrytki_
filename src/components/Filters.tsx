'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useTransition } from 'react';
import {
  CRITERION_ORDER,
  DEFAULT_CRITERION,
  type CriterionKey,
  type ThresholdConfig,
} from '@/lib/types';
import { ClearButton } from './ClearButton';
import { DateRangePicker } from './DateRangePicker';
import { ShopSearch, type ShopOption } from './ShopFilter';
import { STATUS_FILTER_TITLE } from './Status';

export interface FilterState {
  from: string;
  to: string;
  region?: string;
  criterion?: CriterionKey;
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
  criterionDefault = DEFAULT_CRITERION,
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
   * Критерий, на котором открывается страница. Нужен здесь, чтобы знать,
   * какое значение в URL не писать, — см. apply.
   */
  criterionDefault?: CriterionKey;
}) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const [pending, startTransition] = useTransition();

  /**
   * Переход по фильтру заменяет запись в истории, а не добавляет новую.
   *
   * Иначе «назад» отматывал фильтры по одному — а из поиска по лавке, где
   * значение уходит по таймеру, в историю попадали ещё и промежуточные
   * «М», «М1». Кнопка «назад» должна уводить со страницы, а не разбирать
   * обратно то, что человек только что набрал.
   */
  const go = useCallback(
    (q: URLSearchParams) => {
      const query = q.toString();
      startTransition(() =>
        router.replace(query ? `${base}?${query}` : base, { scroll: false }),
      );
    },
    [base, router],
  );

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
         * иначе ссылка обрастает `criterion=showcase&status=all`.
         */
        const fallback = key === 'criterion' ? criterionDefault : 'all';
        setOrDelete(q, key, value === fallback ? undefined : value);
      }

      go(q);
    },
    [criterionDefault, go, searchParams],
  );

  /**
   * Что сейчас отличается от значений по умолчанию. Отсюда берутся и крестики
   * у полей, и счётчик в кнопке «Сбросить всё»: два независимых условия
   * однажды разъехались бы.
   */
  /** Критерий, который сейчас на экране: из URL либо предвыбор страницы. */
  const criterion: CriterionKey = state.criterion ?? criterionDefault;


  const active = {
    period: searchParams.has('from') || searchParams.has('to'),
    region: !!state.region,
    shop: !!state.shop,
    criterion: showCriterion && criterion !== criterionDefault,
    status: showStatus && !!state.status && state.status !== 'all',
  };
  const activeCount = Object.values(active).filter(Boolean).length;

  /**
   * Сброс всего разом: пять крестиков — это пять кликов и пять переходов.
   * Убираем только ключи фильтров, всё остальное в ссылке (например,
   * сортировка радара) — не фильтр, и переживать сброс должно.
   */
  const resetAll = useCallback(() => {
    const q = new URLSearchParams(searchParams.toString());
    for (const key of ['from', 'to', 'region', 'shop', 'criterion', 'status']) q.delete(key);
    go(q);
  }, [go, searchParams]);

  return (
    <div className="surface p-3" style={{ cursor: pending ? 'progress' : undefined }}>
      <div
        className={`grid gap-3 sm:grid-cols-2 ${shops ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}
      >
      {/* Период сбрасывается не в пустоту, а в значение по умолчанию (текущий
          месяц, см. defaultRange): период без границ бессмысленен. Крестик
          поэтому появляется только когда даты стоят в ссылке явно. */}
      <Field
        label="Период"
        onClear={active.period ? () => apply({ from: undefined, to: undefined }) : undefined}
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
        onClear={active.region ? () => apply({ region: undefined }) : undefined}
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
          /* Сброс возвращает не «пусто», а критерий страницы: критерий в
             фильтре выбран всегда, состояния «все критерии» больше нет. */
          onClear={active.criterion ? () => apply({ criterion: criterionDefault }) : undefined}
        >
          <select
            value={criterion}
            onChange={(e) => apply({ criterion: e.target.value as CriterionKey })}
          >
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
          onClear={active.status ? () => apply({ status: 'all' }) : undefined}
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

      {/* Кнопка появляется только когда есть что сбрасывать: на чистой
          странице она бы предлагала сбросить ничто. */}
      {activeCount > 0 && (
        <div
          className="mt-3 flex justify-end border-t pt-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          <button
            type="button"
            onClick={resetAll}
            className="rounded-md border px-2.5 py-1 text-xs muted hover:opacity-70"
            style={{ borderColor: 'var(--border)' }}
          >
            ✕ Сбросить все фильтры ({activeCount})
          </button>
        </div>
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
