import type {
  AttendanceRow,
  CriterionKey,
  CriterionStatusRow,
  Status,
  ThresholdConfig,
} from './types';
import { aggregateStatuses } from './status';

/**
 * Свёртка отметок в статусы критериев за день.
 *
 * Живёт отдельно от repository.ts, потому что нужна и при сборке снимка,
 * где БД не поднимается вовсе (см. snapshot.ts).
 *
 * Правило свёртки берётся из конфига (`rules.criterionAggregation`):
 * по умолчанию — средний балл 🟢3/🟡2/🔴1 и зона по нему. Сотрудники без
 * распознанной роли в свёртку не идут; «другой график» и «нет данных»
 * не учитываются ни в среднем, ни в worst.
 */
export function rollUpAttendance(
  date: string,
  rows: readonly AttendanceRow[],
  config: ThresholdConfig,
): CriterionStatusRow[] {
  const strategy = config.rules.criterionAggregation.strategy;
  const buckets = new Map<string, Status[]>();

  for (const r of rows) {
    if (r.date !== date || !r.criterion) continue;
    const key = `${r.shopCode}|${r.criterion}`;
    const list = buckets.get(key);
    if (list) list.push(r.status);
    else buckets.set(key, [r.status]);
  }

  const out: CriterionStatusRow[] = [];
  for (const [key, statuses] of buckets) {
    const [shopCode, criterion] = key.split('|');
    const { status, score } = aggregateStatuses(statuses, strategy, config);
    out.push({
      date,
      shopCode,
      criterion: criterion as CriterionKey,
      status,
      score,
      origin: 'computed',
    });
  }
  return out;
}
