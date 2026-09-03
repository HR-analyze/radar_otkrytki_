import { loadConfig } from './config';
import { loadSnapshot, type ImportRunSummary, type Snapshot } from './snapshot';
import {
  CRITERION_ORDER,
  type ArrivalSource,
  type CriterionKey,
  type CriterionStatusRow,
  type RegionPeriod,
  type Status,
  type ThresholdConfig,
} from './types';
import { aggregateStatuses } from './status';
import { rateShopDay, type RatedPerson, type ShopRating } from './rating';

/**
 * Чтение для дашборда поверх снимка в памяти (см. snapshot.ts).
 *
 * Раньше здесь был SQL: он работал только с SQLite, а тот не запускается
 * на serverless-хостинге. Данных мало (тысячи строк), поэтому агрегации
 * считаются на месте — одна реализация и для SQLite, и для JSON-снимка.
 */

export interface ShopRow {
  code: string;
  name: string;
  region: string | null;
}

const byShopNumber = (a: ShopRow, b: ShopRow): number =>
  shopNumber(a.code) - shopNumber(b.code) || a.code.localeCompare(b.code);

function shopNumber(code: string): number {
  const n = Number(code.replace(/\D/g, ''));
  return Number.isFinite(n) ? n : Number.MAX_SAFE_INTEGER;
}

/**
 * Статусы критериев → статус лавки за день, по правилу из конфига
 * (`rules.shopAggregation`). Используется, когда стратегия — не 'components':
 * 'worstOfConfirmed' отличается от 'worst' не способом свёртки, а набором
 * критериев — он отсеивается раньше, при выборке.
 */
function aggregateShop(
  statuses: readonly Status[],
  config: ThresholdConfig,
): { status: Status; score: number | null } {
  const strategy = config.rules.shopAggregation.strategy;
  return aggregateStatuses(statuses, strategy === 'average' ? 'average' : 'worst', config);
}

/** Считать ли итог лавки по формуле «Водитель + Сотрудники + Витрина» / 3. */
function useComponents(config: ThresholdConfig): boolean {
  return config.rules.shopAggregation.strategy === 'components';
}

/**
 * Люди по лавкам и дням для расчёта рейтинга: за дни с сырыми выгрузками это
 * отметки, за более ранние — статусы людей из легаси-книги (там времени нет,
 * но цвет есть, а формуле нужен только он).
 */
async function peopleIndex(): Promise<Map<string, RatedPerson[]>> {
  const snap = await loadSnapshot();
  const index = new Map<string, RatedPerson[]>();

  const put = (date: string, shopCode: string, person: RatedPerson): void => {
    const key = `${date}|${shopCode}`;
    const list = index.get(key);
    if (list) list.push(person);
    else index.set(key, [person]);
  };

  // Посчитанное побеждает легаси на уровне «день + лавка + критерий» — так же,
  // как статусы критериев в снимке. За 19–21.08 это даёт водителя из таблицы
  // поставок и остальных сотрудников из легаси-книги в одном расчёте.
  const computed = new Set<string>();
  for (const a of snap.attendance) {
    if (a.criterion) computed.add(`${a.date}|${a.shopCode}|${a.criterion}`);
    put(a.date, a.shopCode, { criterion: a.criterion, status: a.status });
  }
  for (const p of snap.legacyPeople) {
    if (computed.has(`${p.date}|${p.shopCode}|${p.criterion}`)) continue;
    put(p.date, p.shopCode, { criterion: p.criterion, status: p.status });
  }

  return index;
}

/**
 * Отметки и легаси-статусы одного дня в один список для формулы рейтинга.
 * Посчитанное побеждает легаси по критерию — см. peopleIndex.
 */
function ratedPeople(
  attendance: readonly { criterion: CriterionKey | null; status: Status }[],
  legacy: readonly { criterion: CriterionKey; status: Status }[],
): RatedPerson[] {
  const computed = new Set(attendance.map((a) => a.criterion).filter(Boolean));
  return [
    ...attendance.map((a) => ({ criterion: a.criterion, status: a.status })),
    ...legacy
      .filter((l) => !computed.has(l.criterion))
      .map((l) => ({ criterion: l.criterion, status: l.status })),
  ];
}

