import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { listRegions, listShops, radar } from '@/lib/queries';
import { Filters } from '@/components/Filters';
import { plural } from '@/lib/plural';
import { StatusLegend } from '@/components/Status';
import { RadarTable, type RadarSort } from '@/components/RadarTable';
import { DEFAULT_CRITERION } from '@/lib/types';

export const dynamic = 'force-dynamic';

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
  // почему в ячейках именно витрина.
  const criterionTitle = config.criteria[p.criterion]?.title ?? p.criterion;

  /**
   * Порядок строк. По умолчанию — как в справочнике (М1, М2, М3…): так лавку
   * ищут глазами. Дальше порядок меняется на месте, без похода на сервер, —
   * см. RadarTable; сюда он приезжает только из адреса, чтобы ссылкой на
   * «проблемные наверх» можно было поделиться.
   */
  const sort = sortFrom(one(sp, 'sort'));

  const { dates, rows } = await radar({
    from: p.from,
    to: p.to,
    region: p.region,
    criterion: p.criterion,
    status: p.status,
    shop: p.shop,
  });

  return (
    /* radar-shell: на широком экране таблица получает собственный скролл,
       иначе шапка с датами не липнет — см. globals.css. */
    <div className="radar-shell flex flex-col gap-3 sm:gap-5">
      <div>
        <h1 className="text-xl font-semibold tracking-tight sm:text-2xl">
          {p.shop || p.region ? 'Радар по лавкам' : 'Радар по всем лавкам'}
        </h1>
        <p className="mt-1 text-xs muted sm:text-sm">
          {rows.length} {plural(rows.length, 'лавка', 'лавки', 'лавок')} под фильтром
          {` · критерий «${criterionTitle}»`}
          {p.shop && ` · поиск «${p.shop}»`}
          {p.region && ` · РМ ${p.region}`}
        </p>
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
          {/* Критерий выбран всегда, поэтому «ничего не нашлось» — это либо
              поиск по лавке, либо пустой критерий за период. */}
          {p.shop
            ? `По запросу «${p.shop}» лавок не нашлось. Попробуйте код (М17) или часть названия.`
            : `За период по критерию «${criterionTitle}» оценок нет. Возьми другой критерий, расширь период или сними фильтр по статусу.`}
        </div>
      ) : (
        <>
          {/* Что означает точка в ячейке, не было написано нигде: её читали
              то как ноль, то как «плохо». */}
          <StatusLegend note="Клик по ячейке — карточка лавки за этот день. Клик по заголовку колонки — порядок строк." />
          <RadarTable rows={rows} dates={dates} from={p.from} to={p.to} initialSort={sort} />
        </>
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

/** Чужое значение в адресе не должно ронять страницу — молча берём порядок по умолчанию. */
function sortFrom(value: string | undefined): RadarSort {
  return value === 'red' || value === 'region' ? value : 'shop';
}
