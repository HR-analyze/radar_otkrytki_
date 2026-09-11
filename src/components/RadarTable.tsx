'use client';

import Link from 'next/link';
import { useEffect, useMemo, useState } from 'react';
import type { RadarRow } from '@/lib/queries';
import { plural } from '@/lib/plural';
import { shortDate } from '@/lib/time';
import { StatusCell, STATUS_TEXT } from './Status';

export type RadarSort = 'shop' | 'red' | 'region';

const SORT_TITLE: Record<RadarSort, string> = {
  shop: 'Порядок по справочнику: М1, М2, М3…',
  red: 'Сначала лавки с наибольшим числом красных дней',
  region: 'Лавки сгруппированы по РМ, внутри — по справочнику',
};

/**
 * Таблица радара с сортировкой на месте.
 *
 * Раньше клик по заголовку был обычной ссылкой: страница уходила на сервер,
 * заново считала весь радар и возвращалась — ради того, чтобы переставить
 * восемьдесят уже посчитанных строк. Здесь порядок меняется мгновенно, а
 * адрес всё равно обновляется (history.replaceState) — ссылкой на «проблемные
 * наверх» по-прежнему можно поделиться, просто она больше не стоит запроса.
 */
export function RadarTable({
  rows,
  dates,
  from,
  to,
  initialSort,
}: {
  rows: RadarRow[];
  dates: string[];
  from: string;
  to: string;
  initialSort: RadarSort;
}) {
  const [sort, setSort] = useState<RadarSort>(initialSort);

  // Порядок пришёл из адреса — например, кнопкой «назад».
  useEffect(() => setSort(initialSort), [initialSort]);

  useEffect(() => {
    const url = new URL(window.location.href);
    // Порядок по справочнику — значение по умолчанию, в адрес его не пишем.
    if (sort === 'shop') url.searchParams.delete('sort');
    else url.searchParams.set('sort', sort);
    window.history.replaceState(null, '', url);
  }, [sort]);

  const ordered = useMemo(() => order(rows, sort), [rows, sort]);

  return (
    <div className="surface radar-scroll">
      <table className="radar-table w-full text-sm">
        <caption className="sr-only">
          Статусы лавок по дням за период {shortDate(from)} — {shortDate(to)}
        </caption>
        <thead>
          <tr>
            <th className="radar-sticky px-3 py-2 text-left text-xs font-medium muted" aria-sort={ariaSort(sort, 'shop')}>
              <SortButton current={sort} value="shop" onPick={setSort}>
                Лавка
              </SortButton>
            </th>
            <th
              className="hidden px-2 py-2 text-left text-xs font-medium muted sm:table-cell"
              aria-sort={ariaSort(sort, 'region')}
            >
              <SortButton current={sort} value="region" onPick={setSort}>
                РМ
              </SortButton>
            </th>
            {dates.map((d) => (
              <th key={d} className="px-0.5 py-2 text-center text-xs font-medium muted">
                {shortDate(d)}
              </th>
            ))}
            <th
              className="px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted"
              aria-sort={ariaSort(sort, 'red')}
            >
              <SortButton current={sort} value="red" onPick={setSort}>
                🔴
              </SortButton>
            </th>
            <th className="w-full" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {ordered.map((r) => (
            <tr key={r.shop.code}>
              <td className="radar-sticky px-3 py-1 whitespace-nowrap">
                <Link
                  href={`/shop/${encodeURIComponent(r.shop.code)}?from=${from}&to=${to}`}
                  className="hover:underline"
                  title={r.shop.region ? `${r.shop.name} · РМ ${r.shop.region}` : r.shop.name}
                >
                  {r.shop.name}
                </Link>
              </td>
              <td className="hidden px-2 py-1 text-xs whitespace-nowrap muted sm:table-cell">
                {r.shop.region ?? '—'}
              </td>
              {dates.map((d) => {
                const cell = r.cells[d];
                if (!cell) return <td key={d} className="px-0.5 py-0.5" />;
                return (
                  <StatusCell
                    key={d}
                    status={cell.status}
                    href={`/shop/${encodeURIComponent(r.shop.code)}?from=${d}&to=${d}`}
                    title={`${r.shop.name} · ${shortDate(d)} · ${STATUS_TEXT[cell.status]}`}
                  />
                );
              })}
              {/* Голое число красных не читалось: «7» — это 7 из 8 дней или
                  7 из 30? Знаменатель — дни с оценкой, дни без данных в него
                  не входят, поэтому он совпадает с числом точек в строке. */}
              <td
                className="px-2 py-1 text-right text-xs font-semibold whitespace-nowrap tabular-nums"
                title={
                  r.ratedCount > 0
                    ? `${r.redCount} ${plural(r.redCount, 'красный день', 'красных дня', 'красных дней')} из ${r.ratedCount} ${plural(r.ratedCount, 'оценённого', 'оценённых', 'оценённых')}`
                    : 'За период лавку ни разу не оценивали'
                }
              >
                {r.ratedCount > 0 ? (
                  <span className={r.redCount === 0 ? 'muted' : undefined}>
                    {r.redCount} из {r.ratedCount}
                  </span>
                ) : (
                  ''
                )}
              </td>
              <td aria-hidden />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function SortButton({
  current,
  value,
  onPick,
  children,
}: {
  current: RadarSort;
  value: RadarSort;
  onPick: (v: RadarSort) => void;
  children: React.ReactNode;
}) {
  const on = current === value;
  return (
    <button
      type="button"
      onClick={() => onPick(value)}
      title={SORT_TITLE[value]}
      className={`inline-flex items-center gap-1 rounded px-1 py-0.5 hover:underline ${on ? 'font-semibold' : ''}`}
      style={on ? { color: 'var(--text)' } : undefined}
    >
      {children}
      {/* Стрелка только у активной колонки: три стрелки подряд означали бы,
          что сортировок три сразу. */}
      {on && <span aria-hidden>↓</span>}
    </button>
  );
}

function ariaSort(current: RadarSort, value: RadarSort): 'descending' | 'none' {
  return current === value ? 'descending' : 'none';
}

/**
 * Проблемные наверх: сначала больше красных дней, при равном числе — та лавка,
 * у которой красных больше в долях (2 из 3 хуже, чем 2 из 30), а при равной
 * доле держим порядок справочника.
 */
function order(rows: readonly RadarRow[], sort: RadarSort): RadarRow[] {
  if (sort === 'shop') return [...rows];

  if (sort === 'region') {
    // Лавки без РМ — в конец: это дыра в справочнике, а не отдельный менеджер.
    return [...rows].sort((a, b) => {
      const ar = a.shop.region ?? '￿';
      const br = b.shop.region ?? '￿';
      return ar.localeCompare(br, 'ru');
    });
  }

  const share = (r: RadarRow) => (r.ratedCount > 0 ? r.redCount / r.ratedCount : 0);
  return [...rows].sort((a, b) => b.redCount - a.redCount || share(b) - share(a));
}