/** Наполнение витрины по лавкам и дням — третье слагаемое формулы. */
async function showcaseIndex(): Promise<Map<string, Status>> {
  const snap = await loadSnapshot();
  return new Map(snap.showcase.map((s) => [`${s.date}|${s.shopCode}`, s.status]));
}

/* ------------------------------- справочники ----------------------------- */

export async function listShops(): Promise<ShopRow[]> {
  const s = await loadSnapshot();
  return [...s.shops].sort(byShopNumber);
}

export interface RegionOptions {
  /** РМ выбранного периода, которые есть и в действующем справочнике. */
  current: string[];
  /**
   * РМ выбранного периода, которых в справочнике уже нет: они ушли, но за свои
   * месяцы остаются в радаре — иначе сравнить их показатели с показателями
   * преемника было бы нельзя (см. roster-history.ts).
   */
  past: string[];
}

/**
 * РМ для выпадающего списка фильтра — только те, кто отвечал хотя бы за одну
 * лавку в выбранном периоде.
 *
 * Справочник обновляют раз в месяц, поэтому список привязан к периоду, а не к
 * «сейчас»: выбрали август — видно менеджеров августа, включая ушедших;
 * выбрали текущий месяц — видно нынешний состав.
 */
export async function listRegions(from: string, to: string): Promise<RegionOptions> {
  const s = await loadSnapshot();
  const sort = (names: Iterable<string>): string[] =>
    [...names].sort((a, b) => a.localeCompare(b, 'ru'));

  if (s.regionHistory.length === 0) {
    // Страховка на случай снимка без истории (старая сборка): как раньше,
    // одни только текущие РМ лавок, без привязки к периоду.
    const current = new Set<string>();
    for (const shop of s.shops) if (shop.region) current.add(shop.region);
    return { current: sort(current), past: [] };
  }

  // Действующие — те, у кого есть незакрытый период хоть по одной лавке.
  const stillCurrent = new Set<string>();
  for (const p of s.regionHistory) if (p.to === null) stillCurrent.add(p.manager);

  const current = new Set<string>();
  const past = new Set<string>();
  for (const p of s.regionHistory) {
    if (p.from > to || (p.to !== null && p.to < from)) continue;
    (stillCurrent.has(p.manager) ? current : past).add(p.manager);
  }

  return { current: sort(current), past: sort(past) };
}

/** Периоды РМ, сгруппированные по коду лавки — для точечных проверок по дате. */
function regionIndexOf(snap: Snapshot): Map<string, RegionPeriod[]> {
  const idx = new Map<string, RegionPeriod[]>();
  for (const p of snap.regionHistory) {
    const list = idx.get(p.shopCode);
    if (list) list.push(p);
    else idx.set(p.shopCode, [p]);
  }
  return idx;
}

/** Кто из РМ отвечал за лавку в конкретный день — null, если периода нет. */
function regionAt(periods: readonly RegionPeriod[] | undefined, date: string): string | null {
  if (!periods) return null;
  for (const p of periods) {
    if (date >= p.from && (p.to === null || date <= p.to)) return p.manager;
  }
  return null;
}

/** Был ли РМ хоть раз действующим для лавки в пределах периода [from, to]. */
function everInRegion(
  periods: readonly RegionPeriod[] | undefined,
  region: string,
  from: string,
  to: string,
): boolean {
  if (!periods) return false;
  return periods.some((p) => p.manager === region && p.from <= to && (p.to === null || p.to >= from));
}

/**
 * Проверка «этот день у этой лавки принадлежит выбранному РМ» — для построчной
 * фильтрации отметок и критериев по фильтру «РМ». Без фильтра пропускает всё.
 */
async function regionDayMatcher(
  region: string | undefined,
): Promise<(shopCode: string, date: string) => boolean> {
  if (!region) return () => true;

  const s = await loadSnapshot();
  if (s.regionHistory.length === 0) {
    // Страховка без истории: сравниваем с текущим РМ лавки, без учёта дат.
    const allowed = new Set(s.shops.filter((x) => x.region === region).map((x) => x.code));
    return (shopCode) => allowed.has(shopCode);
  }

  const idx = regionIndexOf(s);
  return (shopCode, date) => regionAt(idx.get(shopCode), date) === region;
}

