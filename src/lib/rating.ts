import { STATUS_SCORE, averageScore, roundScore, statusFromScore, worstStatus } from './status';
import type { CriterionKey, Status, ThresholdConfig } from './types';

/**
 * Рейтинг подразделения за день.
 *
 * Методология заказчика (лист «Вод + Сотр + Витри», подтверждена 27.08.2026):
 *
 *   1. Каждая должность оценивается по радару → цвет.
 *   2. Цвет конвертируется в балл: 🟢 3, 🟡 2, 🔴 1.
 *   3. Баллы ВСЕХ сотрудников (повар, кассир, бариста, ЗД по залу) суммируются
 *      и делятся на число сотрудников — это один общий балл «выход сотрудников».
 *      Пример заказчика: 9 / 5 = 1,8 → 🔴.
 *   4. Итог лавки = (балл водителя + балл сотрудников + балл витрины) / 3,
 *      зона — по тем же границам, что и везде (rules.scoreZones).
 *
 * Важно: сотрудники усредняются по людям, а не по должностям. Три повара и один
 * кассир дают 4 в знаменателе, а не 2 — так считает заказчик. Тикеты по каждой
 * должности отдельно (rules.criterionAggregation) на этот расчёт не влияют:
 * они живут рядом и нужны для разреза по критериям.
 */

/** Слагаемые формулы «Водитель + Сотрудники + Витрина». */
export type RatingComponentKey = 'driver' | 'staff' | 'showcase';

export interface RatingComponent {
  key: RatingComponentKey;
  status: Status;
  /** Средний балл слагаемого; null — данных за день нет. */
  score: number | null;
  /** Сколько оценок вошло в средний балл (для сотрудников — людей). */
  count: number;
}

export interface ShopRating {
  status: Status;
  /** Итоговый балл лавки; null — считать не из чего. */
  score: number | null;
  components: RatingComponent[];
}

export const RATING_COMPONENT_TITLE: Record<RatingComponentKey, string> = {
  driver: 'Водитель',
  staff: 'Сотрудники',
  showcase: 'Витрина',
};

/** Должности, которые складываются в общий балл «выход сотрудников». */
export const STAFF_CRITERIA: CriterionKey[] = ['cook', 'cashier', 'barista', 'hallDeputy'];

/** Оценка одного человека: важны только критерий и цвет. */
export interface RatedPerson {
  criterion: CriterionKey | null;
  status: Status;
}

export function rateShopDay(
  people: readonly RatedPerson[],
  showcaseStatus: Status | null,
  config: ThresholdConfig,
): ShopRating {
  const components: RatingComponent[] = [
    component(
      'driver',
      people.filter((p) => p.criterion === 'driver').map((p) => p.status),
      config,
    ),
    component(
      'staff',
      people
        .filter((p) => p.criterion && STAFF_CRITERIA.includes(p.criterion))
        .map((p) => p.status),
      config,
    ),
    component('showcase', showcaseStatus ? [showcaseStatus] : [], config),
  ];

  // Слагаемое без данных за день (нет отметок, витрину не заполнили) в среднее
  // не входит: делим на то, что есть, иначе один пропуск утащил бы лавку в 🔴.
  const scored = components
    .map((c) => c.score)
    .filter((s): s is number => s != null);

  if (scored.length === 0) return { status: 'no_data', score: null, components };

  const sum = scored.reduce((a, b) => a + b, 0);
  const score = roundScore(sum / scored.length, config.rules.scoreZones.precision);

  return { status: statusFromScore(score, config), score, components };
}

function component(
  key: RatingComponentKey,
  statuses: readonly Status[],
  config: ThresholdConfig,
): RatingComponent {
  const score = averageScore(statuses, config);
  return {
    key,
    // Нет балла — значит остались только нейтральные статусы либо пусто;
    // worstStatus вернёт для них «нет данных», не выдумывая цвет.
    status: score == null ? worstStatus(statuses) : statusFromScore(score, config),
    score,
    count: statuses.filter((s) => STATUS_SCORE[s] != null).length,
  };
}
