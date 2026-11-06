import * as XLSX from 'xlsx';
import { parseShop } from '../shops';
import { expandMerges, personName } from './roster';

/**
 * Кто руководит лавкой: её управляющий (директор) или территориальный
 * директор. Таблица «Лавки» — тот же справочник, что «Лавки БК», но новее и с
 * колонкой «ФИ Управляющего».
 *
 * У лавки либо свой директор, либо ТД на две лавки — вместе они в таблице не
 * встречаются. Бывает и директор на две лавки (Абрамова Дарья — М23 и М47).
 *
 * Берём только имена. В таблице ещё телефоны, почта и адреса — радару они не
 * нужны, а вкладка «КПИ» видна всем, у кого есть пароль; поэтому ни они, ни
 * сама книга в репозиторий не попадают (см. scripts/build-shop-directors.ts).
 *
 * Особенности файла:
 *  - **объединённые ячейки.** ТД стоит одной ячейкой на две строки, РМ — на
 *    блок из десяти. Без разворота по `!merges` вторая лавка ТД осталась бы
 *    без руководителя;
 *  - **телефон и имя управляющего** у лавок ТД слиты в одну ячейку, и после
 *    разворота в колонке имени оказывается телефон. Его отсекает personName —
 *    имя должно быть «Фамилия Имя»;
 *  - **девичья фамилия в скобках**: «Радучич (Пахомова) Ольга». Скобки с
 *    буквами убираем, иначе имя обрезалось бы на скобке, как телефон.
 */

export const SHOP_DIRECTORS_SHEET = 'Лавки';

export interface ShopDirectorRow {
  code: string;
  /** Управляющий лавки; null — у лавки ТД или клетка пустая. */
  director: string | null;
  /** Территориальный директор; null — у лавки свой директор. */
  territorial: string | null;
}

export interface ShopDirectorsParseResult {
  rows: ShopDirectorRow[];
  warnings: string[];
}

const COL = {
  director: 'ФИ Управляющего',
  territorial: 'Территориальный директор',
} as const;

export function parseShopDirectors(buffer: Buffer, sheetName = SHOP_DIRECTORS_SHEET): ShopDirectorsParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const actual = wb.SheetNames.find((n) => n.trim().toLowerCase() === sheetName.trim().toLowerCase());
  if (!actual) throw new Error(`В книге нет листа «${sheetName}»`);
  const sheet = wb.Sheets[actual];

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  expandMerges(grid, sheet['!merges'] ?? []);

  const header = (grid[0] ?? []).map((c) => String(c ?? '').trim().toLowerCase());
  const at = {
    director: header.indexOf(COL.director.toLowerCase()),
    territorial: header.indexOf(COL.territorial.toLowerCase()),
    // Колонка с кодом лавки в файле без заголовка — первая; «№» тоже понимаем.
    code: Math.max(header.indexOf('№'), 0),
  };
  if (at.director < 0 && at.territorial < 0) {
    throw new Error(`В листе «${actual}» нет колонок «${COL.director}» и «${COL.territorial}»`);
  }

  const rows: ShopDirectorRow[] = [];
  const warnings: string[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    const shop = parseShop(raw[at.code]);
    if (!shop) continue;
    if (seen.has(shop.code)) {
      warnings.push(`Строка ${i + 1}: лавка ${shop.code} встречается второй раз — взята первая`);
      continue;
    }
    seen.add(shop.code);

    const director = at.director >= 0 ? nameOf(raw[at.director]) : null;
    const territorial = at.territorial >= 0 ? nameOf(raw[at.territorial]) : null;
    if (director && territorial) {
      warnings.push(`${shop.code}: указаны и управляющий (${director}), и ТД (${territorial}) — в КПИ лавка пойдёт к ТД`);
    }
    rows.push({ code: shop.code, director: territorial ? null : director, territorial });
  }

  if (rows.length === 0) warnings.push(`В листе «${actual}» не нашлось ни одной лавки`);
  return { rows, warnings };
}

/** Имя из клетки; телефон, пометка «ЛАВКА ЗАКРЫТА» и пустота — null. */
export function nameOf(value: unknown): string | null {
  const text = String(value ?? '')
    .replace(/\([А-ЯЁа-яё\s-]+\)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return personName(text);
}
