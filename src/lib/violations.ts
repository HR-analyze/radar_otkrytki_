import { assignCookNorms, statusByNorm } from './norms';
import { scheduleShift, statusForTime } from './status';
import { parseClock } from './time';
import type {
  AttendanceRow,
  ShopNorms,
  Status,
  ThresholdConfig,
} from './types';
import type { DepartureRow } from './parsers/departure';

/**
 * Нарушения открытия: четыре вопроса заказчика, на которые радар отвечает
 * цветом, а здесь — списком.
 *
 *   1. выезд с РЦ позже установленного времени;
 *   2. водитель приехал вовремя, а сотрудника фактически не было
 *      (отметки совпали или разошлись меньше чем на минуту);
 *   3. сотрудник был, а водитель нарушил тайминг приезда в лавку;
 *   4. повар нарушил тайминг прихода в лавку.
 *
 * Почему это не «ещё один радар». Радар красит день лавки и отвечает «как
 * дела». Здесь вопрос другой — «что именно нарушено и кем», и единица не
 * цвет, а случай: строка с фамилией, временем и величиной опоздания.
 *
 * Нормы берутся не из статуса в выгрузке, а считаются на месте по текущему
 * справочнику лавок (`ShopNorms`). Так вкладка показывает ровно те нормы,
 * что видно на «Порогах», и не зависит от того, пересобран ли снимок после
 * последней правки.
 *
 * В сверку идут только живые отметки face id: время из журнала отгрузок и
 * досчёт «уход − 30 минут» восстановлены, а не отмечены, и разница в минутах
 * у них ничего не значит.
 */

export interface ViolationsOptions {
  /**
   * Разрыв, внутри которого отметка сотрудника считается поставленной заодно
   * с отметкой водителя. По умолчанию 60 секунд — «совпали или разошлись
   * меньше чем на минуту».
   */
  staffGapSeconds?: number;
  /**
   * Должности, которые не считаются встречающим сотрудником. По умолчанию
   * берутся из конфига (`rules.violations.openingRolesExclude`).
   */
  openingRolesExclude?: readonly string[];
}

export const DEFAULT_VIOLATIONS_OPTIONS: Required<ViolationsOptions> = {
  staffGapSeconds: 60,
  openingRolesExclude: [],
};

/** «Повар-стажер» и «Повар - стажёр» — одна и та же должность. */
function roleKey(role: string): string {
  return role.toLowerCase().replace(/ё/g, 'е').replace(/[\s\-–—]+/g, '');
}

/** Отметка человека, приведённая к тому, что нужно в отчёте. */
export interface PersonMark {
  name: string;
  role: string;
  /** «06:23:31». */
  time: string;
  /** Минуты от полуночи — для сравнения с нормой. */
  minutes: number;
  seconds: number;
}

/** Опоздавший по своей норме. */
export interface LateMark extends PersonMark {
  /** Норма, с которой сравнивали: «06:20». */
  norm: string;
  /** На сколько минут позже нормы. */
  lateBy: number;
  /** Жёлтая зона или красная — по тем же правилам, что в радаре. */
  status: Extract<Status, 'yellow' | 'red'>;
}

export interface ShopDay {
  date: string;
  shopCode: string;
  shopName: string;
  /** Первая отметка водителя в этой лавке за день. */
  driver: PersonMark | null;
  /** Первая отметка любого сотрудника лавки — повара, кассира, директора. */
  staff: PersonMark | null;
  /**
   * С чем сравнивали приезд водителя: норма лавки, а если её в справочнике
   * нет — сетевой порог критерия. null — отметки водителя за день нет.
   */
  driverNorm: string | null;
  /** Норма своя, из справочника лавок (а не сетевой порог). */
  driverNormFromShop: boolean;
  /** На сколько минут водитель позже нормы; ≤ 0 — приехал вовремя. */
  driverLateBy: number | null;
  /**
   * Зона опоздания водителя по тем же правилам, что в радаре: жёлтая — в
   * пределах шага от нормы, красная — дальше. Нужна, чтобы «опоздал на минуту»
   * и «опоздал на час» не лежали в отчёте одной кучей.
   */
  driverStatus: Status | null;
  /**
   * Разрыв между отметками водителя и первого сотрудника, секунды.
   * Положительный — сотрудник отметился позже водителя.
   */
  staffGapSeconds: number | null;
  /**
   * Водителя в лавке никто не встретил: первая отметка сотрудника — позже
   * его собственной. null — сравнивать не с чем (нет одной из отметок).
   *
   * Отметка «секунда в секунду» — тот же случай: два человека у одного
   * терминала так не попадают, значит сотрудник отметился заодно с водителем.
   */
  staffMissing: boolean | null;
  /**
   * Отметки водителя и сотрудника легли друг на друга (разрыв меньше порога).
   * Частный и самый заметный случай «никто не встретил».
   */
  staffMarkedTogether: boolean | null;
  /** Повара, нарушившие свою норму, от худшего к лучшему. */
  lateCooks: LateMark[];
  /** У лавки другой график или смена не первая — день из счёта исключён. */
  skipped: boolean;
}

