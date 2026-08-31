import * as XLSX from 'xlsx';
import { detectFixtureKind, SUPPORTED, type FixtureKind } from './fixtures';
import { parseAttendanceBuffer } from './parsers/attendance';
import { parseDeliveryTimes } from './parsers/delivery';
import { parseLegacyVitriny } from './parsers/legacy-vitriny';
import { plural } from './plural';
import { shortDate } from './time';
import type { ThresholdConfig } from './types';

/**
 * Разбор файла, пришедшего кнопкой «Загрузить» с дашборда.
 *
 * Файл никуда не кладётся, пока его не удалось прочитать теми же парсерами,
 * которыми собирается снимок: приняли — значит данные из него точно доедут.
 * Отсюда же берётся фраза «файл распознан» для UI: человек должен увидеть,
 * что именно система поняла — тип выгрузки, дни и объём, — а не просто «ок».
 */

/**
 * Больше 4.5 МБ serverless-функция Vercel не принимает вовсе (413 ещё до нашего
 * кода), поэтому режем раньше и с внятным текстом. Самая большая реальная
 * выгрузка — шесть дней «выходов» — весит 744 КБ, запас десятикратный.
 */
export const MAX_UPLOAD_BYTES = 4 * 1024 * 1024;

export interface UploadInspection {
  /** Имя файла как его дал пользователь. */
  originalName: string;
  kind: FixtureKind;
  /** Имя, под которым файл ляжет в fixtures/ — см. canonicalFixtureName. */
  fileName: string;
  /** Готовая строка для UI: «Выгрузка „водители“ · 28.08 · 76 отметок». */
  summary: string;
  dates: string[];
  rows: number;
  shops: number;
  /** Предупреждения парсера — их видно в панели загрузки, но приёму они не мешают. */
  warnings: string[];
}

export type InspectResult =
  | { ok: true; file: UploadInspection }
  | { ok: false; originalName: string; error: string };

/** Подмножество выгрузки отметок: только водители, только сотрудники или всё вместе. */
export type AttendanceFlavor = 'voditeli' | 'vyhody' | 'otmetki';

export function isSupportedFileName(name: string): boolean {
  return SUPPORTED.test(name);
}

/**
 * Имя файла из браузера — недоверенная строка: в ней бывают пути (Safari отдаёт
 * полный путь), кавычки и управляющие символы. На диск и в репозиторий уходит
 * не она, а каноническое имя, но человеку её показываем — поэтому чистим.
 */
export function safeDisplayName(name: string): string {
  const base = name.split(/[\\/]/).pop() ?? '';
  return base.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, 120) || 'без имени';
}

function extensionOf(name: string): string {
  const m = /\.(xls|xlsx)$/i.exec(name);
  return m ? m[1].toLowerCase() : 'xls';
}

/**
 * Имя файла в `fixtures/` выводится из содержимого, а не из того, как файл
 * назвали на диске.
 *
 * Иначе повторная загрузка того же дня («выгрузка (1).xls») положила бы рядом
 * второй файл: отметки задвоились бы, а вторая легаси-книга и вовсе молча не
 * попала бы в снимок — `readFixtures` берёт только первую. С каноническим
 * именем повторная загрузка заменяет файл, как и ожидает человек.
 */
export function canonicalFixtureName(
  kind: FixtureKind,
  dates: readonly string[],
  originalName: string,
  flavor: AttendanceFlavor = 'otmetki',
): string {
  const ext = extensionOf(originalName);
  if (kind === 'legacy') return `vitriny.${ext}`;
  if (kind === 'delivery') return `vremya-postavki.${ext}`;

  const sorted = [...dates].sort();
  const span =
    sorted.length > 1 && sorted[0] !== sorted[sorted.length - 1]
      ? `${sorted[0]}_${sorted[sorted.length - 1]}`
      : sorted[0];
  return `${span}_${flavor}.${ext}`;
}

/** Тот же файл, но с другим расширением: vitriny.xls рядом с vitriny.xlsx. */
export function isSupersededBy(existingName: string, newName: string): boolean {
  const stem = (n: string) => n.replace(/\.(xls|xlsx)$/i, '').toLowerCase();
  return existingName !== newName && stem(existingName) === stem(newName);
}

export function inspectUpload(
  originalName: string,
  buffer: Buffer,
  config: ThresholdConfig,
): InspectResult {
  const displayName = safeDisplayName(originalName);
  const reject = (error: string): InspectResult => ({ ok: false, originalName: displayName, error });

  if (!isSupportedFileName(displayName)) {
    return reject('Нужен файл .xls или .xlsx — как приходит выгрузка из 1С.');
  }
  if (buffer.length === 0) return reject('Файл пустой.');
  if (buffer.length > MAX_UPLOAD_BYTES) {
    return reject(
      `Файл весит ${Math.round(buffer.length / 1024 / 1024)} МБ, а больше ` +
        `${Math.round(MAX_UPLOAD_BYTES / 1024 / 1024)} МБ загрузить нельзя. ` +
        'Выгрузите период покороче.',
    );
  }

  let sheetNames: string[];
  try {
    // bookSheets: сначала только имена листов — по ним и определяется тип.
    sheetNames = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
  } catch (e) {
    return reject(
      `Не удалось прочитать книгу Excel (${e instanceof Error ? e.message : String(e)}). ` +
        'Похоже, это не выгрузка из 1С.',
    );
  }

  try {
    const kind = detectFixtureKind(sheetNames);
    if (kind === 'legacy') return inspectLegacy(displayName, buffer, config);
    if (kind === 'delivery') return inspectDelivery(displayName, buffer);
    return inspectAttendance(displayName, buffer, config);
  } catch (e) {
    return reject(`Разбор не удался: ${e instanceof Error ? e.message : String(e)}`);
  }
}

