import * as XLSX from 'xlsx';
import { parseShop } from '../shops';
import { formatClock, parseClock } from '../time';
import type { ShopNorms } from '../types';

/**
 * Парсер справочника «Лавки»: нормативы открытия по каждой лавке.
 *
 * Лист — одна строка на лавку. Радару из неё нужны две колонки:
 * «время приезда водителя» и «количество поваров и тайминг». Размеры витрин
 * в том же листе есть, но на статусы не влияют и не разбираются.
 *
 * Справочник ведут руками, поэтому время пишут и через точку, и через
 * двоеточие («6.30», «06:00:00»), а тайминг поваров — свободным текстом
 * («3 с 6.20», «1 с 6.00/2 6:30», «повар в 5.45»). Всё это приводится к
 * «ЧЧ:ММ» и списку смен; где привести не удалось, строка получает
 * предупреждение — выдумывать время за человека нельзя, но и молча терять
 * строку тоже.
 */

/** Заголовки колонок листа → поля. Сопоставляем по подстроке: заголовки правят. */
const COLUMNS: { key: keyof ParsedColumns; match: RegExp }[] = [
  { key: 'code', match: /^№/ },
  { key: 'name', match: /назван/i },
  { key: 'driver', match: /водител/i },
  { key: 'cook', match: /повар/i },
];

interface ParsedColumns {
  code: number;
  name: number;
  driver: number;
  cook: number;
}

export interface ShopNormsParseResult {
  norms: ShopNorms[];
  /** Проблемы уровня книги: непонятые строки, дубли кодов. */
  warnings: string[];
}

export function parseShopNorms(buffer: Buffer, sheetName?: string): ShopNormsParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', raw: true, codepage: 65001 });
  const name = sheetName ?? wb.SheetNames[0];
  const sheet = wb.Sheets[name];
  if (!sheet) throw new Error(`В книге нет листа «${name}»`);

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: true });
  if (grid.length < 2) throw new Error(`Лист «${name}» пуст`);

  const cols = mapColumns(grid[0]);
  const warnings: string[] = [];
  const norms: ShopNorms[] = [];
  const seen = new Set<string>();

  for (let i = 1; i < grid.length; i++) {
    const row = grid[i];
    if (!row || row.every((c) => c == null || String(c).trim() === '')) continue;

    // Код и название лежат в разных колонках («М05» | «Щепкина»), а parseShop
    // ждёт их вместе — так же, как они приходят из выгрузок 1С.
    const rawCode = text(row[cols.code]);
    const rawName = text(row[cols.name]);
    const shop = parseShop(`${rawCode} ${rawName}`);
    if (!shop) {
      warnings.push(`Строка ${i + 1}: не разобрал лавку «${rawCode} ${rawName}» — пропущена`);
      continue;
    }
    if (seen.has(shop.code)) {
      warnings.push(`Строка ${i + 1}: ${shop.code} встречается второй раз — взята первая`);
      continue;
    }
    seen.add(shop.code);

    norms.push(parseRow(shop.code, rawName || shop.name, row, cols));
  }

  return { norms, warnings };
}

function parseRow(code: string, name: string, row: unknown[], cols: ParsedColumns): ShopNorms {
  const rowWarnings: string[] = [];

  const rawDriver = text(row[cols.driver]);
  const driverAt = parseNormTime(rawDriver);
  if (rawDriver && !driverAt) {
    rowWarnings.push(`не разобрал время приезда водителя «${rawDriver}»`);
  }

  const rawCook = text(row[cols.cook]);
  const cookAt = parseCookTimes(rawCook);
  if (rawCook && cookAt.length === 0) {
    rowWarnings.push(`не разобрал тайминг поваров «${rawCook}»`);
  }

  return {
    code,
    name,
    driverAt,
    cookAt,
    // Исходные строки нужны в редакторе: человек сверяет разобранное время с
    // тем, что написано в справочнике, не открывая саму книгу.
    rawDriver: rawDriver || null,
    rawCook: rawCook || null,
    source: 'reference',
    warnings: rowWarnings,
  };
}

function mapColumns(header: unknown[]): ParsedColumns {
  const found: Partial<ParsedColumns> = {};
  for (const { key, match } of COLUMNS) {
    const idx = header.findIndex((cell) => match.test(text(cell)));
    if (idx >= 0) found[key] = idx;
  }

  const missing = COLUMNS.filter(({ key }) => found[key] === undefined).map(({ key }) => key);
  if (missing.length > 0) {
    throw new Error(`В заголовке листа не нашлись колонки: ${missing.join(', ')}`);
  }
  return found as ParsedColumns;
}

