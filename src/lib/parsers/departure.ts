import * as XLSX from 'xlsx';
import { parseShop } from '../shops';
import { parseStamp } from '../time';

/**
 * Выгрузка отметок по распределительному центру («РЦ Свобода»).
 *
 * Формат тот же, что у выгрузок отметок из 1С: Подразделение / Сотрудник /
 * Должность / Приход / Уход. Отличие одно, но решающее — в «Подразделении»
 * стоит не лавка, а склад, поэтому обычный парсер отметок отбрасывал все
 * строки и файл не принимался вовсе.
 *
 * Что здесь важно: **«Уход» — это выезд с РЦ**, то есть момент, когда машина
 * отправилась развозить. Именно его 01.09.2026 согласовали считать вместо
 * приезда водителя в лавку (см. rules.driverDeparture).
 *
 * Привязки к лавкам в файле нет и вывести её не из чего: люди из этой выгрузки
 * и водители, отмечающиеся в лавках, — почти разные (совпали 4 из 47), а
 * колонка «Маршрут» в журнале отгрузок пустая. Поэтому выезды живут как
 * сетевой показатель, а критерий лавки остаётся на приезде.
 */

export interface DepartureRow {
  date: string;
  employeeName: string;
  /** Подразделение из файла: «РЦ Свобода». */
  unit: string;
  role: string;
  /** Минуты от полуночи. Выезд — то, ради чего файл нужен. */
  departureMinutes: number | null;
  /** Приход на РЦ: справочно, в оценку не входит. */
  arrivalMinutes: number | null;
  rawDeparture: string | null;
}

export interface DepartureParseResult {
  rows: DepartureRow[];
  /** Подразделения, встретившиеся в файле: «РЦ Свобода». */
  units: string[];
  dates: string[];
  warnings: string[];
}

const COL = {
  unit: 'Подразделение',
  employee: 'Сотрудник',
  role: 'Должность',
  arrival: 'Приход',
  departure: 'Уход',
} as const;

/** Служебные строки: «Итого» в конце выгрузки. */
const SERVICE = new Set(['итого', 'всего', 'total']);

function columnIndex(header: readonly unknown[] | undefined, title: string): number {
  if (!header) return -1;
  return header.findIndex((c) => String(c ?? '').trim().toLowerCase() === title.toLowerCase());
}

/**
 * Похоже ли это на выгрузку по РЦ: колонки как у отметок, но в «Подразделении»
 * нет ни одной лавки.
 *
 * Проверяем именно отсутствие лавок, а не название склада: РЦ может
 * называться как угодно, и зашивать «Свобода» в код — значит сломаться на
 * втором складе.
 */
export function looksLikeDeparture(grid: readonly unknown[][]): boolean {
  const header = grid[0];
  const at = {
    unit: columnIndex(header, COL.unit),
    employee: columnIndex(header, COL.employee),
    departure: columnIndex(header, COL.departure),
  };
  if (at.unit < 0 || at.employee < 0 || at.departure < 0) return false;

  let units = 0;
  let shops = 0;
  for (let i = 1; i < grid.length; i++) {
    const raw = String(grid[i]?.[at.unit] ?? '').trim();
    if (!raw || SERVICE.has(raw.toLowerCase())) continue;

    if (parseShop(raw)) shops++;
    else units++;
  }

  return units > 0 && shops === 0;
}

/**
 * Строки из нескольких выгрузок по РЦ — в одну ленту.
 *
 * Файлы кладут по одному на день, но один и тот же день иногда попадает сразу
 * в две выгрузки: залили период 05–07, потом отдельно 08, потом переслали
 * исправленный 07. Складывать такие строки нельзя — водитель получил бы два
 * выезда там, где был один, — поэтому день целиком берётся из последней
 * выгрузки, где он есть. Порядок задаёт вызывающий: файлы отсортированы по
 * имени, а имя выгрузки начинается с её даты (см. canonicalFixtureName).
 */
export function mergeDepartures(files: readonly (readonly DepartureRow[])[]): DepartureRow[] {
  const byDate = new Map<string, DepartureRow[]>();

  for (const rows of files) {
    const incoming = new Map<string, DepartureRow[]>();
    for (const r of rows) {
      const day = incoming.get(r.date);
      if (day) day.push(r);
      else incoming.set(r.date, [r]);
    }
    for (const [date, day] of incoming) byDate.set(date, day);
  }

  return [...byDate.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .flatMap(([, rows]) => rows);
}

export function parseDepartures(buffer: Buffer): DepartureParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('В файле нет ни одного листа');

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  const header = grid[0];
  const at = {
    unit: columnIndex(header, COL.unit),
    employee: columnIndex(header, COL.employee),
    role: columnIndex(header, COL.role),
    arrival: columnIndex(header, COL.arrival),
    departure: columnIndex(header, COL.departure),
  };

  if (at.unit < 0 || at.employee < 0 || at.departure < 0) {
    throw new Error(
      `Нет колонок «${COL.unit}», «${COL.employee}» и «${COL.departure}» — это не выгрузка по РЦ`,
    );
  }

  const rows: DepartureRow[] = [];
  const warnings: string[] = [];
  const units = new Set<string>();
  const dates = new Set<string>();

  for (let i = 1; i < grid.length; i++) {
    const raw = grid[i] ?? [];
    const unit = String(raw[at.unit] ?? '').trim();
    const employeeName = String(raw[at.employee] ?? '').trim();
    if (!unit || SERVICE.has(unit.toLowerCase())) continue;
    if (!employeeName) continue;

    const departure = parseStamp(raw[at.departure]);
    const arrival = at.arrival >= 0 ? parseStamp(raw[at.arrival]) : null;

    // Дата берётся из выезда, а если его нет — из прихода: строка без обеих
    // отметок ни о чём не говорит.
    const date = departure?.date ?? arrival?.date ?? null;
    if (!date) {
      warnings.push(`Строка ${i + 1}: нет ни прихода, ни ухода — пропущена («${employeeName}»)`);
      continue;
    }

    if (!departure) {
      warnings.push(`Строка ${i + 1}: есть приход, но нет ухода — выезд неизвестен («${employeeName}»)`);
    }

    units.add(unit);
    dates.add(date);
    rows.push({
      date,
      employeeName,
      unit,
      role: at.role >= 0 ? String(raw[at.role] ?? '').trim() : '',
      departureMinutes: departure?.minutes ?? null,
      arrivalMinutes: arrival?.minutes ?? null,
      rawDeparture: departure ? String(raw[at.departure] ?? '') : null,
    });
  }

  if (rows.length === 0) warnings.push('В файле не нашлось ни одной строки с сотрудником');

  return {
    rows,
    units: [...units].sort(),
    dates: [...dates].sort(),
    warnings,
  };
}
