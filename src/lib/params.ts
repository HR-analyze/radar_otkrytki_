import { listDates } from './queries';
import { isoDate } from './time';
import type { CriterionKey, Status } from './types';
import { CRITERION_ORDER } from './types';

export interface ResolvedParams {
  from: string;
  to: string;
  region?: string;
  criterion?: CriterionKey | 'all';
  status?: Status | 'all';
  /** Поиск по лавке: код или часть названия. */
  shop?: string;
  dates: string[];
}

const STATUSES: Status[] = ['green', 'yellow', 'red', 'other_schedule', 'no_data'];

/**
 * Период по умолчанию — текущий месяц.
 *
 * Справочники и отчётность у заказчика месячные, и открывать радар сразу на
 * нужном месяце — то, чего ждёшь: 1 октября он сам покажет октябрь, а не
 * остаток сентября.
 *
 * Границы берутся по дням, за которые данные есть, а не по календарю: иначе
 * период тянулся бы до 30-го числа по пустым дням. Если в текущем месяце
 * данных ещё нет вовсе (первое число, выгрузку не залили), показываем
 * последний месяц с данными — пустой экран выглядел бы поломкой.
 */
export function defaultRange(dates: readonly string[], today = isoDate(new Date())): {
  from: string;
  to: string;
} {
  const monthOf = (d: string): string => d.slice(0, 7);
  const span = (month: string): { from: string; to: string } | null => {
    const days = dates.filter((d) => monthOf(d) === month);
    return days.length > 0 ? { from: days[0], to: days[days.length - 1] } : null;
  };

  const current = span(monthOf(today));
  if (current) return current;

  const last = dates[dates.length - 1];
  return last ? (span(monthOf(last)) ?? { from: last, to: last }) : { from: today, to: today };
}

/**
 * Параметры из URL с безопасными значениями по умолчанию: период — текущий
 * месяц (см. defaultRange), остальные фильтры пусты.
 */
export async function resolveParams(
  sp: Record<string, string | string[] | undefined>,
): Promise<ResolvedParams> {
  const dates = await listDates();
  const { from: fallbackFrom, to: fallbackTo } = defaultRange(dates);

  const one = (k: string): string | undefined => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const isDate = (v: string | undefined): v is string => !!v && /^\d{4}-\d{2}-\d{2}$/.test(v);

  let from = isDate(one('from')) ? (one('from') as string) : fallbackFrom;
  let to = isDate(one('to')) ? (one('to') as string) : fallbackTo;
  if (from > to) [from, to] = [to, from];

  const criterionRaw = one('criterion');
  const criterion = CRITERION_ORDER.includes(criterionRaw as CriterionKey)
    ? (criterionRaw as CriterionKey)
    : 'all';

  const statusRaw = one('status');
  const status = STATUSES.includes(statusRaw as Status) ? (statusRaw as Status) : 'all';

  return {
    from,
    to,
    region: one('region') || undefined,
    // Строка из URL: обрезаем, чтобы в фильтр не приехал роман.
    shop: one('shop')?.trim().slice(0, 40) || undefined,
    criterion,
    status,
    dates,
  };
}
