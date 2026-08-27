import * as XLSX from 'xlsx';
import { parseShop } from '../shops';

/**
 * Парсер книги «Время поставки» — журнала отгрузок по маршрутам.
 *
 * Формат: колонка A — лавка, дальше на каждый день по паре колонок
 * «Время отгрузки» | «Накладные пришли на почту». Дата стоит в третьей строке
 * над первой колонкой пары.
 *
 * Особенности реального файла, учтённые здесь:
 *  - даты в третьей строке хранятся двумя способами: у свежих дней — нормальный
 *    серийный номер Excel, у старых — сломанный формат времени («6:36:46»),
 *    из которого настоящую дату не восстановить. Сломанные колонки пропускаем;
 *  - заголовок «Время отгрузки» проставлен не над всеми днями, поэтому колонки
 *    ищутся по строке с датами, а не по заголовку;
 *  - время вводят руками: «6:20», «6;20», «7.45», «7^00»;
 *  - коды лавок пишут и кириллицей, и латиницей, и в нижнем регистре.
 *
 * Зачем это нужно: там, где по водителю нет отметки face id, время приезда
 * берётся отсюда (подтверждено заказчиком 27.08.2026).
 */

export const DELIVERY_SHEET = 'Время поставки';

export interface DeliveryTimeRow {
  date: string;
  shopCode: string;
  /** Время отгрузки в минутах от полуночи. */
  minutes: number;
  /** Как значение выглядело в файле — видно в карточке лавки. */
  raw: string;
}

export interface DeliveryParseResult {
  rows: DeliveryTimeRow[];
  dates: string[];
  warnings: string[];
}

/** Первая строка с данными: 1–2 — служебные, 3 — даты, 4 — заголовки колонок. */
const FIRST_DATA_ROW = 4;
const DATE_ROW = 2;

/** Меньше этого — не дата, а сломанный заголовок в формате времени. */
const MIN_DATE_SERIAL = 40000;

export function parseDeliveryTimes(
  buffer: Buffer,
  sheetName = DELIVERY_SHEET,
): DeliveryParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false });
  const sheet = wb.Sheets[sheetName];
  if (!sheet) throw new Error(`В книге нет листа «${sheetName}»`);
  if (!sheet['!ref']) return { rows: [], dates: [], warnings: [`Лист «${sheetName}» пуст`] };

  const range = XLSX.utils.decode_range(sheet['!ref']);
  const at = (r: number, c: number): XLSX.CellObject | undefined =>
    sheet[XLSX.utils.encode_cell({ r, c })];

  const warnings: string[] = [];

  const dateCols: { col: number; date: string }[] = [];
  let brokenHeaders = 0;
  for (let c = 0; c <= range.e.c; c++) {
    const cell = at(DATE_ROW, c);
    if (!cell || cell.t !== 'n' || typeof cell.v !== 'number') continue;
    if (cell.v < MIN_DATE_SERIAL) {
      brokenHeaders++;
      continue;
    }
    dateCols.push({ col: c, date: serialToIso(cell.v) });
  }
  if (brokenHeaders > 0) {
    warnings.push(
      `Колонок с нечитаемой датой в шапке: ${brokenHeaders} — пропущены ` +
        `(в файле они записаны как время, а не как дата)`,
    );
  }
  if (dateCols.length === 0) {
    return { rows: [], dates: [], warnings: [...warnings, 'В шапке листа не найдено ни одной даты'] };
  }

  const rows: DeliveryTimeRow[] = [];
  const dates = new Set<string>();

  for (let r = FIRST_DATA_ROW; r <= range.e.r; r++) {
    const shop = parseShop(at(r, 0)?.v);
    if (!shop) continue;

    for (const { col, date } of dateCols) {
      const cell = at(r, col);
      if (!cell || cell.v == null || cell.v === '') continue;

      const raw = String(cell.w ?? cell.v).trim();
      const minutes = toMinutes(cell);
      if (minutes == null) {
        warnings.push(`${shop.code} ${date}: не разобрано время отгрузки «${raw}»`);
        continue;
      }

      dates.add(date);
      rows.push({ date, shopCode: shop.code, minutes, raw });
    }
  }

  return { rows, dates: [...dates].sort(), warnings };
}

/** Серийный номер Excel → «2026-08-19». */
function serialToIso(serial: number): string {
  const ms = Date.UTC(1899, 11, 30) + Math.floor(serial) * 86_400_000;
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * Ячейка со временем → минуты от полуночи.
 * Числовая ячейка — доля суток; «7.45» и «7,45» встречаются как число и значат
 * 7:45; текст пишут через любой разделитель: «6:20», «6;20», «7^00».
 */
function toMinutes(cell: XLSX.CellObject): number | null {
  if (cell.t === 'n' && typeof cell.v === 'number') {
    const v = cell.v;
    if (v > 0 && v < 1) return clampMinutes(Math.round((v - Math.floor(v)) * 24 * 60));
    if (v >= 1 && v < 24) {
      // «7.45» Excel сохранил как число 7,45 — это 7 часов 45 минут.
      const hours = Math.floor(v);
      const minutes = Math.round((v - hours) * 100);
      return minutes <= 59 ? clampMinutes(hours * 60 + minutes) : null;
    }
    return null;
  }

  const m = /^(\d{1,2})\s*[^\d]\s*(\d{1,2})/.exec(String(cell.w ?? cell.v ?? '').trim());
  if (!m) return null;
  const hours = Number(m[1]);
  const minutes = Number(m[2]);
  if (hours > 23 || minutes > 59) return null;
  return clampMinutes(hours * 60 + minutes);
}

function clampMinutes(m: number): number | null {
  return Number.isFinite(m) && m >= 0 && m < 24 * 60 ? m : null;
}
