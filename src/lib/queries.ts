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
import { aggregateStatuses, roundScore, statusFromScore } from './status';
import { parseClock } from './time';
import { isExactCode, matchesShop } from './shops';
import { rateShopDay, type RatedPerson, type ShopRating } from './rating';
import type { DepartureRow } from './parsers/departure';
import {
  addStatus,
  averagePoints,
  emptyScore,
  pointsOf,
  sumScores,
  type ContestScore,
} from './contest';

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

/**
 * Дни, за которые в радаре есть хоть что-то.
 *
 * Не только дни со статусами лавок: выезд с РЦ — сетевой показатель, и его
 * выгрузку заливают отдельно от отметок. Пока сюда шли одни статусы, день,
 * за который приехал только файл по РЦ, не попадал ни в период по умолчанию
 * (см. defaultRange), ни в подсветку календаря — загруженные выезды просто
 * не показывались, и это выглядело как потерянный файл.
 */
export async function listDates(): Promise<string[]> {
  const s = await loadSnapshot();
  return [...new Set([...s.criteria.map((c) => c.date), ...s.departures.map((d) => d.date)])].sort();
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
 * Поиск лавки по коду или названию живёт в shops.ts: то же правило нужно
 * клиентскому переключателю лавки, а queries тянет за собой снимок и БД.
 * Реэкспорт — чтобы страницы и тесты не расходились в том, откуда его брать.
 */
export { matchesShop };

/** Есть ли лавка, чей код совпал с запросом точно. */
export async function hasExactShop(query: string): Promise<boolean> {
  return (await listShops()).some((s) => isExactCode(s, query));
}

/**
 * Фильтры сводки — те же пять полей, что в шапке радара.
 *
 * Объектом, а не хвостом позиционных аргументов (как у радара и конкурса):
 * иначе `antiTop(from, to, 12, region, shop, criterion)` читался бы только
 * со счётом на пальцах.
 */
export interface SummaryFilters {
  from: string;
  to: string;
  region?: string;
  /** Код или часть названия лавки: «М17», «Сухаревский». */
  shop?: string;
  /**
   * Считать по одному критерию вместо агрегата лавки. 'all' либо пусто —
   * агрегат. Из интерфейса агрегат больше не приходит (пункт «Все» убран из
   * фильтра, см. Filters), но сам расчёт остаётся: им пользуются тесты и
   * карточка лавки.
   */
  criterion?: CriterionKey | 'all';
  /** Оставить лавки, у которых за период есть день в этом статусе. */
  status?: Status | 'all';
}

/** Выбранный критерий или null, если смотрим лавку целиком. */
function singleCriterion(f: { criterion?: CriterionKey | 'all' }): CriterionKey | null {
  return f.criterion && f.criterion !== 'all' ? f.criterion : null;
}

/**
 * Лавки под фильтрами «РМ» и «Лавка», с приоритетом точного кода: «М1» — это
 * М1, а не М1 вместе с М10–М19. Одна функция на радар, конкурс и сводку —
 * раньше эти четыре строки были скопированы в каждый запрос.
 */
async function shopsMatching(
  region: string | undefined,
  shop: string | undefined,
  from: string,
  to: string,
): Promise<ShopRow[]> {
  const list = await shopsIn(region, shop, from, to);
  if (!shop) return list;

  const exact = await hasExactShop(shop);
  return exact ? list.filter((s) => isExactCode(s, shop)) : list;
}

/**
 * Лавки под всеми фильтрами сводки, включая «Статус».
 *
 * Статуса лавки за день в снимке нет — он получается свёрткой критериев (или
 * равен одному критерию, если тот выбран). Поэтому набор лавок под фильтром
 * по статусу берём у самого радара: «есть красные дни» на сводке тогда значит
 * ровно то же, что в его таблице, и разъехаться эти два ответа не могут.
 */
async function shopsUnderFilters(f: SummaryFilters): Promise<ShopRow[]> {
  const list = await shopsMatching(f.region, f.shop, f.from, f.to);
  if (!f.status || f.status === 'all') return list;

  const { rows } = await radar(f);
  const allowed = new Set(rows.map((r) => r.shop.code));
  return list.filter((s) => allowed.has(s.code));
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
  /**
   * Дней с оценкой у этой лавки — знаменатель для redCount.
   * Дни без данных сюда не попадают: «3 из 4» честнее, чем «3 из 8»,
   * если четыре дня лавку просто не оценивали.
   */
  ratedCount: number;
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

  const shops = await shopsMatching(filters.region, filters.shop, filters.from, filters.to);
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
    rows.push({ shop, cells, redCount, ratedCount: Object.keys(cells).length });
  }

  return { dates, rows };
}