function inspectAttendance(name: string, buffer: Buffer, config: ThresholdConfig): InspectResult {
  const parsed = parseAttendanceBuffer(buffer, config);

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      originalName: name,
      error:
        'Ни одной строки с лавкой и сотрудником. Для выгрузки отметок нужны колонки ' +
        '«Подразделение», «Сотрудник», «Должность», «Приход».',
    };
  }
  if (parsed.dates.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'В файле нет ни одной даты — по колонкам «Приход»/«Уход» день определить не вышло.',
    };
  }

  const drivers = parsed.rows.filter((r) => r.criterion === 'driver').length;
  const flavor: AttendanceFlavor =
    drivers === parsed.rows.length ? 'voditeli' : drivers === 0 ? 'vyhody' : 'otmetki';
  const title =
    flavor === 'voditeli'
      ? 'Выгрузка «водители»'
      : flavor === 'vyhody'
        ? 'Выгрузка «выходы»'
        : 'Выгрузка отметок: водители и сотрудники вместе';

  const shops = new Set(parsed.rows.map((r) => r.shopCode)).size;

  // Смена, которая кончилась после полуночи, даёт одну-две отметки следующим
  // днём. Днями выгрузки они не считаются: иначе файл за 29-е назывался бы
  // «29–30 августа» из-за двух уборщиков, ушедших в 4 утра.
  const main = mainDates(parsed.rows.map((r) => r.date));
  const strays = parsed.rows.filter((r) => !main.includes(r.date)).length;

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'attendance',
      fileName: canonicalFixtureName('attendance', main, name, flavor),
      summary:
        `${title} · ${describeDates(main)} · ${parsed.rows.length} ` +
        `${plural(parsed.rows.length, 'отметка', 'отметки', 'отметок')}, ` +
        `${shops} ${plural(shops, 'лавка', 'лавки', 'лавок')}` +
        (strays > 0
          ? ` · ещё ${strays} ${plural(strays, 'отметка', 'отметки', 'отметок')} после полуночи ` +
            `(${parsed.dates.filter((d) => !main.includes(d)).map(shortDate).join(', ')})`
          : ''),
      dates: parsed.dates,
      rows: parsed.rows.length,
      shops,
      warnings: parsed.warnings.map((w) => w.message),
    },
  };
}

function inspectLegacy(name: string, buffer: Buffer, config: ThresholdConfig): InspectResult {
  const parsed = parseLegacyVitriny(buffer, config);

  if (parsed.shops.length === 0 || parsed.dates.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'Лист «Все данные» есть, но лавок или дат в нём не нашлось.',
    };
  }

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'legacy',
      fileName: canonicalFixtureName('legacy', parsed.dates, name),
      summary:
        `Книга «Витрины» · ${describeDates(parsed.dates)} · ` +
        `${parsed.shops.length} ${plural(parsed.shops.length, 'лавка', 'лавки', 'лавок')}, ` +
        `наполнение витрины по ${parsed.showcase.length} лавко-дням`,
      dates: parsed.dates,
      rows: parsed.people.length + parsed.showcase.length,
      shops: parsed.shops.length,
      warnings: parsed.warnings,
    },
  };
}

function inspectDelivery(name: string, buffer: Buffer): InspectResult {
  const parsed = parseDeliveryTimes(buffer);

  if (parsed.rows.length === 0) {
    return {
      ok: false,
      originalName: name,
      error: 'Лист «Время поставки» есть, но времени отгрузки в нём не нашлось.',
    };
  }

  const shops = new Set(parsed.rows.map((r) => r.shopCode)).size;

  return {
    ok: true,
    file: {
      originalName: name,
      kind: 'delivery',
      fileName: canonicalFixtureName('delivery', parsed.dates, name),
      summary:
        `Журнал «Время поставки» · ${describeDates(parsed.dates)} · ` +
        `${parsed.rows.length} ${plural(parsed.rows.length, 'отгрузка', 'отгрузки', 'отгрузок')}, ` +
        `${shops} ${plural(shops, 'лавка', 'лавки', 'лавок')}`,
      dates: parsed.dates,
      rows: parsed.rows.length,
      shops,
      warnings: parsed.warnings,
    },
  };
}

/**
 * Дни, за которые выгрузка сделана, в отличие от дней, которые в ней просто
 * упомянуты. Отсечка по доле строк: за настоящий день их сотни, за «хвост»
 * ночной смены — единицы.
 */
function mainDates(dates: readonly string[]): string[] {
  const counts = new Map<string, number>();
  for (const d of dates) counts.set(d, (counts.get(d) ?? 0) + 1);
  if (counts.size === 0) return [];

  const max = Math.max(...counts.values());
  return [...counts]
    .filter(([, n]) => n >= max * 0.1)
    .map(([d]) => d)
    .sort();
}

function describeDates(dates: readonly string[]): string {
  const sorted = [...dates].sort();
  if (sorted.length === 0) return 'дат нет';
  if (sorted.length === 1) return shortDate(sorted[0]);
  return (
    `${shortDate(sorted[0])} — ${shortDate(sorted[sorted.length - 1])} ` +
    `(${sorted.length} ${plural(sorted.length, 'день', 'дня', 'дней')})`
  );
}