export interface RegionTransition {
  shopCode: string;
  shopName: string;
  /** Кто передал лавку. */
  from: string;
  /** Кто принял. */
  to: string;
  /** С какого числа новый РМ считается действующим. */
  since: string;
}

/** Смены РМ по всем лавкам — для вкладки «История» (см. roster-history.ts). */
export async function regionTransitions(): Promise<RegionTransition[]> {
  const s = await loadSnapshot();
  const names = new Map(s.shops.map((x) => [x.code, x.name]));
  const byShop = regionIndexOf(s);

  const out: RegionTransition[] = [];
  for (const [shopCode, periods] of byShop) {
    const sorted = [...periods].sort((a, b) => a.from.localeCompare(b.from));
    for (let i = 1; i < sorted.length; i++) {
      out.push({
        shopCode,
        shopName: names.get(shopCode) ?? shopCode,
        from: sorted[i - 1].manager,
        to: sorted[i].manager,
        since: sorted[i].from,
      });
    }
  }

  return out.sort((a, b) => b.since.localeCompare(a.since) || a.shopCode.localeCompare(b.shopCode));
}

export async function listDates(): Promise<string[]> {
  const s = await loadSnapshot();
  return [...new Set(s.criteria.map((c) => c.date))].sort();
}

export async function latestDate(): Promise<string | null> {
  const dates = await listDates();
  return dates.length ? dates[dates.length - 1] : null;
}

export async function getShop(code: string): Promise<ShopRow | null> {
  const s = await loadSnapshot();
  return s.shops.find((x) => x.code === code) ?? null;
}

export async function lastRun(job: string): Promise<ImportRunSummary | null> {
  const s = await loadSnapshot();
  return s.runs.find((r) => r.job === job) ?? null;
}

export async function snapshotInfo(): Promise<{
  generatedAt: string;
  source: Snapshot['source'];
}> {
  const s = await loadSnapshot();
  return { generatedAt: s.generatedAt, source: s.source };
}

/* -------------------------------- фильтры -------------------------------- */

/**
 * Лавки под фильтром «РМ»: не только те, кем он управляет сейчас, а все, кем
 * он управлял хоть один день в пределах [from, to] — иначе выбрать прежнего
 * РМ из выпадающего списка и не увидеть ни одной строки было бы странно.
 * Какие именно дни ему принадлежат — решает regionDayMatcher построчно.
 */
async function shopsIn(
  region: string | undefined,
  shop: string | undefined,
  from: string,
  to: string,
): Promise<ShopRow[]> {
  const shops = await listShops();
  let byRegion = shops;

  if (region) {
    const s = await loadSnapshot();
    if (s.regionHistory.length === 0) {
      byRegion = shops.filter((x) => x.region === region);
    } else {
      const idx = regionIndexOf(s);
      byRegion = shops.filter((x) => everInRegion(idx.get(x.code), region, from, to));
    }
  }

  return shop ? byRegion.filter((s) => matchesShop(s, shop)) : byRegion;
}

/**
 * Поиск лавки по коду или названию: «М17» найдёт М17, «Сухаревский» — её же,
 * «М1» — М1 и М10–М19. Точное совпадение кода имеет приоритет: иначе, набрав
 * «М1», человек не смог бы посмотреть только М1.
 */
export function matchesShop(shop: { code: string; name: string }, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (shop.code.toLowerCase() === q) return true;
  return `${shop.code} ${shop.name}`.toLowerCase().includes(q);
}

/** Есть ли лавка, чей код совпал с запросом точно. */
export async function hasExactShop(query: string): Promise<boolean> {
  const q = query.trim().toLowerCase();
  return (await listShops()).some((s) => s.code.toLowerCase() === q);
}

/* --------------------------------- радар --------------------------------- */

export interface RadarFilters {
  from: string;
  to: string;
  region?: string;
  criterion?: CriterionKey | 'all';
  status?: Status | 'all';
  /** Код или часть названия лавки: «М17», «Сухаревский», «М1» (даст М1 и М10–М19). */
  shop?: string;
}

export interface RadarCell {
  status: Status;
  origin: CriterionStatusRow['origin'];
}

export interface RadarRow {
  shop: ShopRow;
  /** дата → статус (агрегат лавки либо один критерий, если он выбран в фильтре). */
  cells: Record<string, RadarCell>;
  redCount: number;
}

