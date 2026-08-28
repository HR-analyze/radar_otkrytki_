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
/**
 * Что за день уже закрыто настоящей выгрузкой отметок.
 *
 * Нужно, чтобы понять, где легаси-книга ещё источник, а где уже нет. Выгрузка
 * приходит по всей сети сразу, поэтому она отвечает не только «во сколько
 * пришли», но и «кто вообще выходил». Раскрашенный вручную 🔴 в книге за день,
 * который выгрузка уже закрыла, — след прежнего ручного процесса.
 *
 * Строки из журнала отгрузок в покрытие не входят: он заполняется выборочно и
 * заменяет только отсутствующий face id водителя, а не всю выгрузку.
 */
export interface ExportCoverage {
  /** «дата|критерий» — за этот день выгрузка по этой роли пришла. */
  criteria: Set<string>;
  /** «дата|лавка» — лавка встречается в выгрузке за этот день. */
  shops: Set<string>;
  /** Даты, за которые выгрузка отметок есть вообще. */
  dates: Set<string>;
}

export function exportCoverage(rows: readonly AttendanceRow[]): ExportCoverage {
  const criteria = new Set<string>();
  const shops = new Set<string>();
  const dates = new Set<string>();

  for (const r of rows) {
    if (r.arrivalSource === 'delivery') continue;
    dates.add(r.date);
    shops.add(`${r.date}|${r.shopCode}`);
    if (r.criterion) criteria.add(`${r.date}|${r.criterion}`);
  }
  return { criteria, shops, dates };
}

/**
 * Устарел ли раскрашенный вручную статус: брать его нельзя, если
 *   · за этот день пришла выгрузка по этой роли — она и есть правда; либо
 *   · за этот день выгрузка есть, а лавки в ней нет вовсе: значит, лавка
 *     не работала (М16 22.08 — суббота), и красить её нечем.
 *
 * Наполнение витрины сюда не относится: у него отдельный источник.
 */
export function isLegacyStale(
  coverage: ExportCoverage,
  date: string,
  shopCode: string,
  criterion: string,
): boolean {
  if (criterion === 'showcase') return false;
  if (coverage.criteria.has(`${date}|${criterion}`)) return true;
  return coverage.dates.has(date) && !coverage.shops.has(`${date}|${shopCode}`);
}

/**
 * Один человек в лавке за день — одна строка.
 *
 * В выгрузках встречаются повторы: у одного и того же сотрудника две отметки за
 * день (вернулся после перерыва — 06:31 и 17:07) или строка без времени рядом
 * со строкой с временем (05:59 и «нет отметки» у одной и той же Абдуллаевой
 * 19.08). Считать их как двух человек нельзя: заказчик делит сумму баллов на
 * число СОТРУДНИКОВ, а «нет отметки» рядом с реальным приходом ещё и красит
 * лавку красным на ровном месте.
 *
 * Побеждает самый ранний реальный приход: радар меряет открытие, поэтому важна
 * первая отметка дня, а не последняя строка в файле.
 */
export function dedupeAttendance(rows: readonly AttendanceRow[]): {
  rows: AttendanceRow[];
  removed: number;
} {
  const best = new Map<string, AttendanceRow>();
  const order: string[] = [];
  let removed = 0;

  for (const r of rows) {
    const key = `${r.date}|${r.shopCode}|${r.employeeName}|${r.role}`;
    const prev = best.get(key);
    if (!prev) {
      best.set(key, r);
      order.push(key);
      continue;
    }

    removed++;
    if (isEarlier(r, prev)) best.set(key, r);
  }

  return { rows: order.map((k) => best.get(k) as AttendanceRow), removed };
}

/** Строка со временем всегда лучше строки без времени; дальше — кто раньше. */
function isEarlier(candidate: AttendanceRow, current: AttendanceRow): boolean {
  if (candidate.arrivalMinutes == null) return false;
  if (current.arrivalMinutes == null) return true;
  return candidate.arrivalMinutes < current.arrivalMinutes;
}

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
