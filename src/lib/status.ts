import type {
  AggregationStrategy,
  ArrivalSource,
  CriterionConfig,
  CriterionKey,
  RoleMapEntry,
  ShopSchedule,
  Status,
  ThresholdConfig,
} from './types';
import { parseClock, parseStamp } from './time';

export const STATUS_LABEL: Record<Status, string> = {
  green: '🟢 Зелёная',
  yellow: '🟡 Жёлтая',
  red: '🔴 Красная',
  other_schedule: '⚪ Другой график',
  no_data: '⬜ Нет данных',
};

export const STATUS_EMOJI: Record<Status, string> = {
  green: '🟢',
  yellow: '🟡',
  red: '🔴',
  other_schedule: '⚪',
  no_data: '⬜',
};

/** Легаси-лист «Все данные» хранит статусы эмодзи — читаем их как есть. */
export function statusFromEmoji(value: unknown): Status | null {
  const s = String(value ?? '').trim();
  if (s.startsWith('🟢')) return 'green';
  if (s.startsWith('🟡')) return 'yellow';
  if (s.startsWith('🔴')) return 'red';
  return null;
}

/** Порядок «плохости» для агрегации: чем больше, тем хуже. */
const SEVERITY: Record<Status, number> = {
  no_data: -1,
  other_schedule: -1,
  green: 0,
  yellow: 1,
  red: 2,
};

/**
 * Балл статуса для агрегации по среднему: 🟢 3, 🟡 2, 🔴 1.
 * Нейтральные статусы балла не имеют и в среднее не входят — как и в worstStatus.
 */
export const STATUS_SCORE: Record<Status, number | null> = {
  green: 3,
  yellow: 2,
  red: 1,
  other_schedule: null,
  no_data: null,
};

/**
 * Худший статус побеждает. Нейтральные статусы (другой график, нет данных)
 * в агрегат не входят — если кроме них ничего нет, вернётся no_data.
 */
export function worstStatus(statuses: readonly Status[]): Status {
  let best: Status = 'no_data';
  for (const s of statuses) {
    if (SEVERITY[s] < 0) continue;
    if (SEVERITY[s] > SEVERITY[best] || SEVERITY[best] < 0) best = s;
  }
  return best;
}

/** Входит ли статус в агрегаты 🔴/🟡/🟢. */
export function countsInAggregate(status: Status): boolean {
  return SEVERITY[status] >= 0;
}

/**
 * Средний балл по статусам: 🟢 3, 🟡 2, 🔴 1. Округляется до знаков,
 * заданных в конфиге (по умолчанию 2) — заказчик считает так же, руками:
 * «3+3+1 = 7/3 = 2,33».
 *
 * null — считать не из чего: только нейтральные статусы либо пусто.
 */
export function averageScore(
  statuses: readonly Status[],
  config: ThresholdConfig,
): number | null {
  let sum = 0;
  let n = 0;
  for (const s of statuses) {
    const score = STATUS_SCORE[s];
    if (score == null) continue;
    sum += score;
    n++;
  }
  return n === 0 ? null : roundScore(sum / n, config.rules.scoreZones.precision);
}

/**
 * Зона по среднему баллу. Подтверждено заказчиком 27.08.2026:
 * 0–1,9 🔴, 1,91–2,6 🟡, 2,61–3 🟢.
 *
 * Границы включительные и заданы по верхнему краю зоны, поэтому «дырок»
 * между 1,9 и 1,91 нет: балл сначала округляется до сотых (ровно как в
 * сообщении заказчика), и уже округлённое значение попадает в зону.
 */
export function statusFromScore(score: number | null, config: ThresholdConfig): Status {
  if (score == null || Number.isNaN(score)) return 'no_data';
  const zones = config.rules.scoreZones;
  const rounded = roundScore(score, zones.precision);
  if (rounded <= zones.redUntil) return 'red';
  if (rounded <= zones.yellowUntil) return 'yellow';
  return 'green';
}

/** Округление «как в калькуляторе»: 2.335 → 2.34, без сюрпризов двоичной дроби. */
export function roundScore(value: number, precision: number): number {
  const k = 10 ** precision;
  return Math.round((value + Number.EPSILON) * k) / k;
}

