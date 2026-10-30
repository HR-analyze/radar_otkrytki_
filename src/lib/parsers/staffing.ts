import * as XLSX from 'xlsx';
import { parseShop } from '../shops';
import {
  EXTRA_ROLES,
  EXTRA_ROLE_SLOT,
  TEMPLATE_ROLES,
  parsePosts,
  type ExtraRole,
  type StaffNorm,
  type StaffPost,
  type StaffRole,
  type StaffRoleNorm,
  type TemplateRole,
} from '../staffing';

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
 * (вилка оборота) остаётся — по нему и подобраны нормы. Со второго листа,
 * «ШР по лавкам», берём одну колонку — «Сборщик заказа», сколько их в лавке;
 * фонд оплаты труда и всё остальное там не читается.
 *
 * Дислокации — строки прямо под строкой лавки: в колонке окна вписано, кто
 * где стоит («1 касса/2 прием»), в колонке «Лавка» — рабочие места лавки, в
 * прочих колонках — пометки. Блок кончается на первой строке без текста:
 * ниже последней лавки идут служебные строки (длины окон, суммы), а под ними
 * у части книг — строки-образцы, которые к последней лавке не относятся.
 */

export const STAFFING_SHEET = 'Шаблон по часам-пикам';

const ROLE_BY_TITLE: Record<string, TemplateRole> = {
  кассир: 'cashier',
  повар: 'cook',
  бариста: 'barista',
  уборщик: 'cleaner',
};

/**
 * Колонки должностей, которых в шаблоне по окнам нет. Числа в них не берём —
 * замы стоят константой, сборщики — по ШР, — а дислокации под лавкой берём.
 */
const EXTRA_BY_TITLE: Record<string, ExtraRole> = {
  'зд бар': 'barDeputy',
  'зд зал': 'hallDeputy',
  сборщик: 'picker',
};

export const SHR_SHEET = 'ШР по лавкам';

export interface StaffingParseResult {
  norms: StaffNorm[];
  warnings: string[];
}

type Column =
  | { kind: 'slot'; role: TemplateRole; from: number | null; to: number; index: number }
  | { kind: 'fte'; role: TemplateRole }
  | { kind: 'hours'; role: TemplateRole }
  | { kind: 'extra'; role: ExtraRole };