/**
 * Таблица-радар: строки — лавки, столбцы — дни.
 * Если критерий не выбран, в ячейке агрегат лавки по правилу из конфига
 * (по умолчанию — худший критерий).
 */
export async function radar(
  filters: RadarFilters,
): Promise<{ dates: string[]; rows: RadarRow[] }> {
  const snap = await loadSnapshot();
  const config = loadConfig();
  const onlyConfirmed = config.rules.shopAggregation.strategy === 'worstOfConfirmed';
  const wholeShop = !filters.criterion || filters.criterion === 'all';
  const byComponents = wholeShop && useComponents(config);
  const people = byComponents ? await peopleIndex() : null;
  const fills = byComponents ? await showcaseIndex() : null;

  // Точный код важнее подстроки: «М1» — это М1, а не М1 вместе с М10–М19.
  const exact = filters.shop ? await hasExactShop(filters.shop) : false;
  const shops = (await shopsIn(filters.region, filters.shop, filters.from, filters.to)).filter(
    (s) => !exact || s.code.toLowerCase() === filters.shop!.trim().toLowerCase(),
  );
  const allowedShops = new Set(shops.map((s) => s.code));
  const inRegion = await regionDayMatcher(filters.region);

  const relevant = snap.criteria.filter(
    (c) =>
      c.date >= filters.from &&
      c.date <= filters.to &&
      allowedShops.has(c.shopCode) &&
      inRegion(c.shopCode, c.date) &&
      (!filters.criterion || filters.criterion === 'all' || c.criterion === filters.criterion) &&
      (!onlyConfirmed || config.criteria[c.criterion]?.confirmed),
  );

  const dates = [...new Set(relevant.map((c) => c.date))].sort();
  // Ни одного дня с данными — строки без единой ячейки показывать незачем.
  if (dates.length === 0) return { dates, rows: [] };

  const byShop = new Map<
    string,
    Map<string, { statuses: Status[]; origin: CriterionStatusRow['origin'] }>
  >();
  for (const c of relevant) {
    let dayMap = byShop.get(c.shopCode);
    if (!dayMap) byShop.set(c.shopCode, (dayMap = new Map()));

    const cell = dayMap.get(c.date);
    if (cell) {
      cell.statuses.push(c.status);
      // Если хоть один критерий посчитан автоматически — ячейка уже не легаси.
      if (c.origin === 'computed') cell.origin = 'computed';
    } else {
      dayMap.set(c.date, { statuses: [c.status], origin: c.origin });
    }
  }

  const rows: RadarRow[] = [];
  for (const shop of shops) {
    const dayMap = byShop.get(shop.code);
    const cells: Record<string, RadarCell> = {};
    let redCount = 0;

    for (const date of dates) {
      const cell = dayMap?.get(date);
      if (!cell) continue;
      const key = `${date}|${shop.code}`;
      const { status } = byComponents
        ? rateShopDay(people?.get(key) ?? [], fills?.get(key) ?? null, config)
        : aggregateShop(cell.statuses, config);
      if (status === 'no_data') continue;
      cells[date] = { status, origin: cell.origin };
      if (status === 'red') redCount++;
    }

    if (filters.status && filters.status !== 'all') {
      if (!Object.values(cells).some((c) => c.status === filters.status)) continue;
    }
    rows.push({ shop, cells, redCount });
  }

  return { dates, rows };
}

/* ------------------------------- сводка ---------------------------------- */

export interface CriterionSummary {
  criterion: CriterionKey;
  /** Лавок в статусе: за один день — точное число, за период — среднее за день. */
  green: number;
  yellow: number;
  red: number;
  /** Лавок, по которым данных нет вовсе. */
  missing: number;
}

export interface ShopTotals {
  green: number;
  yellow: number;
  red: number;
  /** Всего лавок под фильтром. */
  total: number;
  /** Дней с данными в выбранном периоде. */
  days: number;
}

/**
 * Сколько лавок в 🟢/🟡/🔴 по каждому критерию.
 *
 * За период считается посуточно и усредняется: «в среднем за день столько-то
 * лавок красные». Иначе за неделю почти каждая лавка хоть раз была красной,
 * и показатель вырождается в «80 из 80».
 */
