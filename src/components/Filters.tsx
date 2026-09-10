'use client';

import { useRouter, useSearchParams } from 'next/navigation';
import { useCallback, useEffect, useState, useTransition } from 'react';
import {
  CRITERION_ORDER,
  DEFAULT_CRITERION,
  type CriterionKey,
  type ThresholdConfig,
} from '@/lib/types';
import { activePreset, periodPresets } from '@/lib/periods';
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
   * Раскрыта ли панель на телефоне. Открываем сразу, если фильтры уже
   * что-то отбирают: свёрнутая панель над отфильтрованной таблицей означала
   * бы «восемь лавок вместо восьмидесяти» без единого объяснения почему.
   */
  const [openOnPhone, setOpenOnPhone] = useState(false);

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

  // Появился фильтр (например, по ссылке со сводки) — показываем панель.
  useEffect(() => {
    if (activeCount > 0) setOpenOnPhone(true);
  }, [activeCount]);

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

  /**
   * Быстрые периоды: раньше до них можно было добраться только открыв
   * календарь и долистав его до низа, хотя «последние 7 дней» — самый частый
   * запрос к радару вообще.
   */
  const presets = periodPresets(dates);
  const currentPreset = activePreset(presets, state.from, state.to);

  const fields = (
    <>
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
            pending={pending}
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
    </>
  );

  return (
    /*
     * Пока страница пересобирается, панель гаснет и не ловит клики: единственным
     * признаком работы был курсор-«часы», а его не видно ни на телефоне, ни
     * краем глаза — сайт выглядел так, будто фильтр не сработал, и по нему
     * щёлкали второй раз.
     */
    <div className="surface p-3">
      {pending && <span className="route-progress" aria-hidden />}

      {/*
        На телефоне пять полей в столбик занимали весь экран: до таблицы,
        ради которой страницу и открыли, нужно было пролистать всю панель.
        Прячем их за кнопку — но только на узком экране: на широком места
        хватает, и лишний клик там был бы вредом.

        Комплект полей при этом ровно один. Двумя (одним под кнопкой, вторым
        для широкого экрана) задваивались бы `id` списков подсказок и подписи
        полей — программа чтения с экрана прочитала бы все фильтры дважды.
      */}
      <button
        type="button"
        onClick={() => setOpenOnPhone((v) => !v)}
        aria-expanded={openOnPhone}
        aria-controls="filters-grid"
        className="flex w-full items-center justify-between gap-2 text-sm sm:hidden"
      >
        <span className="font-medium">
          Фильтры
          {activeCount > 0 && <span className="muted"> · активно {activeCount}</span>}
        </span>
        <span
          aria-hidden
          className="muted transition-transform"
          style={{ transform: openOnPhone ? 'rotate(180deg)' : undefined }}
        >
          ⌄
        </span>
      </button>

      <div
        id="filters-grid"
        className={`${openOnPhone ? 'mt-3 block' : 'hidden'} sm:mt-0 sm:block`}
      >
        <FilterGrid pending={pending} wide={!!shops}>
          {fields}
        </FilterGrid>
      </div>

      {(presets.length > 0 || activeCount > 0) && (
        <div
          className="mt-3 flex flex-wrap items-center justify-between gap-2 border-t pt-2.5"
          style={{ borderColor: 'var(--border)' }}
        >
          {/* Выбранный период подсвечен: иначе по четырём одинаковым кнопкам
              не понять, что сейчас на экране — неделя или весь месяц. */}
          <div className="flex flex-wrap items-center gap-1.5">
            {presets.map((preset) => {
              const on = currentPreset === preset.key;
              return (
                <button
                  key={preset.key}
                  type="button"
                  onClick={() => apply({ from: preset.from, to: preset.to })}
                  aria-pressed={on}
                  className={`rounded-md border px-2.5 py-1 text-xs ${on ? 'font-semibold' : 'muted hover:opacity-70'}`}
                  style={{
                    borderColor: on ? 'var(--focus)' : 'var(--border)',
                    color: on ? 'var(--text)' : undefined,
                    background: on
                      ? 'color-mix(in srgb, var(--focus) 10%, transparent)'
                      : undefined,
                  }}
                >
                  {/* На узком экране подпись короче: четыре кнопки должны
                      помещаться в одну строку, а не переноситься по одной. */}
                  <span className="sm:hidden">{preset.short}</span>
                  <span className="hidden sm:inline">{preset.label}</span>
                </button>
              );
            })}
          </div>

          {/* Кнопка появляется только когда есть что сбрасывать: на чистой
              странице она бы предлагала сбросить ничто. */}
          {activeCount > 0 && (
            <button
              type="button"
              onClick={resetAll}
              className="ml-auto rounded-md border px-2.5 py-1 text-xs muted hover:opacity-70"
              style={{ borderColor: 'var(--border)' }}
            >
              ✕ Сбросить все фильтры ({activeCount})
            </button>
          )}
        </div>
      )}
    </div>
  );
}

/**
 * Сетка полей. Живёт отдельным компонентом, потому что рисуется дважды: под
 * раскрывающимся заголовком на телефоне и в открытую на широком экране.
 * Разметка при этом одна — иначе два варианта разъехались бы при первой правке.
 */
function FilterGrid({
  pending,
  wide,
  children,
}: {
  pending: boolean;
  /** Есть ли поле «Лавка»: от него зависит, пять колонок или четыре. */
  wide: boolean;
  children: React.ReactNode;
}) {
  return (
    <div
      aria-busy={pending}
      className={`${pending ? 'is-busy' : ''} grid gap-3 sm:grid-cols-2 ${wide ? 'lg:grid-cols-5' : 'lg:grid-cols-4'}`}
    >
      {children}
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