export function parseStaffing(buffer: Buffer, sheetName = STAFFING_SHEET): StaffingParseResult {
  // cellStyles — ради скрытых строк (`!rows[i].hidden`): см. «фильтр» ниже.
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false, cellStyles: true });
  const actual = wb.SheetNames.find((n) => n.trim().toLowerCase() === sheetName.trim().toLowerCase());
  if (!actual) throw new Error(`В книге нет листа «${sheetName}»`);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[actual], { header: 1, defval: null, raw: false });
  const header = (grid[0] ?? []).map((c) => String(c ?? '').trim());
  const warnings: string[] = [];

  const find = (title: string) => header.findIndex((h) => h.toLowerCase() === title.toLowerCase());
  const at = { name: find('Лавка'), grade: find('Грейд'), coffee: find('Кофемашина') };
  if (at.name < 0) throw new Error(`В листе «${actual}» нет колонки «Лавка» — это не шаблон по часам-пикам`);

  const columns = new Map<number, Column>();
  const slotCount: Partial<Record<TemplateRole, number>> = {};
  let lastRole: TemplateRole | null = null;
  header.forEach((raw, i) => {
    const [head, tail = ''] = raw.split(/\r?\n/).map((s) => s.trim());
    const extra = EXTRA_BY_TITLE[head.toLowerCase()];
    if (extra && !tail) {
      columns.set(i, { kind: 'extra', role: extra });
      return;
    }
    const role = ROLE_BY_TITLE[head.toLowerCase()];
    if (role) {
      lastRole = role;
      if (/^fte$/i.test(tail)) {
        columns.set(i, { kind: 'fte', role });
        return;
      }
      const window = parseWindow(tail);
      if (window) {
        const index = slotCount[role] ?? 0;
        slotCount[role] = index + 1;
        columns.set(i, { kind: 'slot', role, ...window, index });
      }
      else warnings.push(`Колонка «${raw.replace(/\s+/g, ' ')}»: окно «${tail}» не разобралось — пропущена`);
      return;
    }
    if (/чел/i.test(head) && /час/i.test(head) && lastRole) columns.set(i, { kind: 'hours', role: lastRole });
  });

  openEarlyWindows(grid, columns, warnings);

  const roles = new Set([...columns.values()].filter((c) => c.kind !== 'extra').map((c) => c.role));
  for (const title of Object.keys(ROLE_BY_TITLE)) {
    if (!roles.has(ROLE_BY_TITLE[title])) warnings.push(`Нет колонок должности «${title}» — у всех лавок по ней 0`);
  }

  const shr = readShr(wb, warnings);

  /*
   * Фильтр. ТД расписывают свои лавки в общей книге, включив автофильтр:
   * чужие лавки скрыты, и строку расстановки под М04 он вписывает туда, где
   * её видит, — а в файле между ними лежит скрытая М06. Поэтому видимая
   * строка расстановки относится к ближайшей ВИДИМОЙ лавке выше, а скрытая —
   * просто к лавке над ней. Проверено на семи книгах 28.10.2026: в 33 спорных
   * случаях из 44 расстановка сходится с нормой видимой лавки (у М04 — 16
   * окон из 16), со скрытой — в одном, в остальных поровну.
   */
  const sheet = wb.Sheets[actual];
  const top = sheet['!ref'] ? XLSX.utils.decode_range(sheet['!ref']).s.r : 0;
  const hidden = (r: number) => Boolean(sheet['!rows']?.[top + r]?.hidden);

  const norms: StaffNorm[] = [];
  const seen = new Set<string>();
  // Лавка, к которой относятся строки дислокаций ниже: последняя вообще и
  // последняя видимая; null — блок кончился.
  let current: StaffNorm | null = null;
  let visible: StaffNorm | null = null;
  for (let r = 1; r < grid.length; r++) {
    const row = grid[r] ?? [];
    const shop = parseShop(row[at.name]);
    if (!shop) {
      if (!row.some((v) => /[а-яa-z]/i.test(String(v ?? '')))) {
        current = null;
        visible = null;
        continue;
      }
      const target = hidden(r) ? current : visible;
      if (target) annotate(target, row, header, columns, at);
      continue;
    }
    if (seen.has(shop.code)) {
      warnings.push(`Строка ${r + 1}: лавка ${shop.code} встречается второй раз — взята первая`);
      current = null;
      if (!hidden(r)) visible = null;
      continue;
    }
    seen.add(shop.code);

    const byRole = Object.fromEntries(
      TEMPLATE_ROLES.map((role): [StaffRole, StaffRoleNorm] => [role, { slots: [], fte: null, hours: null }]),
    ) as Record<StaffRole, StaffRoleNorm>;
    for (const role of EXTRA_ROLES) {
      const count =
        role === 'picker' || role === 'sousChef' ? (shr[role]?.get(shop.code) ?? 0) : EXTRA_ROLE_SLOT[role].count;
      byRole[role] = {
        slots: [{ ...EXTRA_ROLE_SLOT[role], count }],
        fte: null,
        hours: null,
        // Замы стоят на кассе — так по постановке, что бы ни было вписано в книге.
        ...((role === 'barDeputy' || role === 'hallDeputy') && { posts: [[{ count: 1, place: DEPUTY_POST }]] }),
      };
    }

    for (const [i, col] of columns) {
      const value = toNumber(row[i]);
      const norm = byRole[col.role];
      if (col.kind === 'fte') norm.fte = value;
      else if (col.kind === 'hours') norm.hours = value;
      else if (col.kind === 'extra') continue;
      else {
        if (value == null) warnings.push(`Строка ${r + 1}: у ${shop.code} пустая клетка «${header[i].replace(/\s+/g, ' ')}» — считаем 0`);
        norm.slots.push({ from: col.from, to: col.to, count: value ?? 0 });
      }
    }

    const coffee = String(row[at.coffee] ?? '').trim().toLowerCase();
    current = {
      code: shop.code,
      // Код бывает и «М01», и «М 73»: срезаем его целиком, а не первое слово.
      name: String(row[at.name] ?? '').replace(/\s+/g, ' ').trim().replace(/^[А-ЯA-Zа-яa-z]{1,3}\s*\d{1,4}\s*/, ''),
      grade: at.grade >= 0 ? String(row[at.grade] ?? '').trim() || null : null,
      coffeeMachine: coffee === 'да' ? true : coffee === 'нет' ? false : null,
      roles: byRole,
    };
    norms.push(current);
    if (!hidden(r)) visible = current;
  }

  if (norms.length === 0) warnings.push(`В листе «${actual}» не нашлось ни одной лавки`);
  return { norms, warnings };
}