export async function summaryByCriterion(
  from: string,
  to: string,
  region?: string,
): Promise<CriterionSummary[]> {
  const snap = await loadSnapshot();
  const shops = await shopsIn(region, undefined, from, to);
  const allowed = new Set(shops.map((s) => s.code));
  const inRegion = await regionDayMatcher(region);

  // критерий → день → статус → множество лавок
  const perDay = new Map<CriterionKey, Map<string, Map<Status, Set<string>>>>();
  const days = new Set<string>();

  for (const c of snap.criteria) {
    if (c.date < from || c.date > to || !allowed.has(c.shopCode) || !inRegion(c.shopCode, c.date)) continue;
    days.add(c.date);

    let byDay = perDay.get(c.criterion);
    if (!byDay) perDay.set(c.criterion, (byDay = new Map()));
    let byStatus = byDay.get(c.date);
    if (!byStatus) byDay.set(c.date, (byStatus = new Map()));

    const set = byStatus.get(c.status) ?? new Set<string>();
    set.add(c.shopCode);
    byStatus.set(c.status, set);
  }

  const dayCount = Math.max(1, days.size);

  return CRITERION_ORDER.map((criterion) => {
    const byDay = perDay.get(criterion);
    let green = 0;
    let yellow = 0;
    let red = 0;

    if (byDay) {
      for (const byStatus of byDay.values()) {
        green += byStatus.get('green')?.size ?? 0;
        yellow += byStatus.get('yellow')?.size ?? 0;
        red += byStatus.get('red')?.size ?? 0;
      }
    }

    green = Math.round(green / dayCount);
    yellow = Math.round(yellow / dayCount);
    red = Math.round(red / dayCount);

    return {
      criterion,
      green,
      yellow,
      red,
      missing: Math.max(0, shops.length - green - yellow - red),
    };
  });
}

/**
 * Агрегированный статус лавки (правило — в `rules.shopAggregation`),
 * свёрнутый в счётчики. За период — так же среднее за день.
 */
export async function shopTotals(
  from: string,
  to: string,
  region?: string,
): Promise<ShopTotals> {
  const snap = await loadSnapshot();
  const config = loadConfig();
  const byComponents = useComponents(config);
  const people = byComponents ? await peopleIndex() : null;
  const fills = byComponents ? await showcaseIndex() : null;
  const shops = await shopsIn(region, undefined, from, to);
  const allowed = new Set(shops.map((s) => s.code));
  const inRegion = await regionDayMatcher(region);

  // день → лавка → статусы её критериев
  const byDay = new Map<string, Map<string, Status[]>>();
  for (const c of snap.criteria) {
    if (c.date < from || c.date > to || !allowed.has(c.shopCode) || !inRegion(c.shopCode, c.date)) continue;
    let shopsOfDay = byDay.get(c.date);
    if (!shopsOfDay) byDay.set(c.date, (shopsOfDay = new Map()));
    const list = shopsOfDay.get(c.shopCode);
    if (list) list.push(c.status);
    else shopsOfDay.set(c.shopCode, [c.status]);
  }

  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const [date, shopsOfDay] of byDay) {
    for (const [shopCode, statuses] of shopsOfDay) {
      const key = `${date}|${shopCode}`;
      const { status: s } = byComponents
        ? rateShopDay(people?.get(key) ?? [], fills?.get(key) ?? null, config)
        : aggregateShop(statuses, config);
      if (s === 'green') green++;
      else if (s === 'yellow') yellow++;
      else if (s === 'red') red++;
    }
  }

  const dayCount = Math.max(1, byDay.size);
  return {
    green: Math.round(green / dayCount),
    yellow: Math.round(yellow / dayCount),
    red: Math.round(red / dayCount),
    total: shops.length,
    days: byDay.size,
  };
}

export interface AntiTopRow {
  shop: ShopRow;
  redCount: number;
  criteria: CriterionKey[];
  fill: number | null;
}

