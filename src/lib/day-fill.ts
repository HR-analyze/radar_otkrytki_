import type { Status } from './types';

/**
 * Итог дня по витрине — среднее замеров утром и в 16:00.
 *
 * Отдельный модуль без зависимостей: формулу зовут и сервер (радар, сводка,
 * балл, API редактора, Excel), и редактор в браузере (превью статуса, пока
 * правка летит на сервер). Две копии одной формулы однажды разъехались бы, и
 * статус в строке менялся бы в момент сохранения.
 *
 * До 06.10.2026 итогом был худший из двух замеров; заказчик перевёл его на
 * среднее — то же, что в столбце «Средний результат» выгрузки в Excel.
 */

/**
 * Среднее двух замеров в процентах. Каждый замер — целый процент (так он и
 * хранится), среднее тоже округляется до целого, половинка вверх: 95% и 94%
 * дают 95%. Пороги витрины целые (🟢 от 95%, 🟡 от 85%), и без округления
 * 94,5% показывались бы как «95%» с жёлтым статусом. Считаем в целых
 * процентах: (0.95 + 0.94) / 2 в долях даёт 0.9449999…, и половинка терялась бы.
 */
export function averagePercent(morning: number, afternoon: number): number {
  return Math.round((Math.round(morning) + Math.round(afternoon)) / 2);
}

/**
 * Итог дня, доля 0–1: утром 100%, в 16:00 50% — это 75%. Незаполненный замер
 * в среднее не входит: если в 16:00 не мерили, итог равен утреннему как есть,
 * а не его половине, и наоборот.
 */
export function dayFill(morning: number | null, afternoon: number | null): number | null {
  if (morning == null) return afternoon;
  if (afternoon == null) return morning;
  return averagePercent(morning * 100, afternoon * 100) / 100;
}

/**
 * Набранное в поле число — так, как его сохранит сервер: запятая как точка,
 * 0–100, до целого процента (см. parsePercent в api/showcase и round в
 * showcase-store). Иначе «94,5» в превью было бы 🟡, а после сохранения — 🟢.
 * null — сервер такое значение не примет, в итог оно не входит.
 */
export function storedPercent(value: string): number | null {
  if (value.trim() === '') return null;
  const percent = Number(value.replace(',', '.'));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return null;
  return Math.round(percent);
}

/** Статус по проценту и порогам витрины (доли 0–1). */
export function statusOf(
  value: string,
  thresholds: { green: number; yellow: number },
): Status {
  if (value === '') return 'no_data';
  const percent = Number(value);
  if (!Number.isFinite(percent)) return 'no_data';

  const share = percent / 100;
  if (share >= thresholds.green) return 'green';
  if (share >= thresholds.yellow) return 'yellow';
  return 'red';
}

/**
 * Статус итога дня по набранным в редакторе замерам — тот же, что сервер
 * поставит после сохранения: каждый замер приводится к хранимому виду,
 * дальше — dayFill. Пустой замер в итог не входит.
 */
export function dayStatusOf(
  values: readonly [string, string] | readonly string[],
  thresholds: { green: number; yellow: number },
): Status {
  const [morning, afternoon] = [values[0] ?? '', values[1] ?? ''].map(storedPercent);
  const day = dayFill(
    morning == null ? null : morning / 100,
    afternoon == null ? null : afternoon / 100,
  );
  return day == null ? 'no_data' : statusOf(String(Math.round(day * 100)), thresholds);
}
