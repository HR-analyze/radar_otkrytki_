import { loadConfig } from './config';
import { loadSnapshot, type ImportRunSummary, type Snapshot } from './snapshot';
import { CRITERION_ORDER, type CriterionKey, type Status, type ThresholdConfig } from './types';
import { aggregateStatuses } from './status';

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
 * (`rules.shopAggregation`). 'worstOfConfirmed' отличается от 'worst' не
 * способом свёртки, а набором критериев — он отсеивается раньше, при выборке.
 */
function aggregateShop(
  statuses: readonly Status[],
  config: ThresholdConfig,
): { status: Status; score: number | null } {
  const strategy = config.rules.shopAggregation.strategy;
  return aggregateStatuses(statuses, strategy === 'average' ? 'average' : 'worst', config);
}

/* ------------------------------- справочники ----------------------------- */

export async function listShops(): Promise<ShopRow[]> {
  const s = await loadSnapshot();
  return [...s.shops].sort(byShopNumber);
}

export async function listRegions(): Promise<string[]> {
  const s = await loadSnapshot();
  const regions = new Set<string>();
  for (const shop of s.shops) if (shop.region) regions.add(shop.region);
  return [...regions].sort((a, b) => a.localeCompare(b, 'ru'));
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

async function shopsIn(region?: string): Promise<ShopRow[]> {
  const shops = await listShops();
  return region ? shops.filter((s) => s.region === region) : shops;
}

/* --------------------------------- радар --------------------------------- */

export interface RadarFilters {
  from: string;
  to: string;
  region?: string;
  criterion?: CriterionKey | 'all';
  status?: Status | 'all';
}

export interface RadarCell {
  status: Status;
  origin: 'computed' | 'legacy';
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

  const shops = await shopsIn(filters.region);
  const allowedShops = new Set(shops.map((s) => s.code));

  const relevant = snap.criteria.filter(
    (c) =>
      c.date >= filters.from &&
      c.date <= filters.to &&
      allowedShops.has(c.shopCode) &&
      (!filters.criterion || filters.criterion === 'all' || c.criterion === filters.criterion) &&
      (!onlyConfirmed || config.criteria[c.criterion]?.confirmed),
  );

  const dates = [...new Set(relevant.map((c) => c.date))].sort();
  // Ни одного дня с данными — строки без единой ячейки показывать незачем.
  if (dates.length === 0) return { dates, rows: [] };

  const byShop = new Map<string, Map<string, { statuses: Status[]; origin: 'computed' | 'legacy' }>>();
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
      const { status } = aggregateShop(cell.statuses, config);
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
  const shops = await shopsIn(region);
  const allowed = new Set(shops.map((s) => s.code));

  // критерий → день → статус → множество лавок
  const perDay = new Map<CriterionKey, Map<string, Map<Status, Set<string>>>>();
  const days = new Set<string>();

  for (const c of snap.criteria) {
    if (c.date < from || c.date > to || !allowed.has(c.shopCode)) continue;
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
  const shops = await shopsIn(region);
  const allowed = new Set(shops.map((s) => s.code));

  // день → лавка → статусы её критериев
  const byDay = new Map<string, Map<string, Status[]>>();
  for (const c of snap.criteria) {
    if (c.date < from || c.date > to || !allowed.has(c.shopCode)) continue;
    let shopsOfDay = byDay.get(c.date);
    if (!shopsOfDay) byDay.set(c.date, (shopsOfDay = new Map()));
    const list = shopsOfDay.get(c.shopCode);
    if (list) list.push(c.status);
    else shopsOfDay.set(c.shopCode, [c.status]);
  }

  let green = 0;
  let yellow = 0;
  let red = 0;
  for (const shopsOfDay of byDay.values()) {
    for (const statuses of shopsOfDay.values()) {
      const { status: s } = aggregateShop(statuses, config);
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
  const shops = await shopsIn(region);
  const byCode = new Map(shops.map((s) => [s.code, s]));

  const agg = new Map<string, { redCount: number; criteria: Set<CriterionKey> }>();
  for (const c of snap.criteria) {
    if (c.status !== 'red' || c.date < from || c.date > to || !byCode.has(c.shopCode)) continue;
    const cur = agg.get(c.shopCode) ?? { redCount: 0, criteria: new Set<CriterionKey>() };
    cur.redCount++;
    cur.criteria.add(c.criterion);
    agg.set(c.shopCode, cur);
  }

  const fillSums = new Map<string, { sum: number; n: number }>();
  for (const s of snap.showcase) {
    if (s.date < from || s.date > to || !byCode.has(s.shopCode)) continue;
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
  const allowed = new Set((await shopsIn(region)).map((s) => s.code));

  const agg = new Map<CriterionKey, { red: number; total: number }>();
  for (const c of snap.criteria) {
    if (c.date < from || c.date > to || !allowed.has(c.shopCode)) continue;
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
  const shops = await shopsIn(region);
  const byCode = new Map(shops.map((s) => [s.code, s]));

  const rows = snap.showcase.filter(
    (s) => s.date >= from && s.date <= to && byCode.has(s.shopCode),
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
  arrivalSource: 'mark' | 'derived_minus30' | 'none';
  rawArrival: string | null;
  rawDeparture: string | null;
  homeShopCode: string | null;
  status: Status;
  note: string | null;
}

export interface ShopDay {
  date: string;
  people: ShopDayPerson[];
  /** Легаси-статусы людей (для дней, где сырых выгрузок нет). */
  legacyPeople: { employeeName: string; criterion: CriterionKey; status: Status }[];
  criteria: {
    criterion: CriterionKey;
    status: Status;
    /** Средний балл сотрудников роли, если критерий свёрнут по среднему. */
    score: number | null;
    origin: 'computed' | 'legacy';
  }[];
  fill: number | null;
  shopStatus: Status;
  /** Средний балл критериев, если статус лавки свёрнут по среднему. */
  shopScore: number | null;
}

export async function shopHistory(
  shopCode: string,
  from: string,
  to: string,
): Promise<ShopDay[]> {
  const snap = await loadSnapshot();
  const config = loadConfig();
  const inRange = (d: string): boolean => d >= from && d <= to;

  const people = snap.attendance.filter((r) => r.shopCode === shopCode && inRange(r.date));
  const legacy = snap.legacyPeople.filter((r) => r.shopCode === shopCode && inRange(r.date));
  const criteria = snap.criteria.filter((c) => c.shopCode === shopCode && inRange(c.date));
  const fills = new Map(
    snap.showcase
      .filter((s) => s.shopCode === shopCode && inRange(s.date))
      .map((s) => [s.date, s.fill]),
  );

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

    const shop = aggregateShop(
      dayCriteria.map((c) => c.status),
      config,
    );

    return {
      date,
      people: people
        .filter((p) => p.date === date)
        .map((p) => ({
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
      legacyPeople: legacy
        .filter((p) => p.date === date)
        .map((p) => ({
          employeeName: p.employeeName,
          criterion: p.criterion,
          status: p.status,
        })),
      criteria: dayCriteria,
      fill: fills.get(date) ?? null,
      shopStatus: shop.status,
      shopScore: shop.score,
    };
  });
}