/**
 * Строка дислокаций под лавкой. Клетка окна — посты этого окна, клетка
 * «Лавка» — рабочие места, колонки замов и сборщика — их посты, остальной
 * текст (в «ТО план», «Грейд», «Су-шеф»…) — пометки. Числа в строке не
 * берём: в колонке «ТО план» под лавкой мог бы оказаться и сам план.
 */
function annotate(
  norm: StaffNorm,
  row: readonly unknown[],
  header: readonly string[],
  columns: Map<number, Column>,
  at: { name: number },
): void {
  const layout = (norm.layout ??= { stations: [], remarks: [] });
  row.forEach((value, i) => {
    if (typeof value !== 'string' || !/[а-яa-z]/i.test(value)) return;
    const text = value.replace(/\s+/g, ' ').trim();
    const col = columns.get(i);
    if (i === at.name) {
      layout.stations.push(...parsePosts(text));
    } else if (col?.kind === 'slot') {
      // «ЗД бар касса», «зд касса» в окне кассира — это замы, у них своя строка.
      addPosts(norm.roles[col.role], col.index, text, (p) => !DEPUTY_RE.test(p.place));
    } else if (col?.kind === 'extra') {
      if (col.role === 'picker') addPosts(norm.roles[col.role], 0, text);
    } else {
      const title = header[i]?.split(/\r?\n/)[0].trim();
      layout.remarks.push(title && !/^(то план|грейд|кофемашина)$/i.test(title) ? `${title}: ${text}` : text);
    }
  });
}

function addPosts(role: StaffRoleNorm, index: number, text: string, keep: (p: StaffPost) => boolean = () => true): void {
  const posts = parsePosts(text).filter(keep);
  if (posts.length === 0) return;
  role.posts ??= role.slots.map(() => []);
  while (role.posts.length <= index) role.posts.push([]);
  role.posts[index].push(...posts);
}

/** Пост зама в чужом окне: «ЗД бар касса», «зд касса», «1 ЗД прием», «зам доставка». */
const DEPUTY_RE = /^(зд|з\/д|зам)(?![а-я])/i;

/** Где стоят замы — всегда касса. */
export const DEPUTY_POST = 'касса';

/**
 * Сколько сборщиков и су-шефов у каждой лавки — из листа «ШР по лавкам»,
 * колонки «Сборщик заказа» и «су-шеф» (первые с таким заголовком: правее
 * лежит фонд оплаты труда с теми же заголовками — его не читаем).
 *
 * Сборщик — целым числом. Су-шеф бывает 0,5 (М35, М68 в ШР 30.10.2026) —
 * берём как есть, с точностью до половины: «0,5 су-шефа» считается в
 * человеко-часах и деньгах как половина.
 */
function readShr(wb: XLSX.WorkBook, warnings: string[]): Partial<Record<'picker' | 'sousChef', Map<string, number>>> {
  const name = wb.SheetNames.find((n) => n.trim().toLowerCase() === SHR_SHEET.toLowerCase());
  if (!name) {
    warnings.push(`Нет листа «${SHR_SHEET}» — сборщиков заказов и су-шефов не ставим`);
    return {};
  }
  const rows = XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[name], { header: 1, defval: null, raw: false });
  const head = rows.findIndex((r) => String(r?.[0] ?? '').trim().toLowerCase() === 'регион');
  const find = (re: RegExp) => (head < 0 ? -1 : rows[head].findIndex((v) => re.test(String(v ?? ''))));
  const read = (col: number, title: string, step: number): Map<string, number> => {
    const out = new Map<string, number>();
    for (const row of rows.slice(head + 1)) {
      const shop = parseShop(row?.[0]);
      const n = toNumber(row?.[col]);
      if (!shop || n == null) continue;
      const rounded = Math.round(n / step) * step;
      if (rounded !== n) warnings.push(`«${name}»: у ${shop.code} ${title} ${n} — округлили до ${rounded}`);
      out.set(shop.code, rounded);
    }
    return out;
  };
  const out: Partial<Record<'picker' | 'sousChef', Map<string, number>>> = {};
  const picker = find(/сборщик/i);
  if (picker < 0) warnings.push(`В листе «${name}» нет колонки «Сборщик заказа» — сборщиков заказов не ставим`);
  else out.picker = read(picker, 'сборщиков', 1);
  const chef = find(/су-?\s*шеф/i);
  if (chef < 0) warnings.push(`В листе «${name}» нет колонки «су-шеф» — су-шефов не ставим`);
  else out.sousChef = read(chef, 'су-шефов', 0.5);
  return out;
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
