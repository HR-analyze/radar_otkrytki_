import * as XLSX from 'xlsx';
import { dayFill } from './day-fill';
import type { ShowcaseStore } from './showcase-store';

/**
 * Наполнение витрин таблицей для Excel: одна строка — лавка за день, оба замера
 * рядом.
 *
 *   Номер лавки | Дата | Утро | 16:00 | Средний результат
 *
 * Средний результат — среднее двух замеров (утром 100%, в 16:00 50% → 75%), а
 * если мерили один раз — он сам. С 06.10.2026 это и есть итог дня радара:
 * считается той же функцией (dayFill), что радар, карточка лавки и балл, —
 * до целого процента, половинка вверх. Цифра в выгрузке и на дашборде одна.
 *
 * Строки идут по лавке, внутри лавки — по дням: так читают «как держала витрину
 * М12 весь месяц», а автофильтр Excel переворачивает таблицу в «все лавки за
 * день», если нужно.
 *
 * Незаполненный замер — пустая ячейка, а не ноль: «не мерили» и «витрина пуста»
 * — разные вещи, и 0% в средних Excel посчитал бы как настоящий.
 */

export interface ShowcaseXlsxRow {
  shopCode: string;
  date: string;
  /** Доля 0–1 или null — не мерили. */
  morning: number | null;
  afternoon: number | null;
  /** Среднее двух замеров; null — не мерили вовсе. */
  average: number | null;
}

export const SHOWCASE_XLSX_HEADER = ['Номер лавки', 'Дата', 'Утро', '16:00', 'Средний результат'] as const;

/**
 * Строки выгрузки: каждая лавка за каждый день окна, в который она работала.
 *
 * Пустые дни не выкидываются: пропуск замера — тоже результат, его и ищут.
 * `isOpen` отрезает дни после закрытия лавки (см. isOpenOn) — там пропуск
 * был бы ложным.
 */
export function showcaseXlsxRows(
  store: Pick<ShowcaseStore, 'days' | 'afternoon'>,
  shopCodes: readonly string[],
  dates: readonly string[],
  isOpen: (shopCode: string, date: string) => boolean = () => true,
): ShowcaseXlsxRow[] {
  const rows: ShowcaseXlsxRow[] = [];
  for (const shopCode of shopCodes) {
    for (const date of dates) {
      if (!isOpen(shopCode, date)) continue;
      const morning = store.days[date]?.[shopCode] ?? null;
      const afternoon = store.afternoon[date]?.[shopCode] ?? null;
      rows.push({ shopCode, date, morning, afternoon, average: dayFill(morning, afternoon) });
    }
  }
  return rows;
}

/**
 * Книга .xlsx из строк. Дата — настоящая дата Excel, проценты — числа с
 * форматом «0%»: по ним работают сортировка, фильтр и формулы, а не текст.
 */
export function showcaseXlsx(rows: readonly ShowcaseXlsxRow[]): Buffer {
  const aoa: (string | number | null)[][] = [
    [...SHOWCASE_XLSX_HEADER],
    ...rows.map((r) => [r.shopCode, excelSerial(r.date), r.morning, r.afternoon, r.average]),
  ];

  const sheet = XLSX.utils.aoa_to_sheet(aoa);

  const format = (r: number, c: number, z: string): void => {
    const cell = sheet[XLSX.utils.encode_cell({ r, c })] as XLSX.CellObject | undefined;
    if (cell?.t === 'n') cell.z = z;
  };
  for (let r = 1; r <= rows.length; r++) {
    format(r, 1, 'dd.mm.yyyy');
    format(r, 2, '0%');
    format(r, 3, '0%');
    format(r, 4, '0%');
  }

  sheet['!cols'] = [{ wch: 12 }, { wch: 12 }, { wch: 8 }, { wch: 8 }, { wch: 18 }];
  sheet['!autofilter'] = { ref: XLSX.utils.encode_range({ r: 0, c: 0 }, { r: rows.length, c: 4 }) };

  const book = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(book, sheet, 'Наполнение витрин');
  return XLSX.write(book, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

/**
 * «2026-09-21» → серийный номер дня в Excel (дни от 30.12.1899).
 *
 * Считается через UTC, а не через Date сервера: SheetJS переводит Date в число
 * по местной зоне, и полночь при сдвиге зоны уезжала бы на соседний день.
 */
export function excelSerial(iso: string): number {
  const [y, m, d] = iso.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(1899, 11, 30)) / 86_400_000);
}