export type ViolationKind =
  /** 2. Водитель вовремя, сотрудника фактически не было. */
  | 'driver_on_time_no_staff'
  /** 2б. Сотрудника не было, и водитель при этом опоздал. */
  | 'no_staff_driver_late'
  /** 3. Сотрудник был, водитель опоздал. */
  | 'driver_late'
  /** 4. Повар опоздал. */
  | 'cook_late';

export const VIOLATION_TITLES: Record<ViolationKind, string> = {
  driver_on_time_no_staff: 'Водитель вовремя, сотрудника не было',
  no_staff_driver_late: 'Сотрудника не было, и водитель опоздал',
  driver_late: 'Сотрудник есть — водитель опоздал',
  cook_late: 'Повар нарушил тайминг',
};

/** Что именно нарушено в этом лавко-дне; пусто — нарушений нет. */
export function kindsOf(day: ShopDay): ViolationKind[] {
  if (day.skipped) return [];
  const kinds: ViolationKind[] = [];
  const driverLate = day.driverLateBy != null && day.driverLateBy > 0;

  if (day.staffMissing) {
    kinds.push(driverLate ? 'no_staff_driver_late' : 'driver_on_time_no_staff');
  } else if (driverLate) {
    kinds.push('driver_late');
  }
  if (day.lateCooks.length > 0) kinds.push('cook_late');

  return kinds;
}

export interface ViolationsSummary {
  /** Лавко-дни, где было что проверять. */
  checked: number;
  /** Из них — дни без единой живой отметки водителя. */
  noDriverMark: number;
  byKind: Record<ViolationKind, number>;
  /** Из опозданий водителя (пункты 2б и 3) — те, что попали в красную зону. */
  driverLateRed: number;
  /** Опоздавших поваров всего — это люди, а не лавко-дни. */
  lateCooks: number;
  /** Из них — в красной зоне. */
  lateCooksRed: number;
}

export interface ViolationsGroup {
  key: string;
  title: string;
  /** Лавко-дней (для водителя — его приездов) в знаменателе. */
  days: number;
  byKind: Record<ViolationKind, number>;
  /** Сумма нарушений — по ней и сортировка. */
  total: number;
}

export interface ViolationsReport {
  from: string;
  to: string;
  options: Required<ViolationsOptions>;
  days: ShopDay[];
  summary: ViolationsSummary;
  byShop: ViolationsGroup[];
  byDriver: ViolationsGroup[];
  byDate: ViolationsGroup[];
}

interface Mark {
  row: AttendanceRow;
  seconds: number;
}

