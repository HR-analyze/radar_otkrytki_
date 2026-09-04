import type { DeliveryTimeRow } from './parsers/delivery';
import { statusForTime } from './status';
import type { AttendanceRow, ThresholdConfig } from './types';

/**
 * Подстановка времени приезда водителя из книги «Время поставки».
 *
 * Правило заказчика (27.08.2026): где по водителю нет отметки face id, а в
 * таблице отгрузок время есть — берём его. Где отметка есть, таблица не
 * используется: face id точнее, это отметка в самой лавке.
 *
 * Что делает подстановка для дня и лавки без отметки:
 *   · добавляет строку «Отгрузка по маршруту» с временем из таблицы —
 *     она и даёт статус критерия «Приезд водителя»;
 *   · строки водителей, которые в этот день не отметились, переводит в
 *     «нет данных»: иначе их 🔴 и подставленное время считались бы вместе.
 *     Из карточки лавки они не исчезают — видно, что человек не отметился.
 *
 * Даты, которых нет в остальных данных, пропускаются: в таблице отгрузок есть
 * дни, по которым нет ни выгрузок, ни легаси-книги, и радар из-за них оброс бы
 * днями, где известен только водитель.
 */

export const DELIVERY_EMPLOYEE = 'Отгрузка по маршруту';
export const DELIVERY_ROLE = 'Водитель';

export interface DeliveryMergeResult {
  rows: AttendanceRow[];
  /** Сколько лавко-дней получили время из таблицы. */
  applied: number;
  /** Сколько строк водителей без отметки переведено в «нет данных». */
  suppressed: number;
  /** Строк таблицы, отброшенных из-за даты вне периода данных. */
  skippedDates: number;
}

export function mergeDeliveryTimes(
  attendance: readonly AttendanceRow[],
  delivery: readonly DeliveryTimeRow[],
  knownDates: ReadonlySet<string>,
  shopNames: ReadonlyMap<string, string>,
  config: ThresholdConfig,
): DeliveryMergeResult {
  const key = (date: string, shopCode: string): string => `${date}|${shopCode}`;

  const hasFaceId = new Set<string>();
  const markless = new Map<string, AttendanceRow[]>();
  for (const r of attendance) {
    if (r.criterion !== 'driver') continue;
    const k = key(r.date, r.shopCode);
    if (r.arrivalMinutes != null) {
      hasFaceId.add(k);
      continue;
    }
    const list = markless.get(k);
    if (list) list.push(r);
    else markless.set(k, [r]);
  }

  const rows = [...attendance];
  const suppress = new Set<AttendanceRow>();
  const done = new Set<string>();
  let applied = 0;
  let skippedDates = 0;

  for (const d of delivery) {
    if (!knownDates.has(d.date)) {
      skippedDates++;
      continue;
    }
    const k = key(d.date, d.shopCode);
    if (hasFaceId.has(k)) continue;
    // Одна лавка — одна подстановка за день, даже если строк в таблице больше.
    if (done.has(k)) continue;
    done.add(k);

    for (const r of markless.get(k) ?? []) suppress.add(r);

    rows.push({
      date: d.date,
      shopCode: d.shopCode,
      shopName: shopNames.get(d.shopCode) ?? d.shopCode,
      employeeName: DELIVERY_EMPLOYEE,
      role: DELIVERY_ROLE,
      criterion: 'driver',
      trainee: false,
      homeShopCode: null,
      arrivalMinutes: d.minutes,
      arrivalSource: 'delivery',
      rawArrival: d.raw,
      rawDeparture: null,
      status: statusForTime(d.minutes, 'driver', config, d.shopCode),
      note: 'Отметки face id за этот день нет — время взято из таблицы «Время поставки».',
    });
    applied++;
  }

  const suppressed = suppress.size;
  const merged = rows.map((r) =>
    suppress.has(r)
      ? {
          ...r,
          status: 'no_data' as const,
          note: 'Не отметился; время приезда взято из таблицы «Время поставки» — см. строку «Отгрузка по маршруту».',
        }
      : r,
  );

  return { rows: merged, applied, suppressed, skippedDates };
}
