import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';

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
export const SUPPORTED = /\.(xls|xlsx)$/i;

/** Что за файл нам дали. Кнопка загрузки опознаёт файл этими же правилами. */
export type FixtureKind = 'legacy' | 'delivery' | 'attendance';

/**
 * Тип файла определяется по именам листов — единственное место, где это
 * решается. Кнопка «Загрузить» на дашборде обязана опознавать файл так же,
 * как сборка снимка, иначе принятый файл потом не попадёт в нужную ветку.
 */
export function detectFixtureKind(sheetNames: readonly string[]): FixtureKind {
  if (sheetNames.includes(LEGACY_SHEET)) return 'legacy';
  if (sheetNames.includes(DELIVERY_SHEET)) return 'delivery';
  return 'attendance';
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
  const { legacy, delivery, attendance } = readFixtures(dir);
  const parts = [legacy, delivery, ...attendance]
    .filter((f): f is FixtureFile => f !== null)
    .map((f) => `${f.name}:${crypto.createHash('sha1').update(f.buffer).digest('hex')}`)
    .sort();

  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

export function readFixtures(dir: string): FixtureSet {
  if (!fs.existsSync(dir)) {
    return { legacy: null, delivery: null, attendance: [], warnings: [`Папки ${dir} нет`] };
  }

  const names = fs
    .readdirSync(dir)
    .filter((f) => SUPPORTED.test(f) && !f.startsWith('~$') && !f.startsWith('.'))
    .sort();

  let legacy: FixtureFile | null = null;
  let delivery: FixtureFile | null = null;
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

    const kind = detectFixtureKind(sheets);
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
    } else {
      attendance.push({ name, buffer });
    }
  }

  if (!legacy && !delivery && attendance.length === 0) {
    warnings.push(`В ${dir} нет ни одного файла .xls/.xlsx`);
  }

  return { legacy, delivery, attendance, warnings };
}