export function analyzeViolations(
  rows: readonly AttendanceRow[],
  norms: Readonly<Record<string, ShopNorms>>,
  config: ThresholdConfig,
  from: string,
  to: string,
  options: ViolationsOptions = {},
): ViolationsReport {
  const opts: Required<ViolationsOptions> = {
    staffGapSeconds:
      options.staffGapSeconds ??
      config.rules.violations?.staffGapSeconds ??
      DEFAULT_VIOLATIONS_OPTIONS.staffGapSeconds,
    openingRolesExclude:
      options.openingRolesExclude ?? config.rules.violations?.openingRolesExclude ?? [],
  };
  const excluded = new Set(opts.openingRolesExclude.map(roleKey));

  const byShopDay = new Map<string, Mark[]>();
  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    if (row.arrivalSource !== 'mark') continue;
    const seconds = markSeconds(row);
    if (seconds == null || row.arrivalMinutes == null) continue;
    const key = `${row.date}|${row.shopCode}`;
    const list = byShopDay.get(key);
    if (list) list.push({ row, seconds });
    else byShopDay.set(key, [{ row, seconds }]);
  }

  const days: ShopDay[] = [];

  for (const key of [...byShopDay.keys()].sort()) {
    const marks = byShopDay.get(key)!;
    const first = marks[0].row;
    const norm = norms[first.shopCode] ?? null;

    const driverMark = earliest(marks.filter((m) => m.row.criterion === 'driver'));
    // Сотрудник — кто угодно, кроме водителя и должностей из исключений:
    // раньше повара к терминалу подходят и кассир, и директор, и лавку
    // открывает тот, кто пришёл первым. Уборщик в этот список не входит: он
    // приходит к своей уборке и товар не принимает (см. rules.violations).
    const staffMark = earliest(
      marks.filter((m) => m.row.criterion !== 'driver' && !excluded.has(roleKey(m.row.role))),
    );

    const driverStatus = driverMark
      ? statusOf(driverMark.row, 'driver', norm?.driverAt ?? null, config)
      : null;
    // Граница: норма лавки, а если её в справочнике нет — сетевой порог. Так
    // же поступает норм-проход снимка, и лавка без нормы не выпадает из счёта.
    const driverBoundary = norm?.driverAt ?? timeCriterionGreenUntil(config, 'driver');
    const driverLateBy =
      driverMark && driverStatus !== 'other_schedule'
        ? driverMark.row.arrivalMinutes! -
          (parseClock(driverBoundary) + shiftOf(config, first.shopCode))
        : null;

    // Знак важен: «сотрудник отметился на 17 минут позже водителя» и «на 17
    // минут раньше» — это разные дни, и раньше знак терялся в модуле.
    const gap = driverMark && staffMark ? staffMark.seconds - driverMark.seconds : null;

    days.push({
      date: first.date,
      shopCode: first.shopCode,
      shopName: first.shopName,
      driver: driverMark ? personOf(driverMark) : null,
      staff: staffMark ? personOf(staffMark) : null,
      driverNorm: driverMark ? driverBoundary : null,
      driverNormFromShop: norm?.driverAt != null,
      driverLateBy,
      driverStatus,
      staffGapSeconds: gap,
      // Водителя никто не встретил: сотрудник отметился позже него — или
      // одновременно, что значит «отметился заодно», а не «был на месте».
      staffMissing: gap == null ? null : gap > -opts.staffGapSeconds,
      staffMarkedTogether: gap == null ? null : Math.abs(gap) < opts.staffGapSeconds,
      lateCooks: lateCooksOf(marks, norm, config),
      // «Другой график» — не нарушение: это вторая смена, а не опоздание.
      skipped: driverStatus === 'other_schedule' || driverMark == null,
    });
  }

  return {
    from,
    to,
    options: opts,
    days,
    summary: summarize(days),
    byShop: group(days, (d) => d.shopCode, (d) => `${d.shopCode} ${stripCode(d.shopName)}`),
    byDriver: group(
      days.filter((d) => d.driver),
      (d) => d.driver!.name,
      (d) => d.driver!.name,
    ),
    byDate: group(days, (d) => d.date, (d) => d.date),
  };
}

/**
 * Опоздавшие повара лавки за день.
 *
 * Норма у поваров не одна: «1 с 6:00, 2 с 6:30» значит, что к 6:00 лавку
 * открывает первый, а к 6:30 она укомплектована. Кто из них кто, справочник
 * не знает — сопоставление живёт в norms.ts и используется здесь, чтобы
 * вкладка и радар считали опоздание одинаково.
 */
