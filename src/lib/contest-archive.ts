import bundled from '../../fixtures/contest-archive.json';
import type { Status } from './types';

/**
 * Архив конкурса: дни, утренних замеров которых в базе ручных данных нет.
 *
 * Откуда. При переезде на RelaxDev база витрин старого сервера осталась на
 * нём, а сентябрьский конкурс уцелел только PDF-отчётом. Из отчёта вынуты
 * цвета дней (квадраты полосы) и колонка «Витрина» — это и лежит в
 * `fixtures/contest-archive.json`. Сам отчёт — рядом, в `docs/archive/`.
 *
 * Чего в архиве нет — процентов по дням: в PDF их не печатали. Поэтому день
 * архива несёт точный статус и балл, а `fill` у него — средняя наполненность
 * лавки за весь период отчёта. За полный период «Витрина» сходится с PDF, за
 * кусок периода — это то же среднее, а не замер этих дней.
 *
 * В базу ручных данных архив не пишется нарочно: перенос со старого сервера
 * (scripts/import-yandex-sqlite.ts) при совпадении дня оставляет то, что уже
 * лежит в базе, и придуманные проценты закрыли бы собой настоящие. Отсюда же
 * правило подмешивания в contest(): настоящий утренний замер всегда важнее.
 */

export interface ContestArchiveDay {
  date: string;
  shopCode: string;
  status: Extract<Status, 'green' | 'yellow' | 'red'>;
  /** Средняя наполненность лавки за период отчёта, 0–1, — не замер дня. */
  fill: number;
  /** Из какого отчёта день: путь к PDF в репозитории. */
  file: string;
}

interface ArchiveFile {
  reports: {
    file: string;
    dates: string[];
    /** Лавка → средняя «Витрина» и по символу на дату: g / y / r, «-» — пусто. */
    shops: Record<string, { fill: number; days: string }>;
  }[];
}

const STATUS_BY_CHAR: Record<string, ContestArchiveDay['status']> = {
  g: 'green',
  y: 'yellow',
  r: 'red',
};

/**
 * Разворачивает архив в дни. Битая запись — ошибка, а не тихий пропуск:
 * архив правят руками, и съехавшая на символ строка дала бы чужие цвета.
 */
export function parseContestArchive(raw: ArchiveFile): ContestArchiveDay[] {
  const out: ContestArchiveDay[] = [];
  const seen = new Set<string>();
  for (const report of raw.reports) {
    for (const [shopCode, { fill, days }] of Object.entries(report.shops)) {
      if (days.length !== report.dates.length) {
        throw new Error(`Архив конкурса ${report.file}: у ${shopCode} ${days.length} дней вместо ${report.dates.length}`);
      }
      if (!(fill >= 0 && fill <= 1)) {
        throw new Error(`Архив конкурса ${report.file}: у ${shopCode} витрина ${fill} вне 0–1`);
      }
      [...days].forEach((ch, i) => {
        if (ch === '-') return;
        const status = STATUS_BY_CHAR[ch];
        if (!status) throw new Error(`Архив конкурса ${report.file}: у ${shopCode} непонятный день «${ch}»`);
        const date = report.dates[i];
        const key = `${shopCode}|${date}`;
        if (seen.has(key)) throw new Error(`Архив конкурса: ${shopCode} за ${date} встречается дважды`);
        seen.add(key);
        out.push({ date, shopCode, status, fill, file: report.file });
      });
    }
  }
  return out;
}

let cached: ContestArchiveDay[] | null = null;

export function contestArchiveDays(): ContestArchiveDay[] {
  return (cached ??= parseContestArchive(bundled as ArchiveFile));
}
