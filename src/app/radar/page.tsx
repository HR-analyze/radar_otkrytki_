import Link from 'next/link';
import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { listRegions, listShops, radar } from '@/lib/queries';
import { shortDate } from '@/lib/time';
import { Filters } from '@/components/Filters';
import { plural } from '@/lib/plural';
import { StatusCell, STATUS_TEXT } from '@/components/Status';
import type { CriterionKey } from '@/lib/types';
import type { RadarRow } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Критерий, на котором радар открывается.
 *
 * Не «Общий результат»: радар открывают, чтобы смотреть наполнение витрин —
 * это единственный критерий, который заполняют руками, и единственный, ради
 * которого сюда заходят каждый день. Сам «Общий результат» из списка убран
 * (см. Filters, SHOW_TOTAL_OPTION), но значение `criterion=all` работает и
 * в ссылках, и как значение по умолчанию для страниц без предвыбора.
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

  /**
   * Порядок строк. По умолчанию — как в справочнике (М1, М2, М3…): так лавку
   * ищут глазами. `sort=red` поднимает наверх проблемные — ради этого радар
   * чаще всего и открывают, а глазами по восьмидесяти строкам это не считается.
   */
  const sort = one(sp, 'sort') === 'red' ? 'red' : 'shop';

  const { dates, rows } = await radar({
    from: p.from,
    to: p.to,
    region: p.region,
    criterion: p.criterion,
    status: p.status,
    shop: p.shop,
  });

  const ordered = sort === 'red' ? byRedFirst(rows) : rows;

  return (
    /* radar-shell: на широком экране таблица получает собственный скролл,
       иначе шапка с датами не липнет — см. globals.css. */
    <div className="radar-shell flex flex-col gap-5">
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
                <th className="radar-sticky px-3 py-2 text-left text-xs font-medium muted">
                  <Link
                    href={sortHref(sp, 'shop')}
                    className="hover:underline"
                    title="Порядок по справочнику: М1, М2, М3…"
                  >
                    Лавка{sort === 'shop' && ' ↓'}
                  </Link>
                </th>
                <th className="hidden px-2 py-2 text-left text-xs font-medium muted sm:table-cell">РМ</th>
                {dates.map((d) => (
                  <th key={d} className="px-0.5 py-2 text-center text-xs font-medium muted">
                    {shortDate(d)}
                  </th>
                ))}
                <th className="px-2 py-2 text-right text-xs font-medium whitespace-nowrap muted">
                  <Link
                    href={sortHref(sp, 'red')}
                    className="hover:underline"
                    title="Итог: красных дней из оценённых. Клик — проблемные наверх"
                  >
                    🔴{sort === 'red' && ' ↓'}
                  </Link>
                </th>
                <th className="w-full" aria-hidden />
              </tr>
            </thead>
            <tbody>
              {ordered.map((r) => (
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

/** Первое значение параметра: в адресе он может оказаться повторённым. */
function one(
  sp: Record<string, string | string[] | undefined>,
  key: string,
): string | undefined {
  const v = sp[key];
  return Array.isArray(v) ? v[0] : v;
}

/**
 * Ссылка на ту же страницу с другим порядком строк: все фильтры остаются,
 * меняется только `sort`. Порядок по справочнику — значение по умолчанию,
 * поэтому в адрес он не пишется.
 */
function sortHref(
  sp: Record<string, string | string[] | undefined>,
  next: 'shop' | 'red',
): string {
  const q = new URLSearchParams();
  for (const key of ['from', 'to', 'region', 'shop', 'criterion', 'status']) {
    const value = one(sp, key);
    if (value) q.set(key, value);
  }
  if (next === 'red') q.set('sort', 'red');
  const query = q.toString();
  return query ? `/radar?${query}` : '/radar';
}

/**
 * Проблемные наверх: сначала больше красных дней, при равном числе — та лавка,
 * у которой красных больше в долях (2 из 3 хуже, чем 2 из 30), а при равной
 * доле держим порядок справочника.
 */
function byRedFirst(rows: readonly RadarRow[]): RadarRow[] {
  const share = (r: RadarRow) => (r.ratedCount > 0 ? r.redCount / r.ratedCount : 0);
  return [...rows].sort((a, b) => b.redCount - a.redCount || share(b) - share(a));
}
