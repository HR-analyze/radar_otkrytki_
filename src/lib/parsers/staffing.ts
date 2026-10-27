import * as XLSX from 'xlsx';
import { parseShop } from '../shops';
import type { StaffNorm, StaffRole, StaffRoleNorm } from '../staffing';

/**
 * Норма выхода сотрудников — лист «Шаблон по часам-пикам».
 *
 * Строка — лавка, дальше группы колонок по должностям. Заголовок колонки —
 * должность и окно через перенос строки: «Кассир\n6.5-7,5», «Повар\nдо 8»,
 * «Бариста\nFTE». За каждой группой — «ЧЕЛ-КО часы» без должности: она
 * относится к группе слева.
 *
 * Окна читаются из заголовков, а не зашиты: у кассира и повара они разные,
 * и следующая версия шаблона может их сдвинуть — разбор от этого не сломается.
 *
 * Колонку «ТО план» не берём нарочно: вкладка открыта без пароля, а план
 * товарооборота лавки — не то, что нужно знать для выхода на смену. Грейд
 * (вилка оборота) остаётся — по нему и подобраны нормы. Второй лист книги,
 * «ШР по лавкам», с фондом оплаты труда тоже не читается.
 */

export const STAFFING_SHEET = 'Шаблон по часам-пикам';

const ROLE_BY_TITLE: Record<string, StaffRole> = {
  кассир: 'cashier',
  повар: 'cook',
  бариста: 'barista',
  уборщик: 'cleaner',
};

export interface StaffingParseResult {
  norms: StaffNorm[];
  warnings: string[];
}

type Column =
  | { kind: 'slot'; role: StaffRole; from: number | null; to: number }
  | { kind: 'fte'; role: StaffRole }
  | { kind: 'hours'; role: StaffRole };

export function parseStaffing(buffer: Buffer, sheetName = STAFFING_SHEET): StaffingParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const actual = wb.SheetNames.find((n) => n.trim().toLowerCase() === sheetName.trim().toLowerCase());
  if (!actual) throw new Error(`В книге нет листа «${sheetName}»`);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[actual], { header: 1, defval: null, raw: false });
  const header = (grid[0] ?? []).map((c) => String(c ?? '').trim());
  const warnings: string[] = [];

  const find = (title: string) => header.findIndex((h) => h.toLowerCase() === title.toLowerCase());
  const at = { name: find('Лавка'), grade: find('Грейд'), coffee: find('Кофемашина') };
  if (at.name < 0) throw new Error(`В листе «${actual}» нет колонки «Лавка» — это не шаблон по часам-пикам`);

  const columns = new Map<number, Column>();
  let lastRole: StaffRole | null = null;
  header.forEach((raw, i) => {
    const [head, tail = ''] = raw.split(/\r?\n/).map((s) => s.trim());
    const role = ROLE_BY_TITLE[head.toLowerCase()];
    if (role) {
      lastRole = role;
      if (/^fte$/i.test(tail)) {
        columns.set(i, { kind: 'fte', role });
        return;
      }
      const window = parseWindow(tail);
      if (window) columns.set(i, { kind: 'slot', role, ...window });
      else warnings.push(`Колонка «${raw.replace(/\s+/g, ' ')}»: окно «${tail}» не разобралось — пропущена`);
      return;
    }
    if (/чел/i.test(head) && /час/i.test(head) && lastRole) columns.set(i, { kind: 'hours', role: lastRole });
  });

  openEarlyWindows(grid, columns, warnings);

  const roles = new Set([...columns.values()].map((c) => c.role));
  for (const title of Object.keys(ROLE_BY_TITLE)) {
    if (!roles.has(ROLE_BY_TITLE[title])) warnings.push(`Нет колонок должности «${title}» — у всех лавок по ней 0`);
  }

  const norms: StaffNorm[] = [];
  const seen = new Set<string>();
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const shop = parseShop(row[at.name]);
    if (!shop) continue;
    if (seen.has(shop.code)) {
      warnings.push(`Строка ${r + 1}: лавка ${shop.code} встречается второй раз — взята первая`);
      continue;
    }
    seen.add(shop.code);

    const byRole = Object.fromEntries(
      Object.values(ROLE_BY_TITLE).map((role): [StaffRole, StaffRoleNorm] => [role, { slots: [], fte: null, hours: null }]),
    ) as Record<StaffRole, StaffRoleNorm>;

    for (const [i, col] of columns) {
      const value = toNumber(row[i]);
      const norm = byRole[col.role];
      if (col.kind === 'fte') norm.fte = value;
      else if (col.kind === 'hours') norm.hours = value;
      else {
        if (value == null) warnings.push(`Строка ${r + 1}: у ${shop.code} пустая клетка «${header[i].replace(/\s+/g, ' ')}» — считаем 0`);
        norm.slots.push({ from: col.from, to: col.to, count: value ?? 0 });
      }
    }

    const coffee = String(row[at.coffee] ?? '').trim().toLowerCase();
    norms.push({
      code: shop.code,
      // Код бывает и «М01», и «М 73»: срезаем его целиком, а не первое слово.
      name: String(row[at.name] ?? '').replace(/\s+/g, ' ').trim().replace(/^[А-ЯA-Zа-яa-z]{1,3}\s*\d{1,4}\s*/, ''),
      grade: at.grade >= 0 ? String(row[at.grade] ?? '').trim() || null : null,
      coffeeMachine: coffee === 'да' ? true : coffee === 'нет' ? false : null,
      roles: byRole,
    });
  }

  if (norms.length === 0) warnings.push(`В листе «${actual}» не нашлось ни одной лавки`);
  return { norms, warnings };
}

