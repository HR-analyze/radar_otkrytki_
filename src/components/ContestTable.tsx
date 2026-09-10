'use client';

import Link from 'next/link';
import { useMemo, useState } from 'react';
import type { ContestRow } from '@/lib/queries';
import { formatPoints, type ContestScore } from '@/lib/contest';
import { plural } from '@/lib/plural';
import { compareShopNumber } from '@/lib/shops';
import { shortDate } from '@/lib/time';
import { StatusCell, STATUS_TEXT } from './Status';

type Sort = 'rank' | 'shop' | 'fill' | 'red';

const SORT_TITLE: Record<Sort, string> = {
  rank: 'Турнирный порядок: больше баллов — выше, при равенстве вперёд тот, у кого меньше красных дней',
  shop: 'Порядок по справочнику: М1, М2, М3…',
  fill: 'Сначала лавки с самой полной витриной',
  red: 'Сначала лавки с наибольшим числом красных дней',
};

/**
 * Таблица конкурса.
 *
 * Конкурс — соревнование, и строки приезжают с сервера уже в турнирном
 * порядке (см. `contest` в queries.ts). Заголовки были неинтерактивными: ни
 * найти свою лавку в списке из восьмидесяти, ни посмотреть, у кого витрина
 * полнее, было нельзя — только читать глазами сверху вниз.
 *
 * Турнирный порядок здесь не пересчитывается: он один, и живёт на сервере.
 * Дублировать его правило на клиенте значило бы завести второе «по баллам»,
 * которое разъедется с первым при первой же правке.
 *
 * Порядок в адрес не пишем, в отличие от радара: конкурсной ссылкой
 * «покажи мне такой-то порядок» никто не делится — делятся отчётом.
 */
export function ContestTable({
  rows,
  dates,
  from,
  to,
}: {
  rows: ContestRow[];
  dates: string[];
  from: string;
  to: string;
}) {
  const [sort, setSort] = useState<Sort>('rank');
  const ordered = useMemo(() => order(rows, sort), [rows, sort]);

  return (
    <div className="surface radar-scroll">
      <table className="radar-table w-full text-sm">
        <caption className="sr-only">
          Баллы лавок по дням за период {shortDate(from)} — {shortDate(to)}
        </caption>
        <thead>
          <tr>
            <th
              className="radar-sticky px-3 py-2 text-left text-xs font-medium muted"
              aria-sort={sort === 'shop' ? 'ascending' : 'none'}
            >
              <SortButton current={sort} value="shop" onPick={setSort}>
                Лавка
              </SortButton>
            </th>
            <th className="hidden px-2 py-2 text-left text-xs font-medium muted sm:table-cell">РМ</th>
            {dates.map((d) => (
              <th key={d} className="px-0.5 py-2 text-center text-xs font-medium muted">
                {shortDate(d)}
              </th>
            ))}
            <th
              className="hidden px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted md:table-cell"
              aria-sort={sort === 'red' ? 'descending' : 'none'}
            >
              <SortButton current={sort} value="red" onPick={setSort}>
                🔴 / 🟡 / 🟢
              </SortButton>
            </th>
            <th
              className="hidden px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted md:table-cell"
              aria-sort={sort === 'fill' ? 'descending' : 'none'}
            >
              <SortButton current={sort} value="fill" onPick={setSort}>
                Витрина
              </SortButton>
            </th>
            <th
              className="hidden px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted md:table-cell"
              aria-sort={sort === 'rank' ? 'descending' : 'none'}
            >
              <SortButton current={sort} value="rank" onPick={setSort}>
                Баллы
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
                {/* На телефоне колонка «Баллы» уезжает за правый край, а
                    ради неё вкладку и открывают — дублируем у названия. */}
                <span
                  className="ml-2 text-xs font-semibold tabular-nums md:hidden"
                  style={{ color: pointsColor(r.score.points) }}
                >
                  {formatPoints(r.score.points)}
                </span>
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
                    title={`${r.shop.name} · ${shortDate(d)} · ${STATUS_TEXT[cell.status]} · витрина ${Math.round(cell.fill * 100)}% · ${formatPoints(cell.points)}`}
                  />
                );
              })}
              <Counts score={r.score} />
              <td className="hidden px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted md:table-cell">
                {r.avgFill == null ? '—' : `${Math.round(r.avgFill * 100)}%`}
              </td>
              <Points score={r.score} />
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
  current: Sort;
  value: Sort;
  onPick: (v: Sort) => void;
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
      {on && <span aria-hidden>↓</span>}
    </button>
  );
}

/**
 * Порядок строк.
 *
 * `rank` — то, как строки пришли с сервера, поэтому здесь он ничего не
 * сортирует: правило турнирной таблицы одно и живёт в queries.ts.
 *
 * Лавки без единого оценённого дня сюда не доезжают вовсе (сервер их
 * отбрасывает), так что защищаться от «нуля, который на самом деле не
 * участвовала» здесь не от чего.
 */
function order(rows: readonly ContestRow[], sort: Sort): ContestRow[] {
  if (sort === 'rank') return [...rows];
  if (sort === 'shop') return [...rows].sort((a, b) => compareShopNumber(a.shop, b.shop));
  if (sort === 'fill') return [...rows].sort((a, b) => (b.avgFill ?? -1) - (a.avgFill ?? -1));

  // Больше красных — выше; при равенстве вперёд тот, у кого больше жёлтых:
  // «пять красных и три жёлтых» тревожнее, чем «пять красных и ноль».
  return [...rows].sort((a, b) => b.score.red - a.score.red || b.score.yellow - a.score.yellow);
}

/** Разбивка дней по цветам — статистика лавки рядом с её строкой. */
function Counts({ score }: { score: ContestScore }) {
  return (
    <td
      className="hidden px-2 py-1 text-right text-xs whitespace-nowrap tabular-nums muted md:table-cell"
      title={`${score.rated} ${plural(score.rated, 'оценённый день', 'оценённых дня', 'оценённых дней')} за период`}
    >
      {score.red} / {score.yellow} / {score.green}
    </td>
  );
}

/**
 * Баллы со знаком и знаменателем: «+3» из скольких дней — без этого «0» у
 * лавки с двумя днями и у лавки с двадцатью выглядят одинаково.
 */
function Points({ score }: { score: ContestScore }) {
  return (
    <td
      className="hidden px-2 py-1 text-right text-sm font-semibold whitespace-nowrap tabular-nums md:table-cell"
      title={`🟢 ${score.green} · 🟡 ${score.yellow} · 🔴 ${score.red} → ${formatPoints(score.points)} за ${score.rated} ${plural(score.rated, 'день', 'дня', 'дней')}`}
      style={{ color: pointsColor(score.points) }}
    >
      {formatPoints(score.points)}
    </td>
  );
}

/** Плюс — зелёным, минус — красным: знак читается раньше цифры. */
function pointsColor(points: number): string | undefined {
  if (points > 0) return 'var(--green-ink)';
  if (points < 0) return 'var(--red-ink)';
  return undefined;
}
