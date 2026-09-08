import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { listRegions, listShops, radar } from '@/lib/queries';
import { shortDate } from '@/lib/time';
import { Filters } from '@/components/Filters';
import { plural } from '@/lib/plural';
import { StatusCell, STATUS_TEXT } from '@/components/Status';
import type { CriterionKey } from '@/lib/types';

export const dynamic = 'force-dynamic';

/**
 * Критерий, на котором радар открывается.
 *
 * Не «Общий результат»: радар открывают, чтобы смотреть наполнение витрин —
 * это единственный критерий, который заполняют руками, и единственный, ради
 * которого сюда заходят каждый день. Общий результат никуда не делся —
 * он первый в списке, и выбранное руками всегда главнее (`criterion=all`
 * остаётся в ссылке, см. Filters).
 */
const DEFAULT_CRITERION: CriterionKey = 'showcase';

export default async function RadarPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const p = await resolveParams(sp, { criterion: DEFAULT_CRITERION });
  const config = loadConfig();
  const [regions, shops] = await Promise.all([listRegions(p.from, p.to), listShops()]);

  // Критерий виден в подписи, а не только в фильтре: иначе неочевидно,
  // почему в ячейках витрина, а не общий результат.
  const criterionTitle =
    p.criterion && p.criterion !== 'all'
      ? (config.criteria[p.criterion]?.title ?? p.criterion)
      : null;

  const { dates, rows } = await radar({
    from: p.from,
    to: p.to,
    region: p.region,
    criterion: p.criterion,
    status: p.status,
    shop: p.shop,
  });

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">
          {p.shop || p.region ? 'Радар по лавкам' : 'Радар по всем лавкам'}
        </h1>
        {(p.shop || p.region || criterionTitle) && (
          <p className="mt-1 text-sm muted">
            {rows.length} {plural(rows.length, 'лавка', 'лавки', 'лавок')} под фильтром
            {criterionTitle && ` · критерий «${criterionTitle}»`}
            {p.shop && ` · поиск «${p.shop}»`}
            {p.region && ` · РМ ${p.region}`}
          </p>
        )}
      </div>

      <Filters
        base="/radar"
        state={p}
        regions={regions}
        dates={p.dates}
        config={config}
        shops={shops.map((s) => ({ code: s.code, name: s.name }))}
        criterionDefault={DEFAULT_CRITERION}
      />

      {dates.length === 0 || rows.length === 0 ? (
        <div className="surface p-8 text-center text-sm muted">
          {p.shop
            ? `По запросу «${p.shop}» лавок не нашлось. Попробуйте код (М17) или часть названия.`
            : criterionTitle
              ? `За период по критерию «${criterionTitle}» оценок нет. Возьми общий результат или расширь период.`
              : 'Под фильтры ничего не попало. Попробуй расширить период или снять фильтр по статусу.'}
        </div>
      ) : (
        <div className="surface radar-scroll">
          <table className="radar-table w-full text-sm">
            <thead>
              <tr>
                <th className="radar-sticky px-3 py-2 text-left text-xs font-medium muted">Лавка</th>
                <th className="hidden px-2 py-2 text-left text-xs font-medium muted sm:table-cell">РМ</th>
                {dates.map((d) => (
                  <th key={d} className="px-0.5 py-2 text-center text-xs font-medium muted">
                    {shortDate(d)}
                  </th>
                ))}
                <th
                  className="px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted"
                  title="Итог: красных дней из оценённых"
                >
                  🔴
                </th>
                <th className="w-full" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {rows.map((r) => (
                <tr key={r.shop.code}>
                  <td className="radar-sticky px-3 py-1 whitespace-nowrap">
                    <Link
                      href={`/shop/${encodeURIComponent(r.shop.code)}?from=${p.from}&to=${p.to}`}
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
      )}
    </div>
  );
}