function lateCooksOf(
  marks: readonly Mark[],
  norm: ShopNorms | null,
  config: ThresholdConfig,
): LateMark[] {
  const cooks = marks
    .filter((m) => m.row.criterion === 'cook')
    .sort((a, b) => a.seconds - b.seconds);
  if (cooks.length === 0) return [];

  const plan = norm?.cookAt ?? [];
  const assigned = assignCookNorms(
    cooks.map((c) => c.row.arrivalMinutes),
    plan,
  );

  const late: LateMark[] = [];
  cooks.forEach((cook, i) => {
    const normAt = assigned[i];
    const status = statusOf(cook.row, 'cook', normAt, config);
    if (status !== 'yellow' && status !== 'red') return;

    const shift = shiftOf(config, cook.row.shopCode);
    // Нормы у лавки нет — границей служит сетевой порог критерия «Повар».
    const networkNorm = timeCriterionGreenUntil(config, 'cook');
    const boundary = (normAt ? parseClock(normAt) : parseClock(networkNorm)) + shift;

    late.push({
      ...personOf(cook),
      norm: normAt ?? networkNorm,
      lateBy: cook.row.arrivalMinutes! - boundary,
      status,
    });
  });

  return late.sort((a, b) => b.lateBy - a.lateBy);
}

/**
 * Статус отметки: по норме лавки, если она есть, иначе по сетевому порогу.
 *
 * Правило то же, что в норм-проходе снимка (`applyShopNorms`): лавка без
 * нормы считается по общим порогам, а не выпадает из счёта.
 */
function statusOf(
  row: AttendanceRow,
  criterion: 'driver' | 'cook',
  normAt: string | null,
  config: ThresholdConfig,
): Status {
  return normAt
    ? statusByNorm(row.arrivalMinutes, normAt, config, 0)
    : statusForTime(row.arrivalMinutes, criterion, config, row.shopCode);
}

/** Граница зелёной зоны сетевого порога: у временных критериев она есть всегда. */
function timeCriterionGreenUntil(config: ThresholdConfig, criterion: 'driver' | 'cook'): string {
  const cfg = config.criteria[criterion];
  return cfg && cfg.kind === 'time' ? cfg.greenUntil : '06:29';
}

/** Сдвиг порогов у лавки с поздним открытием. */
function shiftOf(config: ThresholdConfig, shopCode: string): number {
  return scheduleShift(config, shopCode);
}

function summarize(days: readonly ShopDay[]): ViolationsSummary {
  const byKind: Record<ViolationKind, number> = {
    driver_on_time_no_staff: 0,
    no_staff_driver_late: 0,
    driver_late: 0,
    cook_late: 0,
  };
  let checked = 0;
  let noDriverMark = 0;
  let lateCooks = 0;
  let lateCooksRed = 0;
  let driverLateRed = 0;

  for (const day of days) {
    if (day.driver == null) noDriverMark += 1;
    if (day.skipped) continue;
    checked += 1;
    for (const kind of kindsOf(day)) byKind[kind] += 1;
    if (day.driverStatus === 'red') driverLateRed += 1;
    lateCooks += day.lateCooks.length;
    lateCooksRed += day.lateCooks.filter((c) => c.status === 'red').length;
  }

  return { checked, noDriverMark, byKind, driverLateRed, lateCooks, lateCooksRed };
}

function group(
  days: readonly ShopDay[],
  keyOf: (d: ShopDay) => string,
  titleOf: (d: ShopDay) => string,
): ViolationsGroup[] {
  const map = new Map<string, ViolationsGroup>();

  for (const day of days) {
    if (day.skipped) continue;
    const key = keyOf(day);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        title: titleOf(day),
        days: 0,
        byKind: {
          driver_on_time_no_staff: 0,
          no_staff_driver_late: 0,
          driver_late: 0,
          cook_late: 0,
        },
        total: 0,
      };
      map.set(key, g);
    }
    g.days += 1;
    for (const kind of kindsOf(day)) {
      g.byKind[kind] += 1;
      g.total += 1;
    }
  }

  return [...map.values()].sort(
    (a, b) => b.total - a.total || a.key.localeCompare(b.key),
  );
}

/* ------------------------- выезд с РЦ (пункт 1) --------------------------- */

export interface DepartureViolation {
  date: string;
  employeeName: string;
  /** «05:42» — время убытия с РЦ. */
  time: string;
  minutes: number;
  /** Норматив, с которым сравнивали: «03:50». */
  norm: string;
  /** Откуда норматив: из справочника лавки или сетевое правило. */
  normSource: 'shop' | 'network';
  /** Первая лавка маршрута, если её удалось определить: «М1 Милютинский». */
  shop: string | null;
  /** На сколько минут позже норматива. */
  lateBy: number;
  status: Extract<Status, 'yellow' | 'red'>;
}