/* ------------------------------- конкурс --------------------------------- */

export interface ContestFilters {
  from: string;
  to: string;
  region?: string;
  /** Код или часть названия лавки — тот же поиск, что в радаре. */
  shop?: string;
}

export interface ContestCell {
  status: Status;
  /** Наполнение витрины 0–1 в этот день. */
  fill: number;
  /** Балл дня: +1 / 0 / −1. */
  points: number;
}

export interface ContestRow {
  shop: ShopRow;
  /** дата → ячейка. Дни без заполненной витрины сюда не попадают. */
  cells: Record<string, ContestCell>;
  score: ContestScore;
  /** Средняя наполненность за оценённые дни; null — дней нет. */
  avgFill: number | null;
}

export interface ContestRegionRow {
  region: string;
  /** Лавок с оценёнными днями у этого РМ. */
  shops: number;
  score: ContestScore;
  avgFill: number | null;
}

/**
 * Конкурс по наполнению витрин: та же таблица «лавки × дни», что и радар, но
 * единственный критерий — витрина, а в итоге баллы (🟢 +1, 🟡 0, 🔴 −1), а не
 * число красных. Правило считает contest.ts.
 *
 * Источник — `snap.showcase`: там и процент, и статус по действующим порогам.
 * Через `snap.criteria` идти незачем — статусы витрины приходят туда из того же
 * стора (см. showcase-store.ts), но без процента.
 *
 * День лавки относится к тому РМ, который вёл её в этот день (regionAt), а не
 * к нынешнему: иначе после передачи лавки чужие дни утекали бы в статистику
 * преемника.
 */