/* -------------------------------------------------------------------- время */

/** Часть строки, похожая на время: «6.30», «06:00:00», «7». */
const TIME = String.raw`\d{1,2}(?:[.:]\d{1,2})?(?::\d{2})?`;

/**
 * Время норматива → «ЧЧ:ММ».
 *
 * В справочнике час от минут отделяют и точкой, и двоеточием, секунды пишут
 * не всегда: «6.30», «6:40», «06:00:00», «7» — всё это одно и то же время дня.
 * Точка тут именно разделитель, а не дробная часть часа: «5.50» — это 5:50,
 * что видно по соседним лавкам, где та же смена записана как «5:50».
 */
export function parseNormTime(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;

  // Значение должно быть временем целиком, а не начинаться с него: в
  // справочнике встречаются телефоны («8 (968) 636-95-27»), и разбор «по
  // началу строки» превратил бы такой номер в норму «08:00».
  const m = new RegExp(`^(${TIME})$`).exec(raw.replace(/\s+/g, ''));
  if (!m) return null;

  const [h, min = '0'] = m[1].split(/[.:]/);
  const hours = Number(h);
  // «6.3» в справочнике не встречается, но если появится — это 6:30, а не 6:03:
  // минуты пишут двузначными, одинокая цифра — оборванный десяток.
  const minutes = min.length === 1 ? Number(min) * 10 : Number(min);
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null;
  if (hours > 23 || minutes > 59) return null;

  return formatClock(hours * 60 + minutes);
}

/* ------------------------------------------------------------ смены поваров */

/**
 * Время в паре «сколько человек — к какому часу»: «3 с 6.20», «2 в 6:00».
 *
 * Количество в норму не идёт (см. ShopNorms.cookAt), но распознать его всё
 * равно нужно: без этого «3» из «3 с 6.20» само сошло бы за время 03:00.
 * Lookbehind защищает от захода внутрь числа — иначе «повар 6.10» разбирался
 * бы как «1 человек к 0:00»: движок цепляется за «1» внутри «6.10» и добирает
 * «0» как время.
 */
const SHIFT_RE = new RegExp(
  String.raw`(?<![\d.:])(\d+)\s*(?:с|в)\s*(${TIME})(?![\d.:])`,
  'g',
);

/** Время, написанное само по себе: «6:30». Разделитель обязателен — см. выше. */
const BARE_TIME_RE = /(?<![\d.:])\d{1,2}[.:]\d{1,2}(?::\d{2})?(?![\d.:])/g;

/**
 * «3 с 6.20» → ['06:20'], «1 с 6.00/2 6:30» → ['06:00', '06:30'].
 *
 * Формы записи в справочнике: «2 с 5:30 1 с 6:00», «1 с 6.00/2 6:30»,
 * «2 в 6:00/1 в 6:30», «повар в 5.45». Разбирается и то, что человек введёт
 * в редакторе руками: «6:20», «6:00 / 6:30».
 *
 * Из строки берутся только часы: сколько поваров вышло, радар видит из
 * выгрузки отметок, а норма — это час, к которому лавка укомплектована.
 */
export function parseCookTimes(value: unknown): string[] {
  const raw = text(value);
  if (!raw) return [];

  const times: string[] = [];
  // Позиции, уже съеденные парой «N с ЧЧ:ММ»: без них время из пары попало бы
  // в результат дважды — и как часть пары, и как «время само по себе».
  const taken: [number, number][] = [];

  for (const m of raw.matchAll(SHIFT_RE)) {
    const at = parseNormTime(m[2]);
    if (at) times.push(at);
    taken.push([m.index, m.index + m[0].length]);
  }

  for (const m of raw.matchAll(BARE_TIME_RE)) {
    if (taken.some(([from, to]) => m.index >= from && m.index < to)) continue;
    const at = parseNormTime(m[0]);
    if (at) times.push(at);
  }

  return sortTimes(times);
}

/** Времена от ранних к поздним, без повторов. */
export function sortTimes(times: readonly string[]): string[] {
  return [...new Set(times)].sort((a, b) => parseClock(a) - parseClock(b));
}

/** Времена → «06:20» / «06:00 / 06:30» для показа человеку и для поля ввода. */
export function formatCookTimes(times: readonly string[]): string {
  return times.length === 0 ? '—' : times.join(' / ');
}

function text(value: unknown): string {
  if (value == null) return '';
  return String(value).replace(/\s+/g, ' ').trim();
}