export interface Aggregate {
  status: Status;
  /** Средний балл, если агрегировали по нему; иначе null. */
  score: number | null;
}

/**
 * Единая точка агрегации статусов — и для сотрудников внутри критерия,
 * и для критериев внутри лавки. Какую стратегию применить, решает конфиг
 * (`rules.criterionAggregation` / `rules.shopAggregation`).
 *
 *   worst   — худший статус побеждает (исходное правило ТЗ);
 *   average — средний балл 🟢3/🟡2/🔴1 → зона по rules.scoreZones.
 */
export function aggregateStatuses(
  statuses: readonly Status[],
  strategy: AggregationStrategy,
  config: ThresholdConfig,
): Aggregate {
  if (strategy !== 'average') return { status: worstStatus(statuses), score: null };

  const score = averageScore(statuses, config);
  // Считать не из чего (пусто или одни нейтральные) — ведём себя как worst.
  if (score == null) return { status: worstStatus(statuses), score: null };
  return { status: statusFromScore(score, config), score };
}

/** Должность из выгрузки → критерий + признак стажёра. */
export function mapRole(
  role: string | null | undefined,
  config: ThresholdConfig,
): RoleMapEntry | null {
  if (!role) return null;
  const normalized = String(role).trim();
  const direct = config.roleMap[normalized];
  if (direct) return direct;

  // Должности в 1С пишут по-разному: «Кассир - стажер» / «Кассир-стажер» / «кассир стажёр».
  const key = normalizeRoleKey(normalized);
  for (const [candidate, entry] of Object.entries(config.roleMap)) {
    if (normalizeRoleKey(candidate) === key) return entry;
  }
  return null;
}

/**
 * Должность есть в выгрузке, но ни к одному критерию радара не относится
 * (уборщик, директор). Отличать её от незаведённой важно: вторая — пробел в
 * настройке, и о ней надо сказать вслух, а первая — норма.
 */
export function isIgnoredRole(
  role: string | null | undefined,
  config: ThresholdConfig,
): boolean {
  if (!role) return false;
  const key = normalizeRoleKey(String(role).trim());
  return (config.ignoredRoles ?? []).some((r) => normalizeRoleKey(r) === key);
}

function normalizeRoleKey(s: string): string {
  return s.toLowerCase().replace(/ё/g, 'е').replace(/[\s\-–—]+/g, '');
}

export interface ArrivalResolution {
  /** Минуты от полуночи; null — отметки нет. */
  minutes: number | null;
  source: ArrivalSource;
  note: string | null;
}

/**
 * Алгоритм п.5 ТЗ: как получить время прихода, когда отметки неполные.
 *
 * 1. Есть «Приход» → используем его.
 * 2. Нет «Прихода», есть «Уход» → приход = Уход − 30 мин (время приёмки),
 *    но только если результат попадает в окно правдоподобия. Ночные уходы
 *    (в тестовой выгрузке 0:19, 1:51 — это конец вчерашней смены) через это
 *    окно не проходят и остаются «нет отметки».
 * 3. Нет ничего → «нет отметки».
 */
export function resolveArrival(
  rawArrival: unknown,
  rawDeparture: unknown,
  config: ThresholdConfig,
): ArrivalResolution {
  const arrival = parseStamp(rawArrival);
  if (arrival) return { minutes: arrival.minutes, source: 'mark', note: null };

  const rule = config.rules.derivedArrival;
  const departure = parseStamp(rawDeparture);
  if (!rule.enabled || !departure) {
    return { minutes: null, source: 'none', note: null };
  }

  const derived = departure.minutes - rule.minutesBeforeDeparture;
  const from = parseClock(rule.plausibleWindow.from);
  const to = parseClock(rule.plausibleWindow.to);
  if (derived < from || derived > to) {
    return {
      minutes: null,
      source: 'none',
      note:
        `Есть «Уход», но расчётный приход вне окна правдоподобия ` +
        `(${rule.plausibleWindow.from}–${rule.plausibleWindow.to}) — вероятно, конец ночной смены.`,
    };
  }

  return {
    minutes: derived,
    source: 'derived_minus30',
    note: `Прихода нет, время досчитано: уход − ${rule.minutesBeforeDeparture} мин (приёмка).`,
  };
}