export interface DeparturesReport {
  /** Выездов с живой отметкой — знаменатель. */
  checked: number;
  /** Сетевой норматив из конфига — запасной, когда лавку определить не вышло. */
  greenUntil: string;
  yellowUntil: string;
  /** Скольким выездам норматив достался от лавки, а не сетевой. */
  byShopNorm: number;
  yellow: number;
  red: number;
  late: DepartureViolation[];
  /** Есть ли вообще выгрузка по РЦ за период. */
  hasData: boolean;
}

/**
 * Выезды с РЦ позже установленного времени.
 *
 * Норматив выезда свой у каждой лавки («Выезд с РЦ» в справочнике): у
 * Милютинского это 3:50, у Николоямской — 5:40, потому что и путь от РЦ
 * разный. Сравнивать все выезды с одним сетевым порогом — значит записывать
 * в нарушители того, кто едет дальше всех.
 *
 * Какая лавка «своя» для выезда. В выгрузке по РЦ лавки нет — там только
 * водитель и время. Но тот же водитель в тот же день отмечается в лавках, и
 * первая его отметка — это первая точка маршрута: именно к ней он и выезжал.
 * По ней и берётся норматив. Где связать не вышло (водитель РЦ в лавках не
 * отмечался), остаётся сетевое правило `rules.driverDeparture` — и в отчёте
 * видно, какой норматив применён.
 *
 * Жёлтая и красная зона считаются от применённого норматива тем же шагом, что
 * задан сетевым правилом: от «до 04:59 / до 05:29» это 30 минут.
 */
export function analyzeDepartures(
  rows: readonly DepartureRow[],
  attendance: readonly AttendanceRow[],
  norms: Readonly<Record<string, ShopNorms>>,
  config: ThresholdConfig,
  from: string,
  to: string,
): DeparturesReport {
  const rule = config.rules.driverDeparture;
  const greenUntil = rule?.greenUntil ?? '04:59';
  const yellowUntil = rule?.yellowUntil ?? '05:29';
  const networkGreen = parseClock(greenUntil);
  const redStep = Math.max(parseClock(yellowUntil) - networkGreen, 0);

  const firstStop = firstStopByDriver(attendance, from, to);

  const inPeriod = rows.filter((r) => r.date >= from && r.date <= to);
  const withMark = inPeriod.filter((r) => r.departureMinutes != null);

  const late: DepartureViolation[] = [];
  let byShopNorm = 0;

  for (const row of withMark) {
    const stop = firstStop.get(`${row.date}|${row.employeeName}`);
    const shopNorm = stop ? norms[stop.shopCode]?.departureAt ?? null : null;
    if (shopNorm) byShopNorm += 1;

    const boundary = shopNorm ? parseClock(shopNorm) : networkGreen;
    const minutes = row.departureMinutes!;
    if (minutes <= boundary) continue;

    late.push({
      date: row.date,
      employeeName: row.employeeName,
      time: formatMinutes(minutes),
      minutes,
      norm: shopNorm ?? greenUntil,
      normSource: shopNorm ? 'shop' : 'network',
      shop: stop?.shopName ?? null,
      lateBy: minutes - boundary,
      status: minutes - boundary <= redStep ? 'yellow' : 'red',
    });
  }

  late.sort((a, b) => b.lateBy - a.lateBy || a.date.localeCompare(b.date));

  return {
    checked: withMark.length,
    greenUntil,
    yellowUntil,
    byShopNorm,
    yellow: late.filter((l) => l.status === 'yellow').length,
    red: late.filter((l) => l.status === 'red').length,
    late,
    hasData: inPeriod.length > 0,
  };
}

/**
 * Первая лавка маршрута каждого водителя по дням.
 *
 * Ключ — «дата|фамилия»: связать выезд с лавкой больше не по чему, маршрутных
 * листов в радаре нет.
 */