export async function contest(
  filters: ContestFilters,
): Promise<{
  dates: string[];
  rows: ContestRow[];
  regions: ContestRegionRow[];
  total: ContestScore;
}> {
  const snap = await loadSnapshot();

  const shops = await shopsMatching(filters.region, filters.shop, filters.from, filters.to);
  const allowedShops = new Set(shops.map((s) => s.code));
  const inRegion = await regionDayMatcher(filters.region);

  const relevant = snap.showcase.filter(
    (s) =>
      s.date >= filters.from &&
      s.date <= filters.to &&
      allowedShops.has(s.shopCode) &&
      inRegion(s.shopCode, s.date) &&
      pointsOf(s.status) != null,
  );

  const dates = [...new Set(relevant.map((s) => s.date))].sort();
  if (dates.length === 0) return { dates, rows: [], regions: [], total: emptyScore() };

  const byShop = new Map<string, Map<string, ContestCell>>();
  for (const s of relevant) {
    let days = byShop.get(s.shopCode);
    if (!days) byShop.set(s.shopCode, (days = new Map()));
    days.set(s.date, { status: s.status, fill: s.fill, points: pointsOf(s.status)! });
  }

  const history = regionIndexOf(snap);
  const regions = new Map<string, { score: ContestScore; fill: number; shops: Set<string> }>();

  const rows: ContestRow[] = [];
  for (const shop of shops) {
    const days = byShop.get(shop.code);
    if (!days) continue;

    const cells: Record<string, ContestCell> = {};
    const score = emptyScore();
    let fillSum = 0;

    for (const date of dates) {
      const cell = days.get(date);
      if (!cell) continue;
      cells[date] = cell;
      addStatus(score, cell.status);
      fillSum += cell.fill;

      const manager = regionAt(history.get(shop.code), date) ?? shop.region;
      if (!manager) continue;
      let bucket = regions.get(manager);
      if (!bucket) regions.set(manager, (bucket = { score: emptyScore(), fill: 0, shops: new Set() }));
      addStatus(bucket.score, cell.status);
      bucket.fill += cell.fill;
      bucket.shops.add(shop.code);
    }

    if (score.rated === 0) continue;
    rows.push({ shop, cells, score, avgFill: fillSum / score.rated });
  }

  // Больше баллов — выше; при равенстве вперёд тот, у кого меньше красных, а
  // затем — у кого больше оценённых дней: за 0 из двух дней и 0 из двадцати
  // стоят разные усилия.
  rows.sort(
    (a, b) =>
      b.score.points - a.score.points ||
      a.score.red - b.score.red ||
      b.score.rated - a.score.rated ||
      byShopNumber(a.shop, b.shop),
  );

  const regionRows: ContestRegionRow[] = [...regions.entries()]
    .map(([region, v]) => ({
      region,
      shops: v.shops.size,
      score: v.score,
      avgFill: v.score.rated > 0 ? v.fill / v.score.rated : null,
    }))
    // Сумма баллов у РМ с двенадцатью лавками всегда больше, чем у РМ с
    // четырьмя, поэтому сортируем по среднему баллу за день.
    .sort(
      (a, b) =>
        (averagePoints(b.score) ?? -Infinity) - (averagePoints(a.score) ?? -Infinity) ||
        b.score.points - a.score.points ||
        a.region.localeCompare(b.region, 'ru'),
    );

  return {
    dates,
    rows,
    regions: regionRows,
    total: sumScores(rows.map((r) => r.score)),
  };
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
export async function summaryByCriterion(f: SummaryFilters): Promise<CriterionSummary[]> {
  const { from, to } = f;
  const snap = await loadSnapshot();
  // Фильтр «Критерий» здесь не применяется намеренно: это разрез по всем
  // шести, и сузить его до одного значило бы оставить блок с одной плиткой.
  const shops = await shopsUnderFilters(f);
  const allowed = new Set(shops.map((s) => s.code));
  const inRegion = await regionDayMatcher(f.region);

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
export async function shopTotals(f: SummaryFilters): Promise<ShopTotals> {
  const { from, to } = f;
  const snap = await loadSnapshot();
  const config = loadConfig();
  // Выбран критерий — плитки считаются по нему, а не по агрегату лавки:
  // ровно так же, как ячейки радара под тем же фильтром.
  const single = singleCriterion(f);
  const byComponents = !single && useComponents(config);
  const people = byComponents ? await peopleIndex() : null;
  const fills = byComponents ? await showcaseIndex() : null;
  const shops = await shopsUnderFilters(f);
  const allowed = new Set(shops.map((s) => s.code));
  const inRegion = await regionDayMatcher(f.region);

  // день → лавка → статусы её критериев
  const byDay = new Map<string, Map<string, Status[]>>();
  for (const c of snap.criteria) {
    if (single && c.criterion !== single) continue;
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
export async function antiTop(f: SummaryFilters, limit = 12): Promise<AntiTopRow[]> {
  const { from, to } = f;
  const snap = await loadSnapshot();
  const single = singleCriterion(f);
  const shops = await shopsUnderFilters(f);
  const byCode = new Map(shops.map((s) => [s.code, s]));
  const inRegion = await regionDayMatcher(f.region);

  const agg = new Map<string, { redCount: number; criteria: Set<CriterionKey> }>();
  for (const c of snap.criteria) {
    if (single && c.criterion !== single) continue;
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

export interface BestShopRow {
  shop: ShopRow;
  /** Зелёных ячеек за период. */
  greenCount: number;
  /** Всего оценённых ячеек — знаменатель доли. */
  total: number;
  /** Доля зелёных, 0–1. */
  share: number;
  /** Среднее наполнение витрины за период. */
  fill: number | null;
}

/**
 * Топ: лавки с наибольшей долей 🟢 за период.
 *
 * Считается доля, а не число зелёных. У лавок разное количество оценённых
 * ячеек — на реальных данных от 24 до 62 за две недели, потому что различается
 * штат и число рабочих дней. По абсолютному счёту в топ выходили лавки покрупнее
 * с посредственными 70% зелёных, обгоняя тех, у кого 92%.
 *
 * Лавки, по которым данных за период почти нет, в топ не берём: «1 из 1 = 100%»
 * — не достижение. Порог — половина медианы по сети: медиана устойчива к
 * выбросам, а половина оставляет в списке и тех, кто работал не все дни.
 */
export async function bestShops(f: SummaryFilters, limit = 12): Promise<BestShopRow[]> {
  const { from, to } = f;
  const snap = await loadSnapshot();
  const single = singleCriterion(f);
  const shops = await shopsUnderFilters(f);
  const byCode = new Map(shops.map((s) => [s.code, s]));
  const inRegion = await regionDayMatcher(f.region);

  const agg = new Map<string, { green: number; total: number }>();
  for (const c of snap.criteria) {
    if (single && c.criterion !== single) continue;
    if (c.date < from || c.date > to || !byCode.has(c.shopCode)) continue;
    if (!inRegion(c.shopCode, c.date)) continue;
    // Считаем только оценённое: «нет данных» и «другой график» — не результат.
    if (c.status !== 'green' && c.status !== 'yellow' && c.status !== 'red') continue;

    const cur = agg.get(c.shopCode) ?? { green: 0, total: 0 };
    cur.total++;
    if (c.status === 'green') cur.green++;
    agg.set(c.shopCode, cur);
  }
  if (agg.size === 0) return [];

  const totals = [...agg.values()].map((v) => v.total).sort((a, b) => a - b);
  const median = totals[Math.floor(totals.length / 2)];
  const enough = median / 2;

  const fillSums = new Map<string, { sum: number; n: number }>();
  for (const s of snap.showcase) {
    if (s.date < from || s.date > to || !byCode.has(s.shopCode) || !inRegion(s.shopCode, s.date)) continue;
    const cur = fillSums.get(s.shopCode) ?? { sum: 0, n: 0 };
    cur.sum += s.fill;
    cur.n++;
    fillSums.set(s.shopCode, cur);
  }

  return [...agg.entries()]
    .filter(([, v]) => v.total >= enough)
    .map(([code, v]) => {
      const f = fillSums.get(code);
      return {
        shop: byCode.get(code) ?? { code, name: code, region: null },
        greenCount: v.green,
        total: v.total,
        share: v.green / v.total,
        fill: f ? f.sum / f.n : null,
      };
    })
    // При равной доле выше тот, у кого данных больше: 46 из 50 убедительнее 6 из 6.
    .sort(
      (a, b) =>
        b.share - a.share || b.total - a.total || a.shop.code.localeCompare(b.shop.code),
    )
    .slice(0, limit);
}

/** «Где больше всего западает» — доля 🔴 по каждому критерию за период. */
export async function weakestCriteria(
  f: SummaryFilters,
): Promise<{ criterion: CriterionKey; red: number; total: number; share: number }[]> {
  const { from, to } = f;
  const snap = await loadSnapshot();
  // Как и в summaryByCriterion, фильтр «Критерий» здесь не применяется: блок
  // отвечает на вопрос «какой критерий западает», а не «как дела у выбранного».
  const allowed = new Set((await shopsUnderFilters(f)).map((s) => s.code));
  const inRegion = await regionDayMatcher(f.region);

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
  f: SummaryFilters,
): Promise<{ avg: number | null; min: number | null; minShop: string | null; filled: number }> {
  const { from, to } = f;
  const snap = await loadSnapshot();
  const shops = await shopsUnderFilters(f);
  const byCode = new Map(shops.map((s) => [s.code, s]));
  const inRegion = await regionDayMatcher(f.region);

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

/* ----------------------------- выезд с РЦ -------------------------------- */

export interface DepartureDay {
  date: string;
  green: number;
  yellow: number;
  red: number;
  /** Строк без отметки ухода: выезд по ним неизвестен. */
  unknown: number;
  /** Медиана выезда, минуты от полуночи. null — выездов за день нет. */
  median: number | null;
  /** Медиана времени на фабрике, минуты. null — не из чего считать. */
  medianStay: number | null;
  /** Средний балл за убытие: 🟢 3 · 🟡 2 · 🔴 1. */
  score: number | null;
  /** Зона по среднему баллу — по тем же границам, что и у лавок. */
  status: Status;
}

/** Один выезд: то, что стоит в клетке детализации и на карточке лавки. */
export interface DepartureTrip {
  /** Склад, с которого выехал: «РЦ Свобода». */
  unit: string;
  /** Минуты от полуночи. null — приход на РЦ есть, а ухода нет. */
  minutes: number | null;
  /** Время на фабрике, минуты. null — не из чего считать. */
  stay: number | null;
  /** Зона выезда; no_data — когда ухода нет. */
  status: Status;
  /** Балл за этот выезд: 3 / 2 / 1. null — выезда нет. */
  score: number | null;
}

/** Строка детализации: кто какой балл получил. */
export interface DepartureDriver {
  employeeName: string;
  /** Оценённых выездов — тех, где отметка ухода есть. */
  trips: number;
  green: number;
  yellow: number;
  red: number;
  /** Строк без ухода: выезд по ним неизвестен. */
  unknown: number;
  /** Средний балл водителя за период. */
  score: number | null;
  status: Status;
  /** Медиана времени на фабрике по его выездам. */
  medianStay: number | null;
  /** Выезды по дням. Нет ключа — в этот день не отмечался. */
  days: Record<string, DepartureTrip[]>;
}

export interface DepartureSummary {
  /** Склады из выгрузки: «РЦ Свобода». */
  units: string[];
  days: DepartureDay[];
  /** Кто выехал позже жёлтой границы — поимённо, свежее сверху. */
  late: { date: string; employeeName: string; minutes: number; stay: number | null }[];
  green: number;
  yellow: number;
  red: number;
  unknown: number;
  /** Медиана времени на фабрике за весь период, минуты. */
  medianStay: number | null;
  /** Средний балл за убытие по всем выездам периода. */
  score: number | null;
  /** Зона по этому баллу. */
  status: Status;
  /**
   * Детализация: кто какой балл получил, худшие сверху. Считается в том же
   * проходе, что и сводка, — отдельный запрос ради раскрытого блока был бы
   * вторым чтением тех же строк.
   */
  drivers: DepartureDriver[];
}

/** Время на фабрике: уход минус приход. Обе отметки — одного дня. */
function stayOf(r: { arrivalMinutes: number | null; departureMinutes: number | null }): number | null {
  return r.arrivalMinutes != null &&
    r.departureMinutes != null &&
    r.departureMinutes >= r.arrivalMinutes
    ? r.departureMinutes - r.arrivalMinutes
    : null;
}

/**
 * Правило выезда с РЦ: как один выезд превращается в зону и балл.
 *
 * Одно на всех, кто его применяет: сетевой блок на сводке и справка на
 * карточке лавки. Разъедься они — на одном экране один и тот же выезд был бы
 * жёлтым, на другом красным.
 *
 * null — правила в конфиге нет.
 */
function departureRule(config: ThresholdConfig) {
  const rule = config.rules.driverDeparture;
  if (!rule) return null;

  const green = parseClock(rule.greenUntil);
  const yellow = parseClock(rule.yellowUntil);
  const zones = config.rules.scoreZones;

  /**
   * Границы включительные: выехавший ровно в 05:30 — уже красный. Поэтому в
   * конфиге yellowUntil = 05:29, а не 05:30.
   */
  const zoneOf = (minutes: number): { status: 'green' | 'yellow' | 'red'; score: number } =>
    minutes <= green
      ? { status: 'green', score: zones.green }
      : minutes <= yellow
        ? { status: 'yellow', score: zones.yellow }
        : { status: 'red', score: zones.red };

  /** Строка выгрузки → выезд. Нет отметки ухода — выезд неизвестен. */
  const tripOf = (r: DepartureRow): DepartureTrip => {
    const stay = stayOf(r);
    if (r.departureMinutes == null) {
      return { unit: r.unit, minutes: null, stay, status: 'no_data', score: null };
    }
    const zone = zoneOf(r.departureMinutes);
    return { unit: r.unit, minutes: r.departureMinutes, stay, ...zone };
  };

  return { zoneOf, tripOf };
}

/**
 * Выезд с РЦ за период — сетевой показатель.
 *
 * К лавкам он не привязан: в выгрузке их нет, а водители РЦ и водители,
 * отмечающиеся в лавках, — почти разные люди (см. parsers/departure.ts).
 * Поэтому это отдельный блок, а не критерий лавки.
 */
export async function departureSummary(from: string, to: string): Promise<DepartureSummary | null> {
  const snap = await loadSnapshot();
  const rows = snap.departures.filter((d) => d.date >= from && d.date <= to);
  if (rows.length === 0) return null;

  const config = loadConfig();
  const rule = departureRule(config);
  if (!rule) return null;
  const zones = config.rules.scoreZones;

  // Статус считается уже по собранному баллу, поэтому в накопителе его нет.
  type Bucket = Omit<DepartureDay, 'status'> & {
    times: number[];
    stays: number[];
    scores: number[];
  };
  const byDate = new Map<string, Bucket>();
  const late: DepartureSummary['late'] = [];

  // Детализация по людям. Один водитель может выехать дважды за день (в
  // выгрузке такое есть), поэтому в клетке лежит список выездов, а не один.
  type DriverBucket = Omit<DepartureDriver, 'score' | 'status' | 'medianStay'> & {
    stays: number[];
    scores: number[];
  };
  const byDriver = new Map<string, DriverBucket>();

  for (const r of rows) {
    let day = byDate.get(r.date);
    if (!day) {
      day = {
        date: r.date,
        green: 0,
        yellow: 0,
        red: 0,
        unknown: 0,
        median: null,
        medianStay: null,
        score: null,
        times: [],
        stays: [],
        scores: [],
      };
      byDate.set(r.date, day);
    }

    let driver = byDriver.get(r.employeeName);
    if (!driver) {
      driver = {
        employeeName: r.employeeName,
        trips: 0,
        green: 0,
        yellow: 0,
        red: 0,
        unknown: 0,
        days: {},
        stays: [],
        scores: [],
      };
      byDriver.set(r.employeeName, driver);
    }
    const cell = (driver.days[r.date] ??= []);

    const trip = rule.tripOf(r);
    cell.push(trip);

    if (trip.stay != null) {
      day.stays.push(trip.stay);
      driver.stays.push(trip.stay);
    }

    if (trip.minutes == null || trip.score == null) {
      day.unknown++;
      driver.unknown++;
      continue;
    }

    day.times.push(trip.minutes);
    day.scores.push(trip.score);
    driver.trips++;
    driver.scores.push(trip.score);

    if (trip.status === 'green' || trip.status === 'yellow' || trip.status === 'red') {
      day[trip.status]++;
      driver[trip.status]++;
    }

    if (trip.status === 'red') {
      late.push({
        date: r.date,
        employeeName: r.employeeName,
        minutes: trip.minutes,
        stay: trip.stay,
      });
    }
  }

  const median = (xs: readonly number[]): number | null =>
    xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null;
  const mean = (xs: readonly number[]): number | null =>
    xs.length ? roundScore(xs.reduce((a, b) => a + b, 0) / xs.length, zones.precision) : null;

  const days = [...byDate.values()]
    .map(({ times, stays, scores, ...day }) => {
      const score = mean(scores);
      return {
        ...day,
        median: median(times),
        medianStay: median(stays),
        score,
        status: statusFromScore(score, config),
      };
    })
    .sort((a, b) => a.date.localeCompare(b.date));

  // Худшие сверху: детализацию открывают, чтобы найти, с кем разговаривать.
  // Кто ни разу не выехал (только приход), уходит в конец — балла у него нет.
  const drivers = [...byDriver.values()]
    .map(({ stays, scores, ...d }) => {
      const driverScore = mean(scores);
      return {
        ...d,
        score: driverScore,
        status: statusFromScore(driverScore, config),
        medianStay: median(stays),
      };
    })
    .sort(
      (a, b) =>
        (a.score ?? Infinity) - (b.score ?? Infinity) ||
        b.red - a.red ||
        a.employeeName.localeCompare(b.employeeName, 'ru'),
    );

  const allStays = rows.map(stayOf).filter((x): x is number => x != null);
  const allScores = [...byDate.values()].flatMap((d) => d.scores);
  const score = mean(allScores);

  return {
    units: [...new Set(rows.map((r) => r.unit))].sort(),
    days,
    late: late.sort((a, b) => b.date.localeCompare(a.date) || b.minutes - a.minutes),
    green: days.reduce((n, d) => n + d.green, 0),
    yellow: days.reduce((n, d) => n + d.yellow, 0),
    red: days.reduce((n, d) => n + d.red, 0),
    unknown: days.reduce((n, d) => n + d.unknown, 0),
    medianStay: median(allStays),
    score,
    status: statusFromScore(score, config),
    drivers,
  };
}

/* --------------------------- комментарии витрин --------------------------- */

export interface ShowcaseNote {
  date: string;
  shopCode: string;
  shopName: string;
  /** РМ, отвечавший за лавку в этот день (см. roster-history.ts). */
  region: string | null;
  /** Наполнение за тот же день — null, если его не заполняли. */
  percent: number | null;
  note: string;
}

/**
 * Комментарии к лавкам за период — свод для вкладки «Витрины».
 *
 * Читаются из базы ручных данных напрямую, а не из снимка: в расчётах они не
 * участвуют, печь их в снимок незачем.
 */
export async function showcaseNotes(from: string, to: string): Promise<ShowcaseNote[]> {
  const snap = await loadSnapshot();
  const { readShowcase } = await import('./showcase-store');
  const store = await readShowcase();

  const byCode = new Map(snap.shops.map((s) => [s.code, s]));
  const regions = regionIndexOf(snap);
  const fills = new Map(snap.showcase.map((s) => [`${s.date}|${s.shopCode}`, s.fill]));

  const out: ShowcaseNote[] = [];
  for (const [date, byShop] of Object.entries(store.notes)) {
    if (date < from || date > to) continue;

    for (const [shopCode, note] of Object.entries(byShop)) {
      if (!note.trim()) continue;
      const fill = fills.get(`${date}|${shopCode}`);

      out.push({
        date,
        shopCode,
        shopName: byCode.get(shopCode)?.name ?? shopCode,
        region: regionAt(regions.get(shopCode), date),
        percent: fill == null ? null : Math.round(fill * 100),
        note,
      });
    }
  }

  // Свежее сверху, внутри дня — по номеру лавки: так же, как везде в радаре.
  return out.sort(
    (a, b) => b.date.localeCompare(a.date) || shopNumber(a.shopCode) - shopNumber(b.shopCode),
  );
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
  /**
   * Выезды этого же человека с РЦ в этот день — справочно.
   *
   * Связь одна: полное совпадение ФИО в выгрузке по РЦ и в выгрузке отметок
   * (форматы имён там одинаковые, «Фамилия Имя Отчество»). Ни лавки, ни
   * маршрута в выгрузке по РЦ нет, поэтому утверждать, что человек выехал
   * ИМЕННО в эту лавку, нельзя — цифра стоит рядом как справка и в статус
   * лавки не входит.
   *
   * Пустой список — человека в выгрузке по РЦ за этот день нет.
   */
  departures: DepartureTrip[];
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
  /**
   * Склады, по которым за этот день есть выгрузка выездов: «РЦ Свобода».
   *
   * Пустой список — выгрузки за день нет вовсе, и это не то же самое, что
   * «водитель не отметился»: в первом случае радар не знает, во втором знает,
   * что отметки не было. Смешать их значило бы обвинить человека в том, чего
   * мы не проверяли.
   */
  departureUnits: string[];
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

  // Выезды с РЦ по ФИО и дню: справка в строке сотрудника. Совпадение по
  // полному имени — фамилии мало, в выгрузках есть разные Егоровы и Смирновы.
  const rule = departureRule(config);
  const departures = new Map<string, DepartureTrip[]>();
  const departureUnits = new Map<string, Set<string>>();
  if (rule) {
    for (const r of snap.departures) {
      if (!inRange(r.date)) continue;
      const key = `${r.date}|${r.employeeName.trim()}`;
      (departures.get(key) ?? departures.set(key, []).get(key)!).push(rule.tripOf(r));
      (departureUnits.get(r.date) ?? departureUnits.set(r.date, new Set()).get(r.date)!).add(r.unit);
    }
  }
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
        departures: departures.get(`${p.date}|${p.employeeName.trim()}`) ?? [],
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
      departureUnits: [...(departureUnits.get(date) ?? [])].sort(),
    };
  });
}
