import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { looksLikeDeparture } from './parsers/departure';

/**
 * Чтение папки с выгрузками.
 *
 * Файлы не перечисляются в коде: чтобы добавить данные за новый день,
 * достаточно положить очередную выгрузку в `fixtures/` — имя может быть любым.
 * Дата берётся из содержимого отметок, а не из имени файла.
 *
 * Тип файла определяется по листам: легаси-книга «Витрины» опознаётся по листу
 * «Все данные», журнал отгрузок — по листу «Время поставки», всё остальное
 * считается выгрузкой отметок (выходы и водители имеют одинаковый формат
 * колонок, различает их только должность).
 */

const LEGACY_SHEET = 'Все данные';
const DELIVERY_SHEET = 'Время поставки';
const ROSTER_SHEET = 'Лавки БК';
export const SUPPORTED = /\.(xls|xlsx)$/i;

/** Что за файл нам дали. Кнопка загрузки опознаёт файл этими же правилами. */
export type FixtureKind = 'legacy' | 'delivery' | 'roster' | 'departure' | 'attendance';

/** Сколько строк читать для опознания: заголовок плюс запас на «шапку». */
const PEEK_ROWS = 30;

/**
 * Тип файла — единственное место, где это решается. Кнопка «Загрузить» на
 * дашборде обязана опознавать файл так же, как сборка снимка, иначе принятый
 * файл потом не попадёт в нужную ветку.
 *
 * Легаси-книга, журнал отгрузок и справочник различаются по именам листов.
 * Выгрузка по РЦ — нет: лист называется «Лист_1», как у обычных отметок, и
 * отличается она только содержимым «Подразделения» (склад вместо лавки).
 * Поэтому для неё нужен `grid` — первые строки файла.
 */
export function detectFixtureKind(
  sheetNames: readonly string[],
  grid?: readonly unknown[][],
): FixtureKind {
  // Имена листов в реальных файлах бывают с хвостовым пробелом («Лавки БК »).
  const names = sheetNames.map((n) => n.trim());
  if (names.includes(LEGACY_SHEET)) return 'legacy';
  if (names.includes(DELIVERY_SHEET)) return 'delivery';
  if (names.includes(ROSTER_SHEET)) return 'roster';
  if (grid && looksLikeDeparture(grid)) return 'departure';
  return 'attendance';
}

/** Первые строки первого листа — для опознания по содержимому. */
export function peekGrid(buffer: Buffer): unknown[][] {
  try {
    const wb = XLSX.read(buffer, { type: 'buffer', sheetRows: PEEK_ROWS, raw: false });
    const sheet = wb.Sheets[wb.SheetNames[0]];
    if (!sheet) return [];
    return XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  } catch {
    return [];
  }
}

export interface FixtureFile {
  name: string;
  buffer: Buffer;
}

export interface FixtureSet {
  /** Легаси-книга «Витрины.xlsx», если лежит в папке. */
  legacy: FixtureFile | null;
  /** Журнал отгрузок «Время поставки», если лежит в папке. */
  delivery: FixtureFile | null;
  /** Справочник лавок «Лавки БК» — кто из РМ за какую лавку отвечает. */
  roster: FixtureFile | null;
  /** Выгрузка по РЦ: во сколько водители выехали со склада. */
  departure: FixtureFile | null;
  /** Выгрузки отметок, отсортированные по имени. */
  attendance: FixtureFile[];
  warnings: string[];
}

/**
 * Отпечаток содержимого папки: имена плюс хеш каждого файла.
 *
 * Снимок собирается из этих файлов, поэтому отпечаток пишется внутрь снимка.
 * Если выгрузку положили, а снимок не пересобрали, отпечатки разойдутся и
 * `npm test` это поймает — иначе данные молча остались бы старыми.
 */
export function fixturesFingerprint(dir: string): string {
  const { legacy, delivery, roster, attendance } = readFixtures(dir);
  const parts = [legacy, delivery, roster, ...attendance]
    .filter((f): f is FixtureFile => f !== null)
    .map((f) => `${f.name}:${crypto.createHash('sha1').update(f.buffer).digest('hex')}`)
    .sort();

  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

export function readFixtures(dir: string): FixtureSet {
  if (!fs.existsSync(dir)) {
    return {
      legacy: null,
      delivery: null,
      roster: null,
      departure: null,
      attendance: [],
      warnings: [`Папки ${dir} нет`],
    };
  }

  const names = fs
    .readdirSync(dir)
    .filter((f) => SUPPORTED.test(f) && !f.startsWith('~$') && !f.startsWith('.'))
    .sort();

  let legacy: FixtureFile | null = null;
  let delivery: FixtureFile | null = null;
  let roster: FixtureFile | null = null;
  let departure: FixtureFile | null = null;
  const attendance: FixtureFile[] = [];
  const warnings: string[] = [];

  for (const name of names) {
    const buffer = fs.readFileSync(path.join(dir, name));

    let sheets: string[];
    try {
      // bookSheets: читаем только имена листов, содержимое не разбираем.
      sheets = XLSX.read(buffer, { type: 'buffer', bookSheets: true }).SheetNames;
    } catch (e) {
      warnings.push(`${name}: не удалось прочитать (${e instanceof Error ? e.message : e})`);
      continue;
    }

    // Содержимое читаем только когда по листам файл неотличим от отметок:
    // выгрузка по РЦ выглядит так же и различается лишь «Подразделением».
    const byName = detectFixtureKind(sheets);
    const kind = byName === 'attendance' ? detectFixtureKind(sheets, peekGrid(buffer)) : byName;
    if (kind === 'legacy') {
      if (legacy) {
        warnings.push(`${name}: вторая легаси-книга, используется ${legacy.name}`);
        continue;
      }
      legacy = { name, buffer };
    } else if (kind === 'delivery') {
      if (delivery) {
        warnings.push(`${name}: второй журнал отгрузок, используется ${delivery.name}`);
        continue;
      }
      delivery = { name, buffer };
    } else if (kind === 'roster') {
      if (roster) {
        warnings.push(`${name}: второй справочник лавок, используется ${roster.name}`);
        continue;
      }
      roster = { name, buffer };
    } else if (kind === 'departure') {
      if (departure) {
        warnings.push(`${name}: вторая выгрузка по РЦ, используется ${departure.name}`);
        continue;
      }
      departure = { name, buffer };
    } else {
      attendance.push({ name, buffer });
    }
  }

  if (!legacy && !delivery && !roster && !departure && attendance.length === 0) {
    warnings.push(`В ${dir} нет ни одного файла .xls/.xlsx`);
  }

  return { legacy, delivery, roster, departure, attendance, warnings };
}