/**
 * Особый график лавки — см. ThresholdConfig.shopSchedules.
 *
 * Ключи на `$` — комментарии внутри конфига (так заведено во всём файле), а не
 * коды лавок: без этой проверки `$comment` принимался за лавку без времени
 * открытия и ронял расчёт.
 */
export function scheduleFor(
  config: ThresholdConfig,
  shopCode?: string,
): ShopSchedule | undefined {
  if (!shopCode || shopCode.startsWith('$')) return undefined;

  const schedule = config.shopSchedules?.[shopCode];
  return schedule && typeof schedule.opensAt === 'string' ? schedule : undefined;
}

/** Все лавки с особым графиком: код и график, без служебных ключей конфига. */
export function listSchedules(config: ThresholdConfig): { code: string; schedule: ShopSchedule }[] {
  return Object.keys(config.shopSchedules ?? {})
    .map((code) => ({ code, schedule: scheduleFor(config, code) }))
    .filter((x): x is { code: string; schedule: ShopSchedule } => x.schedule !== undefined)
    .sort((a, b) => a.code.localeCompare(b.code, 'ru'));
}

/**
 * На сколько минут сдвинуть пороги для этой лавки.
 *
 * Пороги заданы абсолютным временем и рассчитаны на обычное открытие в 08:00.
 * Лавка, открывающаяся в 10:00, работает на два часа позже — и оценивать её
 * надо на два часа позже, иначе она вечно красная за своё расписание.
 */
export function scheduleShift(config: ThresholdConfig, shopCode?: string): number {
  const schedule = scheduleFor(config, shopCode);
  if (!schedule) return 0;

  const network = config.rules.opensAt?.network;
  if (!network) return 0;

  return parseClock(schedule.opensAt) - parseClock(network);
}

/**
 * Статус по времени прихода для конкретного критерия.
 *
 * `shopCode` нужен из-за лавок с особым графиком: М71 и М72 открываются с
 * 10:00, и общие пороги делали их вечно красными за то, что они работают по
 * своему расписанию.
 */
export function statusForTime(
  minutes: number | null,
  criterion: CriterionKey,
  config: ThresholdConfig,
  shopCode?: string,
): Status {
  if (minutes == null) return 'red'; // п.5.1 ТЗ: нет отметки → красный, без исключений

  const shift = scheduleShift(config, shopCode);

  // п.5.0: правило «другой график» выполняется раньше остальных. Для лавки с
  // особым графиком порог едет вместе с открытием: приход в 09:00 в лавке,
  // открывающейся в 10:00, — это рано, а не «другой график».
  const other = config.rules.otherSchedule;
  if (other.enabled && minutes > parseClock(other.after) + shift) return 'other_schedule';

  const cfg = config.criteria[criterion];
  if (!cfg || cfg.kind !== 'time') return 'no_data';

  if (minutes <= parseClock(cfg.greenUntil) + shift) return 'green';
  if (minutes <= parseClock(cfg.yellowUntil) + shift) return 'yellow';
  return 'red';
}

/** Статус наполнения витрины. Принимает и 0–1, и 0–100. */
export function statusForFill(fill: number | null, config: ThresholdConfig): Status {
  if (fill == null || Number.isNaN(fill)) return 'no_data';
  const cfg = config.criteria.showcase;
  if (cfg.kind !== 'percent') return 'no_data';

  const share = normalizeFill(fill);
  if (share >= cfg.greenFrom) return 'green';
  if (share >= cfg.yellowFrom) return 'yellow';
  return 'red';
}

/** Google-таблицу заполняют руками: где-то «95», где-то «0.95». */
export function normalizeFill(value: number): number {
  return value > 1.0000001 ? value / 100 : value;
}

export function criterionTitle(key: CriterionKey, config: ThresholdConfig): string {
  return config.criteria[key]?.title ?? key;
}

export function isConfirmed(key: CriterionKey, config: ThresholdConfig): boolean {
  return config.criteria[key]?.confirmed ?? false;
}

export function criterionConfig(
  key: CriterionKey,
  config: ThresholdConfig,
): CriterionConfig | undefined {
  return config.criteria[key];
}
