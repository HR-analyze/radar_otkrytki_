import { loadConfig } from '../config';
import { startImportRun } from '../db';
import { parseAttendanceBuffer, type ParseWarning } from '../parsers/attendance';
import { parseDeliveryTimes } from '../parsers/delivery';
import { mergeDeliveryTimes } from '../delivery-merge';
import { dedupeAttendance } from '../rollup';
import {
  replaceAttendance,
  rollUpAttendance,
  upsertCriterionStatuses,
  upsertShops,
} from '../repository';
import type { AttendanceRow } from '../types';

export interface AttendanceSource {
  /** Человекочитаемое имя источника для журнала (имя файла / ID на Диске). */
  label: string;
  buffer: Buffer;
}

export interface AttendanceJobResult {
  dates: string[];
  rows: number;
  warnings: ParseWarning[];
  /** Сколько лавко-дней получили время водителя из журнала отгрузок. */
  deliveryApplied: number;
  /** Сколько повторных отметок одного человека свёрнуто. */
  deduped: number;
}

export interface AttendanceJobOptions {
  /** Дата отчёта, если в файле её вывести не из чего. */
  fallbackDate?: string;
  /** Журнал отгрузок «Время поставки» — подстановка вместо отсутствующего face id. */
  delivery?: AttendanceSource;
  /**
   * Даты, известные по другим источникам (легаси-книга). Нужны подстановке:
   * за эти дни отметок нет вовсе, а время отгрузки есть.
   */
  knownDates?: readonly string[];
}

/**
 * Job #1: сырые выгрузки «выходы» + «водители» → статусы в БД.
 *
 * Оба файла кладутся в одну таблицу attendance: формат колонок одинаковый,
 * различает их только должность (роль → критерий через roleMap).
 */
export function runAttendanceJob(
  sources: readonly AttendanceSource[],
  options: AttendanceJobOptions = {},
): AttendanceJobResult {
  const config = loadConfig();
  const labels = [...sources.map((s) => s.label), options.delivery?.label].filter(Boolean);
  const run = startImportRun('attendance', labels.join(', '));

  try {
    let all: AttendanceRow[] = [];
    const warnings: ParseWarning[] = [];

    for (const src of sources) {
      const parsed = parseAttendanceBuffer(src.buffer, config, options.fallbackDate);
      all.push(...parsed.rows);
      warnings.push(
        ...parsed.warnings.map((w) => ({ ...w, message: `[${src.label}] ${w.message}` })),
      );
    }

    // Повторные отметки одного человека сворачиваются до записи в БД —
    // иначе они разошлись бы со снимком, где ключа-уникальности нет.
    const deduped = dedupeAttendance(all);
    all = deduped.rows;

    const shops = new Map<string, { code: string; name: string; region: null }>();
    for (const r of all) {
      const prev = shops.get(r.shopCode);
      if (!prev || r.shopName.length > prev.name.length) {
        shops.set(r.shopCode, { code: r.shopCode, name: r.shopName, region: null });
      }
    }
    upsertShops([...shops.values()]);

    // Журнал отгрузок: время приезда там, где отметки face id нет.
    let deliveryApplied = 0;
    if (options.delivery) {
      const parsed = parseDeliveryTimes(options.delivery.buffer);
      warnings.push(
        ...parsed.warnings.map((message) => ({
          kind: 'no_stamps' as const,
          message: `[${options.delivery!.label}] ${message}`,
        })),
      );
      const knownDates = new Set([...(options.knownDates ?? []), ...all.map((r) => r.date)]);
      const names = new Map([...shops].map(([code, shop]) => [code, shop.name]));
      const merged = mergeDeliveryTimes(all, parsed.rows, knownDates, names, config);
      all = merged.rows;
      deliveryApplied = merged.applied;
    }

    const dates = [...new Set(all.map((r) => r.date))].sort();
    for (const date of dates) {
      const forDate = all.filter((r) => r.date === date);
      replaceAttendance(date, forDate);
      upsertCriterionStatuses(rollUpAttendance(date, forDate, config));
    }

    run.finish('ok', all.length, warnings.map((w) => w.message));
    return { dates, rows: all.length, warnings, deliveryApplied, deduped: deduped.removed };
  } catch (e) {
    run.finish('error', 0, [], e instanceof Error ? e.message : String(e));
    throw e;
  }
}
