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
 * «Все данные», всё остальное считается выгрузкой отметок (выходы и водители
 * имеют одинаковый формат колонок, различает их только должность).
 */

const LEGACY_SHEET = 'Все данные';
const SUPPORTED = /\.(xls|xlsx)$/i;

export interface FixtureFile {
  name: string;
  buffer: Buffer;
}

export interface FixtureSet {
  /** Легаси-книга «Витрины.xlsx», если лежит в папке. */
  legacy: FixtureFile | null;
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
  const { legacy, attendance } = readFixtures(dir);
  const parts = [legacy, ...attendance]
    .filter((f): f is FixtureFile => f !== null)
    .map((f) => `${f.name}:${crypto.createHash('sha1').update(f.buffer).digest('hex')}`)
    .sort();

  return crypto.createHash('sha1').update(parts.join('|')).digest('hex').slice(0, 12);
}

export function readFixtures(dir: string): FixtureSet {
  if (!fs.existsSync(dir)) {
    return { legacy: null, attendance: [], warnings: [`Папки ${dir} нет`] };
  }

  const names = fs
    .readdirSync(dir)
    .filter((f) => SUPPORTED.test(f) && !f.startsWith('~$') && !f.startsWith('.'))
    .sort();

  let legacy: FixtureFile | null = null;
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

    if (sheets.includes(LEGACY_SHEET)) {
      if (legacy) {
        warnings.push(`${name}: вторая легаси-книга, используется ${legacy.name}`);
        continue;
      }
      legacy = { name, buffer };
    } else {
      attendance.push({ name, buffer });
    }
  }

  if (!legacy && attendance.length === 0) {
    warnings.push(`В ${dir} нет ни одного файла .xls/.xlsx`);
  }

  return { legacy, attendance, warnings };
}