/**
 * Когда начинается окно «до 8».
 *
 * В заголовке начала нет, но под лавками в шаблоне есть служебная строка с
 * длиной каждого окна в часах: у повара «до 8» — 1,5 часа, то есть с 6:30, у
 * уборщика — 1 час, с 7:00. Верим ей, только если она сходится со всеми
 * окнами, где начало известно (6,5–7,5 → 1, 11–16 → 5…): иначе это может
 * оказаться итоговая строка, и начало смены выдумалось бы из суммы.
 *
 * Не нашлась или не сошлась — окно остаётся «с начала смены» (from: null).
 */
function openEarlyWindows(grid: readonly unknown[][], columns: Map<number, Column>, warnings: string[]): void {
  const slots = [...columns.entries()].filter(
    (e): e is [number, Extract<Column, { kind: 'slot' }>] => e[1].kind === 'slot',
  );
  const open = slots.filter(([, c]) => c.from == null);
  if (open.length === 0) return;

  const durations = grid.find((row) => {
    if (parseShop(row?.[0]) || row.some((v) => parseShop(v))) return false;
    return slots.every(([i, c]) => {
      const hours = toNumber(row[i]);
      if (hours == null || hours <= 0) return false;
      return c.from == null ? hours * 60 <= c.to : Math.abs(hours * 60 - (c.to - c.from)) < 1;
    });
  });

  if (!durations) {
    warnings.push('Строки с длиной окон не нашлось — окна «до N» считаются с начала смены');
    return;
  }
  for (const [i, c] of open) c.from = c.to - Math.round(toNumber(durations[i])! * 60);
}

/**
 * Окно из заголовка: «6.5-7,5» → 06:30–07:30, «до 8» → с начала смены до
 * 08:00, «11-16» → 11:00–16:00. Часы пишут и с точкой, и с запятой, а
 * половина часа — это «,5», а не «:30». На всякий случай понимаем и «6:30».
 */
export function parseWindow(text: string): { from: number | null; to: number } | null {
  const t = text.replace(/\s+/g, ' ').trim().toLowerCase();
  const until = /^до (\S+)$/.exec(t);
  if (until) {
    const to = hourToMinutes(until[1]);
    return to == null ? null : { from: null, to };
  }
  const range = /^(\S+?)\s*[-–—]\s*(\S+)$/.exec(t);
  if (!range) return null;
  const from = hourToMinutes(range[1]);
  const to = hourToMinutes(range[2]);
  return from == null || to == null || to <= from ? null : { from, to };
}

function hourToMinutes(value: string): number | null {
  const clock = /^(\d{1,2}):(\d{2})$/.exec(value);
  if (clock) return Number(clock[1]) * 60 + Number(clock[2]);
  const hours = Number(value.replace(',', '.'));
  return Number.isFinite(hours) && hours >= 0 && hours <= 24 ? Math.round(hours * 60) : null;
}

function toNumber(value: unknown): number | null {
  const text = String(value ?? '').replace(/\s/g, '').replace(',', '.');
  if (!text) return null;
  const n = Number(text);
  return Number.isFinite(n) ? n : null;
}