/** Анти-топ: лавки с наибольшим числом 🔴 за период. */
export async function antiTop(
  from: string,
  to: string,
  limit = 12,
  region?: string,
): Promise<AntiTopRow[]> {
  const snap = await loadSnapshot();
  const shops = await shopsIn(region, undefined, from, to);
  const byCode = new Map(shops.map((s) => [s.code, s]));
  const inRegion = await regionDayMatcher(region);

  const agg = new Map<string, { redCount: number; criteria: Set<CriterionKey> }>();
  for (const c of snap.criteria) {
    if (c.status !== 'red' || c.date < from || c.date > to || !byCode.has(c.shopCode)) continue;
    if (!inRegion(c.shopCode, c.date)) continue;
    const cur = agg.get(c.shopCode) ?? { redCount: 0, criteria: new Set<CriterionKey>() };
    cur.redCount++;
    cur.criteria.add(c.criterion);
    agg.set(c.shopCode, cur);
  }

  const fillSums = new Map<string, { sum: number; n: number }>();
  for (const s of snap.showcase) {
    if (s.date < from || s.date > to || !byCode.has(s.shopCode) || !inRegion(s.shopCode, s.date)) continue;
    const cur = fillSums.get(s.shopCode) ?? { sum: 0, n: 0 };
    cur.sum += s.fill;
    cur.n++;
    fillSums.set(s.shopCode, cur);
  }

  return [...agg.entries()]
    .map(([code, v]) => {
      const f = fillSums.get(code);
      return {
        shop: byCode.get(code) ?? { code, name: code, region: null },
        redCount: v.redCount,
        criteria: CRITERION_ORDER.filter((c) => v.criteria.has(c)),
        fill: f ? f.sum / f.n : null,
      };
    })
    .sort((a, b) => b.redCount - a.redCount || a.shop.code.localeCompare(b.shop.code))
    .slice(0, limit);
}

/** «Где больше всего западает» — доля 🔴 по каждому критерию за период. */
export async function weakestCriteria(
  from: string,
  to: string,
  region?: string,
): Promise<{ criterion: CriterionKey; red: number; total: number; share: number }[]> {
  const snap = await loadSnapshot();
  const allowed = new Set((await shopsIn(region, undefined, from, to)).map((s) => s.code));
  const inRegion = await regionDayMatcher(region);

  const agg = new Map<CriterionKey, { red: number; total: number }>();
  for (const c of snap.criteria) {
    if (c.date < from || c.date > to || !allowed.has(c.shopCode) || !inRegion(c.shopCode, c.date)) continue;
    if (c.status !== 'red' && c.status !== 'yellow' && c.status !== 'green') continue;

    const cur = agg.get(c.criterion) ?? { red: 0, total: 0 };
    cur.total++;
    if (c.status === 'red') cur.red++;
    agg.set(c.criterion, cur);
  }

  return [...agg.entries()]
    .map(([criterion, v]) => ({
      criterion,
      red: v.red,
      total: v.total,
      share: v.total > 0 ? v.red / v.total : 0,
    }))
    .sort((a, b) => b.share - a.share);
}

/**
 * Средняя наполненность витрины и минимум — как в легаси-«Статистике».
 * `filled` — сколько лавок заполнили таблицу (за период — в среднем за день).
 */
export async function showcaseStats(
  from: string,
  to: string,
  region?: string,
): Promise<{ avg: number | null; min: number | null; minShop: string | null; filled: number }> {
  const snap = await loadSnapshot();
  const shops = await shopsIn(region, undefined, from, to);
  const byCode = new Map(shops.map((s) => [s.code, s]));
  const inRegion = await regionDayMatcher(region);

  const rows = snap.showcase.filter(
    (s) => s.date >= from && s.date <= to && byCode.has(s.shopCode) && inRegion(s.shopCode, s.date),
  );
  if (rows.length === 0) return { avg: null, min: null, minShop: null, filled: 0 };

  const avg = rows.reduce((a, r) => a + r.fill, 0) / rows.length;
  const min = rows.reduce((a, r) => (r.fill < a.fill ? r : a), rows[0]);
  const days = new Set(rows.map((r) => r.date)).size || 1;

  return {
    avg,
    min: min.fill,
    minShop: byCode.get(min.shopCode)?.name ?? min.shopCode,
    filled: Math.round(rows.length / days),
  };
}

/* ----------------------------- карточка лавки ---------------------------- */