function firstStopByDriver(
  attendance: readonly AttendanceRow[],
  from: string,
  to: string,
): Map<string, { shopCode: string; shopName: string; seconds: number }> {
  const stops = new Map<string, { shopCode: string; shopName: string; seconds: number }>();

  for (const row of attendance) {
    if (row.criterion !== 'driver') continue;
    if (row.date < from || row.date > to) continue;
    if (row.arrivalSource !== 'mark') continue;
    const seconds = markSeconds(row);
    if (seconds == null) continue;

    const key = `${row.date}|${row.employeeName}`;
    const known = stops.get(key);
    if (!known || seconds < known.seconds) {
      stops.set(key, { shopCode: row.shopCode, shopName: row.shopName, seconds });
    }
  }

  return stops;
}

/* -------------------------------- мелочи ---------------------------------- */

function personOf(mark: Mark): PersonMark {
  return {
    name: mark.row.employeeName,
    role: mark.row.role,
    time: formatSeconds(mark.seconds),
    minutes: mark.row.arrivalMinutes!,
    seconds: mark.seconds,
  };
}

/**
 * Секунды от полуночи из сырой отметки «25.08.2026 6:25:29».
 *
 * Берём именно `rawArrival`, а не `arrivalMinutes`: минуты округлены, и две
 * отметки в 6:02:25 и 6:02:43 стали бы «одним временем» — а здесь как раз
 * важна секундная разница.
 */
export function markSeconds(row: AttendanceRow): number | null {
  const raw = row.rawArrival?.trim();
  if (!raw) return null;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(raw);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

function earliest(marks: readonly Mark[]): Mark | null {
  let best: Mark | null = null;
  for (const m of marks) if (!best || m.seconds < best.seconds) best = m;
  return best;
}

export function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

export function formatMinutes(minutes: number): string {
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/** «+12 мин» — опоздание; «0 мин» — ровно в норму. */
export function formatLate(minutes: number): string {
  return minutes > 0 ? `+${minutes} мин` : `${minutes} мин`;
}

/** «М24 Стремянный» → «Стремянный»: код и так стоит первой колонкой. */
function stripCode(name: string): string {
  return name.replace(/^М\d+\s*/, '').trim() || name;
}

/**
 * Нарушения таблицей для Excel: разделитель `;` и BOM — иначе Excel открывает
 * файл одной колонкой и ломает кириллицу.
 *
 * Одна строка — одно нарушение, а не один лавко-день: в пункте 4 в один день
 * могут опоздать двое, и склеивать их в ячейку значит лишить файл фильтров,
 * ради которых его и открывают.
 */
export function toCsv(report: ViolationsReport, departures: DeparturesReport): string {
  const head = [
    'Пункт',
    'Нарушение',
    'Дата',
    'Код лавки',
    'Лавка',
    'Кто',
    'Должность',
    'Норма',
    'Отметка',
    'Опоздание, мин',
    'Сотрудник позже водителя, сек',
  ];

  const rows: string[][] = [];

  for (const l of departures.late) {
    rows.push([
      '1',
      'Выезд с РЦ позже норматива',
      l.date,
      '',
      l.shop ? `РЦ → ${l.shop}` : 'РЦ',
      l.employeeName,
      'Водитель',
      l.normSource === 'shop' ? l.norm : `${l.norm} (сеть)`,
      l.time,
      String(l.lateBy),
      '',
    ]);
  }

  for (const day of report.days) {
    for (const kind of kindsOf(day)) {
      if (kind === 'cook_late') continue; // повара идут отдельными строками ниже
      rows.push([
        kind === 'driver_late' ? '3' : '2',
        VIOLATION_TITLES[kind],
        day.date,
        day.shopCode,
        day.shopName,
        day.driver?.name ?? '',
        day.driver?.role ?? '',
        day.driverNorm ?? '',
        day.driver?.time ?? '',
        day.driverLateBy != null && day.driverLateBy > 0 ? String(day.driverLateBy) : '',
        day.staffGapSeconds == null ? '' : String(day.staffGapSeconds),
      ]);
    }

    if (day.skipped) continue;
    for (const cook of day.lateCooks) {
      rows.push([
        '4',
        VIOLATION_TITLES.cook_late,
        day.date,
        day.shopCode,
        day.shopName,
        cook.name,
        cook.role,
        cook.norm,
        cook.time,
        String(cook.lateBy),
        '',
      ]);
    }
  }

  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

function csvCell(v: string): string {
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}
