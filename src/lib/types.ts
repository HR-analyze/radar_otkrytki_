/** Доменные типы радара открытий. */

export type Status = 'green' | 'yellow' | 'red' | 'other_schedule' | 'no_data';

/** Критерии, по которым считается статус лавки за день. */
export type CriterionKey =
  | 'driver'
  | 'cook'
  | 'cashier'
  | 'barista'
  | 'hallDeputy'
  | 'showcase';

export const CRITERION_ORDER: CriterionKey[] = [
  'driver',
  'cook',
  'cashier',
  'barista',
  'hallDeputy',
  'showcase',
];

/** Как получено время прихода — видно в drill-down, чтобы отличить опоздание от досчёта. */
export type ArrivalSource =
  /** Реальная отметка «Приход». */
  | 'mark'
  /** Расчёт: «Уход» − 30 минут (приёмка). */
  | 'derived_minus30'
  /** Отметки face id нет — время приезда взято из книги «Время поставки». */
  | 'delivery'
  /** Отметок нет вообще, либо «Уход» вне окна правдоподобия. */
  | 'none';

export interface TimeCriterionConfig {
  title: string;
  kind: 'time';
  /** Включительно: t <= greenUntil → 🟢 */
  greenUntil: string;
  /** Включительно: greenUntil < t <= yellowUntil → 🟡 */
  yellowUntil: string;
  confirmed: boolean;
  note: string;
}

export interface PercentCriterionConfig {
  title: string;
  kind: 'percent';
  /** Включительно: v >= greenFrom → 🟢 */
  greenFrom: number;
  /** Включительно: v >= yellowFrom → 🟡 */
  yellowFrom: number;
  confirmed: boolean;
  note: string;
}

export type CriterionConfig = TimeCriterionConfig | PercentCriterionConfig;

export interface RoleMapEntry {
  criterion: CriterionKey;
  trainee: boolean;
}

/**
 * Как свернуть несколько статусов в один.
 *   worst   — худший побеждает;
 *   average — средний балл 🟢3/🟡2/🔴1 → зона по rules.scoreZones.
 *
 * У агрегации лавки есть ещё два варианта (см. ThresholdConfig.rules):
 *   components       — методология заказчика: (водитель + сотрудники + витрина) / 3,
 *                      сотрудники усредняются по людям (см. rating.ts);
 *   worstOfConfirmed — тот же worst, но только по подтверждённым критериям.
 */
export type AggregationStrategy = 'worst' | 'average';

/** Зоны по среднему баллу. Границы включительные, заданы по верхнему краю. */
export interface ScoreZonesConfig {
  /** Балл 🟢. */
  green: number;
  /** Балл 🟡. */
  yellow: number;
  /** Балл 🔴. */
  red: number;
  /** Включительно: score <= redUntil → 🔴 */
  redUntil: number;
  /** Включительно: redUntil < score <= yellowUntil → 🟡, выше → 🟢 */
  yellowUntil: number;
  /** До скольких знаков округляется балл перед сравнением с границами. */
  precision: number;
  confirmed: boolean;
  note: string;
}

/** Особый график лавки — см. ThresholdConfig.shopSchedules. */
export interface ShopSchedule {
  /** Во сколько открывается эта лавка, «10:00». */
  opensAt: string;
  note: string;
}

export interface ThresholdConfig {
  version: number;
  updatedAt: string;
  criteria: Record<CriterionKey, CriterionConfig>;
  roleMap: Record<string, RoleMapEntry>;
  /**
   * Должности, которые в выгрузке есть, но ни к одному критерию не относятся
   * (уборщик, директор). Нужны, чтобы отличать «должность вне радара» от
   * «должность забыли завести в roleMap»: второе — повод поправить конфиг.
   */
  ignoredRoles?: string[];
/**
   * Лавки, которые открываются не в общее время (`rules.opensAt`). Ключ — код
   * лавки (М71).
   *
   * Пороги в `criteria` заданы абсолютным временем и рассчитаны на обычное
   * открытие. Для такой лавки они сдвигаются на разницу во времени открытия:
   * лавка, открывающаяся на два часа позже, и оценивается на два часа позже —
   * иначе она была бы вечно красной за то, что работает по своему расписанию.
   */
  shopSchedules?: Record<string, ShopSchedule>;
  rules: {
    /** Обычное время открытия лавки — база, от которой считается сдвиг порогов. */
    opensAt?: { network: string; note: string };
    otherSchedule: {
      enabled: boolean;
      after: string;
      confirmed: boolean;
      note: string;
    };
    /**
     * Согласованная, но ещё не включённая замена критерия «приезд водителя»:
     * считать выезд с ФК Свобода. Ждёт выгрузку — см. note.
     */
    driverDeparture?: {
      enabled: boolean;
      greenUntil: string;
      yellowUntil: string;
      confirmed: boolean;
      note: string;
    };
    derivedArrival: {
      enabled: boolean;
      minutesBeforeDeparture: number;
      plausibleWindow: { from: string; to: string };
      note: string;
    };
    shopField: {
      use: 'Подразделение' | 'Подразделение сотрудника';
      confirmed: boolean;
      note: string;
    };
    scoreZones: ScoreZonesConfig;
    shopAggregation: {
      strategy: AggregationStrategy | 'components' | 'worstOfConfirmed';
      confirmed: boolean;
      note: string;
    };
    criterionAggregation: { strategy: AggregationStrategy; note: string };
  };
}

/** Строка отметки, как она легла в БД. */
export interface AttendanceRow {
  date: string;
  shopCode: string;
  shopName: string;
  employeeName: string;
  role: string;
  criterion: CriterionKey | null;
  trainee: boolean;
  homeShopCode: string | null;
  /** Минуты от полуночи; null — если отметки нет. */
  arrivalMinutes: number | null;
  arrivalSource: ArrivalSource;
  rawArrival: string | null;
  rawDeparture: string | null;
  status: Status;
  note: string | null;
}

export interface ShowcaseRow {
  date: string;
  shopCode: string;
  /** Доля 0–1. */
  fill: number;
  status: Status;
}

/** Статус критерия у лавки за день. */
export interface CriterionStatusRow {
  date: string;
  shopCode: string;
  criterion: CriterionKey;
  status: Status;
  /**
   * Средний балл сотрудников этой роли (🟢3/🟡2/🔴1), из которого получен статус.
   * null — агрегировали не по среднему (стратегия worst) либо считать было не из чего.
   */
  score: number | null;
  /** 'computed' — посчитано из сырых выгрузок; 'legacy' — импортировано из Витрины.xlsx как есть. */
  /**
   * computed — посчитано из выгрузки, legacy — раскрашено руками в книге
   * «Витрины», manual — введено на сайте (вкладка «Витрины»).
   */
  origin: 'computed' | 'legacy' | 'manual';
}

export interface Shop {
  code: string;
  name: string;
  region: string | null;
}

/**
 * Один период, когда лавкой управлял конкретный РМ — см. roster-history.ts.
 * Уходящий менеджер не стирается из истории: закрывается его период, а новый
 * открывается с даты смены, поэтому старые дни остаются под прежним именем.
 */
export interface RegionPeriod {
  shopCode: string;
  manager: string;
  /** YYYY-MM-DD, включительно. */
  from: string;
  /** YYYY-MM-DD, включительно; null — период ещё действует. */
  to: string | null;
}