export interface ShopDayPerson {
  employeeName: string;
  role: string;
  criterion: CriterionKey | null;
  trainee: boolean;
  arrivalMinutes: number | null;
  arrivalSource: ArrivalSource;
  rawArrival: string | null;
  rawDeparture: string | null;
  homeShopCode: string | null;
  status: Status;
  note: string | null;
}

export interface ShopDay {
  date: string;
  /** РМ, отвечавший за лавку именно в этот день — может отличаться от текущего. */
  region: string | null;
  people: ShopDayPerson[];
  /** Легаси-статусы людей (для дней, где сырых выгрузок нет). */
  legacyPeople: { employeeName: string; criterion: CriterionKey; status: Status }[];
  criteria: {
    criterion: CriterionKey;
    status: Status;
    /** Средний балл сотрудников роли, если критерий свёрнут по среднему. */
    score: number | null;
    origin: CriterionStatusRow['origin'];
  }[];
  fill: number | null;
  shopStatus: Status;
  /** Итоговый балл лавки, если он считается по баллам. */
  shopScore: number | null;
  /** Разбор итога на слагаемые «Водитель + Сотрудники + Витрина»; null — итог считается иначе. */
  rating: ShopRating | null;
}

export async function shopHistory(
  shopCode: string,
  from: string,
  to: string,
): Promise<ShopDay[]> {
  const snap = await loadSnapshot();
  const config = loadConfig();
  const inRange = (d: string): boolean => d >= from && d <= to;
  const shopPeriods = regionIndexOf(snap).get(shopCode);

  const people = snap.attendance.filter((r) => r.shopCode === shopCode && inRange(r.date));
  const legacy = snap.legacyPeople.filter((r) => r.shopCode === shopCode && inRange(r.date));
  const criteria = snap.criteria.filter((c) => c.shopCode === shopCode && inRange(c.date));
  const dayShowcase = snap.showcase.filter((s) => s.shopCode === shopCode && inRange(s.date));
  const fills = new Map(dayShowcase.map((s) => [s.date, s.fill]));
  const showcaseStatuses = new Map(dayShowcase.map((s) => [s.date, s.status]));

  const dates = [
    ...new Set([
      ...people.map((p) => p.date),
      ...legacy.map((p) => p.date),
      ...criteria.map((c) => c.date),
      ...fills.keys(),
    ]),
  ].sort((a, b) => b.localeCompare(a));

  return dates.map((date) => {
    const dayCriteria = criteria
      .filter((c) => c.date === date)
      .sort((a, b) => CRITERION_ORDER.indexOf(a.criterion) - CRITERION_ORDER.indexOf(b.criterion))
      .map((c) => ({
        criterion: c.criterion,
        status: c.status,
        score: c.score ?? null,
        origin: c.origin,
      }));

    const dayPeople = people.filter((x) => x.date === date);
    const dayLegacy = legacy.filter((x) => x.date === date);
    const rating = useComponents(config)
      ? rateShopDay(ratedPeople(dayPeople, dayLegacy), showcaseStatuses.get(date) ?? null, config)
      : null;
    const shop = rating ?? aggregateShop(dayCriteria.map((c) => c.status), config);

    return {
      date,
      region: regionAt(shopPeriods, date),
      people: dayPeople.map((p) => ({
        employeeName: p.employeeName,
        role: p.role,
        criterion: p.criterion,
        trainee: p.trainee,
        arrivalMinutes: p.arrivalMinutes,
        arrivalSource: p.arrivalSource,
        rawArrival: p.rawArrival,
        rawDeparture: p.rawDeparture,
        homeShopCode: p.homeShopCode,
        status: p.status,
        note: p.note,
      })),
      // Критерии, которые за этот день посчитаны по отметкам, из легаси-списка
      // убираем: иначе за 19–21.08 водитель показывался бы дважды — реальным
      // временем из таблицы поставок и раскрашенным вручную статусом.
      legacyPeople: dayLegacy
        .filter((p) => !dayPeople.some((x) => x.criterion === p.criterion))
        .map((p) => ({
          employeeName: p.employeeName,
          criterion: p.criterion,
          status: p.status,
        })),
      criteria: dayCriteria,
      fill: fills.get(date) ?? null,
      shopStatus: shop.status,
      shopScore: shop.score,
      rating,
    };
  });
}
