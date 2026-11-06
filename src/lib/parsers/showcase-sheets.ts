import * as XLSX from 'xlsx';
import { parseShop } from '../shops';
import { normalizeFill } from '../status';
import { excelDay } from '../time';

/**
 * Книга наполнения витрин из Google-таблицы: листы «Витрины 0800»,
 * «Витрины 1600» и (с 26.10.2026) «Витрины 1830».
 *
 * Пока радар может лежать, витрины вносят в Google-таблицу, а потом её
 * скачивают в .xlsx и заливают кнопкой «Загрузить». Значения уходят в базу
 * тем же путём, что и правка на вкладке «Витрины».
 *
 * Формат листа: в первой строке «Лавка» и даты, дальше строка на лавку
 * («М1 Милютинский»), в ячейке — процент. Таблицу ведут руками, поэтому в
 * одном листе встречаются три записи одного и того же:
 *   - 95 — проценты числом (формат «Общий»);
 *   - 0.95 — доля в ячейке с форматом «0%», а 1 там же — это 100%;
 *   - текст: «100 на 9 утра (поставка пришла в 8 утра)», «95% просмотр на 8:34», «вых».
 * Число из текста берётся, только если оно однозначно: с «%» или первым словом.
 * Сам текст уходит в комментарий дня, а ячейка — в отдельный список, чтобы
 * человек при загрузке видел, что именно радар из неё понял.
 *
 * Пустая ячейка не приходит вовсе и ничего в базе не затирает.
 */

export type ShowcaseSlot = 'morning' | 'afternoon' | 'evening';

/** Лист → замер. «Витрины 0800», «Витрины 08:00», «витрина 8.00» — утро. */
export function showcaseSlotOfSheet(name: string): ShowcaseSlot | null {
  const n = name.trim().toLowerCase();
  if (!n.startsWith('витрин')) return null;
  const time = n.replace(/^витрин[аы]?/, '').replace(/[\s:.]/g, '');
  if (time === '0800' || time === '800') return 'morning';
  if (time === '1600') return 'afternoon';
  if (time === '1830') return 'evening';
  return null;
}

export function isShowcaseBook(sheetNames: readonly string[]): boolean {
  return sheetNames.some((n) => showcaseSlotOfSheet(n) !== null);
}

export interface ShowcaseSheetCell {
  date: string;
  shopCode: string;
  slot: ShowcaseSlot;
  /** Доля 0–1; null — числа в ячейке нет (например, «вых»). */
  fill: number | null;
  /** Текст ячейки как есть, если там был не просто процент. */
  text?: string;
  /** Адрес для человека: «Витрины 0800!D3». */
  cell: string;
}

export interface ShowcaseSheetsResult {
  cells: ShowcaseSheetCell[];
  shops: { code: string; name: string }[];
  dates: string[];
  warnings: string[];
}

export function parseShowcaseSheets(buffer: Buffer): ShowcaseSheetsResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: true });
  const cells: ShowcaseSheetCell[] = [];
  const shops = new Map<string, string>();
  const warnings: string[] = [];
  const seen = new Map<string, string>();

  for (const sheetName of wb.SheetNames) {
    const slot = showcaseSlotOfSheet(sheetName);
    if (!slot) continue;
    const sheet = wb.Sheets[sheetName];
    const label = sheetName.trim();
    const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
    if (grid.length === 0) continue;

    const dateCols: { col: number; date: string }[] = [];
    grid[0].forEach((v, col) => {
      if (v instanceof Date && !Number.isNaN(v.getTime())) dateCols.push({ col, date: excelDay(v) });
    });
    if (dateCols.length === 0) {
      warnings.push(`«${label}»: в первой строке нет ни одной даты — лист пропущен`);
      continue;
    }

    // Объединённая ячейка на две даты держит значение только в первой —
    // молча отдать его одному дню было бы угадыванием.
    for (const m of sheet['!merges'] ?? []) {
      const top = grid[m.s.r]?.[m.s.c];
      if (m.e.c > m.s.c && top != null && top !== '' && dateCols.some((d) => d.col === m.s.c)) {
        warnings.push(
          `«${label}»!${XLSX.utils.encode_range(m)}: ячейка объединена на несколько дат — значение взято только для первой`,
        );
      }
    }

    for (let r = 1; r < grid.length; r++) {
      const row = grid[r];
      const shop = parseShop(row[0]);
      if (!shop) {
        const raw = String(row[0] ?? '').trim();
        const hasValues = dateCols.some(({ col }) => row[col] != null && String(row[col]).trim() !== '');
        if (raw || hasValues) warnings.push(`«${label}», строка ${r + 1}: не понял лавку «${raw}» — строка пропущена`);
        continue;
      }
      if (!shops.has(shop.code)) shops.set(shop.code, shop.name);

      for (const { col, date } of dateCols) {
        const cell = `«${label}»!${XLSX.utils.encode_cell({ r, c: col })}`;
        const read = readCell(row[col]);
        if (!read) continue;
        if ('error' in read) {
          warnings.push(`${cell} (${shop.code}, ${date}): ${read.error}`);
          continue;
        }

        const key = `${slot}|${date}|${shop.code}`;
        const prev = seen.get(key);
        if (prev) {
          warnings.push(`${cell}: ${shop.code} за ${date} уже был в ${prev} — оставлено первое значение`);
          continue;
        }
        seen.set(key, cell);
        cells.push({ date, shopCode: shop.code, slot, fill: read.fill, ...(read.text ? { text: read.text } : {}), cell });
      }
    }
  }

  return {
    cells,
    shops: [...shops].map(([code, name]) => ({ code, name })),
    dates: [...new Set(cells.map((c) => c.date))].sort(),
    warnings,
  };
}

type CellRead = { fill: number | null; text?: string } | { error: string } | null;

/** Ячейка → доля. null — пусто, ничего не делать. */
export function readCell(v: unknown): CellRead {
  if (v == null) return null;
  if (typeof v === 'number') return Number.isFinite(v) ? checked(normalizeFill(v), String(v)) : null;
  if (v instanceof Date) return { error: 'в ячейке дата вместо процента' };

  const text = String(v).replace(/\s+/g, ' ').trim();
  if (!text) return null;

  // Просто процент строкой: «95», «95%», «0,95».
  const plain = /^(\d+(?:[.,]\d+)?)\s*(%?)$/.exec(text);
  if (plain) return checked(percent(plain[1], plain[2] === '%'), text);

  // Процент внутри текста: «95% просмотр на 8:34», «Поставка 7:42 … 100%».
  const withSign = /(\d+(?:[.,]\d+)?)\s*%/.exec(text);
  // Или число первым словом: «100 на 9 утра (поставка пришла в 8 утра)».
  // Не время: «8:40 …» — это не процент.
  const leading = /^(\d+(?:[.,]\d+)?)(?=\s|$)/.exec(text);
  const fill = withSign ? percent(withSign[1], true) : leading ? percent(leading[1], false) : null;
  if (fill == null) return { fill: null, text };
  const res = checked(fill, text);
  return 'error' in res ? res : { fill: res.fill, text };
}

function percent(num: string, withSign: boolean): number {
  const n = Number(num.replace(',', '.'));
  return withSign ? n / 100 : normalizeFill(n);
}

function checked(fill: number, raw: string): { fill: number } | { error: string } {
  if (fill < 0 || fill > 1) return { error: `«${raw}» — не процент от 0 до 100, значение не взято` };
  return { fill: Math.round(fill * 10000) / 10000 };
}
