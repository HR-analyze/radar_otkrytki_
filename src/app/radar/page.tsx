import { loadConfig } from '@/lib/config';
import { resolveParams } from '@/lib/params';
import { listRegions, listShops, radar } from '@/lib/queries';
import { Filters } from '@/components/Filters';
import { plural } from '@/lib/plural';
import { SLOT_TIME, STATUS_FILTER_TITLE, StatusLegend } from '@/components/Status';
import { findShops } from '@/lib/shops';
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
  const [regions, shops] = await Promise.all([
    listRegions(p.from, p.to),
    listShops(p.from),
  ]);

  // Критерий виден в подписи, а не только в фильтре: иначе неочевидно,
  // почему в ячейках именно витрина.
  const criterionTitle = config.criteria[p.criterion]?.title ?? p.criterion;

  /**
   * Замер витрины (фильтр «Витрина») меняет только ячейки критерия витрины:
   * у водителя или повара замеров нет. При другом критерии поле видно, но
   * выключено — см. slotDisabled в Filters.
   */
  const showcase = p.criterion === 'showcase';
  const slotTime = showcase && p.slot ? SLOT_TIME[p.slot] : null;

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
    slot: showcase ? p.slot : undefined,
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
          {slotTime ? ` на ${slotTime}` : showcase ? ' · итог дня' : ''}
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
        showSlot
        slotDisabled={
          showcase ? undefined : 'Замер выбирается только для критерия «Наполнение витрины»'
        }
      />

      {dates.length === 0 || rows.length === 0 ? (
        <div className="surface p-8 text-center text-sm muted">
          {emptyText({
            shop: p.shop,
            shopFound: !p.shop || findShops(shops, p.shop).length > 0,
            // Дни с оценками есть, а строк нет — всех отсёк фильтр «Статус»:
            // radar() убирает лавку, только если в ней нет дня в этом статусе.
            byStatus: dates.length > 0 && p.status && p.status !== 'all' ? STATUS_FILTER_TITLE[p.status] : null,
            slotTime,
            criterionTitle,
          })}
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

/**
 * Почему радар пуст — словами, по настоящей причине. Раньше на всё был один
 * ответ, и с фильтром «Витрина» он врал: «замер на 16:00 не вносили», когда
 * замеры были, а всех отсёк фильтр по статусу, — и РМ шёл вносить заново.
 */
function emptyText({
  shop,
  shopFound,
  byStatus,
  slotTime,
  criterionTitle,
}: {
  shop?: string;
  shopFound: boolean;
  byStatus: string | null;
  slotTime: string | null;
  criterionTitle: string;
}): string {
  if (!shopFound) {
    return `По запросу «${shop}» лавок не нашлось. Попробуйте код (М17) или часть названия.`;
  }
  const what = slotTime ? `замеру на ${slotTime}` : `критерию «${criterionTitle}»`;
  if (byStatus) return `По ${what} лавок под фильтром «${byStatus}» нет. Сними фильтр по статусу.`;
  const where = shop ? ` у «${shop}»` : '';
  if (slotTime) {
    return `Замер на ${slotTime}${where} за период не вносили. Возьми итог дня или другой замер, или расширь период.`;
  }
  return `За период по критерию «${criterionTitle}»${where} оценок нет. Возьми другой критерий или расширь период.`;
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
