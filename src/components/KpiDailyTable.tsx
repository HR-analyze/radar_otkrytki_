import Link from 'next/link';
import type { KpiShopRow } from '@/lib/queries';
import { shortDate } from '@/lib/time';
import { STATUS_TEXT } from './Status';

/**
 * Блок КПИ линейных сотрудников: лавки × дни, в клетке — итог дня в процентах.
 *
 * Та же раскладка, что у радара и конкурса, но в клетке цифра, а не значок:
 * линейного сотрудника оценивают по проценту каждого дня, и цвет без числа
 * отвечал бы только на «в норме ли», а не на «сколько».
 *
 * Серверный компонент: сортировать здесь нечего, строки идут по справочнику
 * (М1, М2, М3…) — свою лавку ищут глазами.
 */
export function KpiDailyTable({
  rows,
  dates,
  from,
  to,
}: {
  rows: KpiShopRow[];
  dates: string[];
  from: string;
  to: string;
}) {
  return (
    <div className="surface radar-scroll">
      <table className="radar-table w-full text-sm">
        <caption className="sr-only">
          Наполнение витрины лавок по дням за период {shortDate(from)} — {shortDate(to)}, в процентах
        </caption>
        <thead>
          <tr>
            <th className="radar-sticky px-3 py-2 text-left text-xs font-medium muted">Лавка</th>
            <th className="hidden px-2 py-2 text-left text-xs font-medium muted sm:table-cell">РМ</th>
            {dates.map((d) => (
              <th key={d} className="px-0.5 py-2 text-center text-xs font-medium muted">
                {shortDate(d)}
              </th>
            ))}
            <th className="w-full" aria-hidden />
          </tr>
        </thead>
        <tbody>
          {rows.map((r) => (
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
                const day = r.days[d];
                if (!day) return <td key={d} className="px-0.5 py-0.5" />;
                const title = `${r.shop.name} · ${shortDate(d)} · ${measures(day.morning, day.afternoon)} · итог ${day.percent}% · ${STATUS_TEXT[day.status]}`;
                return (
                  <td key={d} className="px-0.5 py-0.5" title={title}>
                    <Link
                      href={`/shop/${encodeURIComponent(r.shop.code)}?from=${d}&to=${d}`}
                      aria-label={title}
                      className={`st-${day.status} flex h-11 min-w-9 items-center justify-center rounded px-1 text-[11px] font-semibold tabular-nums sm:h-7`}
                    >
                      {day.percent}
                    </Link>
                  </td>
                );
              })}
              <td aria-hidden />
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/** «утро 100% · 16:00 92%»; несделанный замер так и подписан — итог тогда равен второму. */
function measures(morning: number | null, afternoon: number | null): string {
  const show = (v: number | null) => (v == null ? 'не мерили' : `${v}%`);
  return `утро ${show(morning)} · 16:00 ${show(afternoon)}`;
}
