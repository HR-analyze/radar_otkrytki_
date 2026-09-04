import * as XLSX from 'xlsx';
import type { AttendanceRow, ThresholdConfig } from '../types';
import { parseShop } from '../shops';
import { isIgnoredRole, mapRole, resolveArrival, statusForTime } from '../status';
import { parseStamp } from '../time';

/**
 * Парсер выгрузок отметок (и «выходы», и «водители» — формат колонок одинаковый,
 * различает их только должность).
 *
 * Форматов выгрузки два, и оба живые:
 *
 *   плоский — одна строка на отметку, шапка в одну строку:
 *     Подразделение | Сотрудник | Должность | Подразделение сотрудника |
 *     Приход | Уход | Часов фактически | Часов ночь
 *
 *   парный — так печатает 1С с группировкой (появился в выгрузках с 29.08.2026):
 *     шапка занимает две строки, а запись — строку сотрудника и следом одну
 *     или несколько строк отметок:
 *       [0] Сотрудник | Должность | Подразделение сотрудника | Часов фактически | Часов ночь
 *       [1] Подразделение | Приход | Уход
 *       [2] Фокин Александр Александрович | Водитель-экспедитор | Департамент … | 0.50
 *       [3] М11 Тверская-Ямская | 30.08.2026 6:25:04 | 30.08.2026 6:52:41
 *       [4] М10 Брестская       | 30.08.2026 7:01:55 | 30.08.2026 7:13:15
 *     Несколько строк отметок у одного человека — это не дубль: водитель за
 *     смену объезжает несколько лавок, и каждая лавка ждёт своего приезда.
 *
 * Формат определяется по шапке, а не по имени файла или расширению: обе
 * выгрузки называются как угодно и приходят и в .xls, и в .xlsx.
 *
 * Особенности реальных файлов, учтённые здесь:
 *  - старый формат .xls (BIFF), не .xlsx;
 *  - последняя строка — «Итого», её надо выбросить;
 *  - в «выходы» колонка «Уход» пустая в 332 строках из 336 — на неё нельзя опираться;
 *  - у водителей заполнены обе колонки;
 *  - в названиях лавок встречаются хвостовые пробелы и переименования.
 */

export interface AttendanceParseResult {
  rows: AttendanceRow[];
  /** Даты, встреченные в файле (обычно одна). */
  dates: string[];
  warnings: ParseWarning[];
  /** Каким форматом оказалась выгрузка — видно в панели загрузки. */
  layout: AttendanceLayout;
}

export interface ParseWarning {
  kind: 'unknown_role' | 'no_shop' | 'no_stamps' | 'shop_mismatch' | 'no_date';
  message: string;
  row?: number;
}

export type AttendanceLayout = 'flat' | 'paired';

/** Строка выгрузки, приведённая к общему виду независимо от формата файла. */
interface SourceRow {
  /** Номер строки в Excel — с ним предупреждение можно проверить глазами. */
  rowNo: number;
  shop: unknown;
  employee: unknown;
  role: unknown;
  homeShop: unknown;
  arrival: unknown;
  departure: unknown;
}

const COL = {
  shop: 'Подразделение',
  employee: 'Сотрудник',
  role: 'Должность',
  homeShop: 'Подразделение сотрудника',
  arrival: 'Приход',
  departure: 'Уход',
} as const;

/** Служебные строки, которые не являются ни сотрудником, ни лавкой. */
const SERVICE_LABELS = new Set(['итого', 'всего', 'total']);

export function parseAttendanceBuffer(
  buffer: Buffer,
  config: ThresholdConfig,
  /** Дата отчёта, если в файле не удалось её вывести из отметок. */
  fallbackDate?: string,
): AttendanceParseResult {
  const wb = XLSX.read(buffer, { type: 'buffer', cellDates: false, raw: false });
  const sheet = wb.Sheets[wb.SheetNames[0]];
  if (!sheet) throw new Error('В файле нет ни одного листа');

  const grid = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, defval: null, raw: false });
  const layout = detectLayout(grid);
  const source = layout === 'paired' ? readPaired(grid) : readFlat(grid);

  const rows: AttendanceRow[] = [];
  const warnings: ParseWarning[] = [...source.warnings];
  const dates = new Set<string>();

  const shopField = config.rules.shopField.use;

  for (const r of source.rows) {
    const rowNo = r.rowNo;

    const markShop = parseShop(r.shop);
    const homeShop = parseShop(r.homeShop);
    const employeeName = String(r.employee ?? '').trim();

    // Строка «Итого» и прочие служебные — parseShop вернёт null.
    if (!markShop && !employeeName) continue;

    const shop = shopField === 'Подразделение сотрудника' ? (homeShop ?? markShop) : markShop;
    if (!shop) {
      warnings.push({
        kind: 'no_shop',
        message: `Строка ${rowNo}: не удалось определить лавку («${String(r.shop ?? '')}»), сотрудник «${employeeName}»`,
        row: rowNo,
      });
      continue;
    }

    const role = r.role == null ? null : String(r.role).trim();
    const mapped = mapRole(role, config);
    if (!mapped && !isIgnoredRole(role, config)) {
      warnings.push({
        kind: 'unknown_role',
        message: `Строка ${rowNo}: должность «${role ?? '—'}» не найдена в roleMap, сотрудник «${employeeName}» (лавка ${shop.code})`,
        row: rowNo,
      });
    }

    if (markShop && homeShop && markShop.code !== homeShop.code) {
      warnings.push({
        kind: 'shop_mismatch',
        message: `Строка ${rowNo}: «${employeeName}» числится в ${homeShop.name}, отметился в ${markShop.name}`,
        row: rowNo,
      });
    }

    const arrival = resolveArrival(r.arrival, r.departure, config);

    const stampDate = parseStamp(r.arrival)?.date ?? parseStamp(r.departure)?.date ?? fallbackDate ?? null;
    if (!stampDate) {
      warnings.push({
        kind: 'no_date',
        message: `Строка ${rowNo}: нет ни одной отметки со временем, дату определить нечем — строка пропущена («${employeeName}»)`,
        row: rowNo,
      });
      continue;
    }
    dates.add(stampDate);

    const status = mapped
      ? statusForTime(arrival.minutes, mapped.criterion, config, shop.code)
      : 'no_data';

    rows.push({
      date: stampDate,
      shopCode: shop.code,
      shopName: shop.name,
      employeeName,
      role: role ?? '',
      criterion: mapped?.criterion ?? null,
      trainee: mapped?.trainee ?? false,
      homeShopCode: homeShop?.code ?? null,
      arrivalMinutes: arrival.minutes,
      arrivalSource: arrival.source,
      rawArrival: r.arrival == null ? null : String(r.arrival),
      rawDeparture: r.departure == null ? null : String(r.departure),
      status,
      note: arrival.note,
    });
  }

  return { rows, dates: [...dates].sort(), warnings, layout };
}

/**
 * Формат определяется по шапке. В плоской выгрузке «Подразделение» и «Приход»
 * стоят в одной строке; в парной «Приход» уезжает во вторую строку шапки,
 * а в первой остаётся «Сотрудник».
 */
function detectLayout(grid: readonly unknown[][]): AttendanceLayout {
  const flat = columnIndex(grid[0], COL.shop) >= 0 && columnIndex(grid[0], COL.arrival) >= 0;
  if (flat) return 'flat';

  const paired =
    columnIndex(grid[0], COL.employee) >= 0 &&
    columnIndex(grid[1], COL.shop) >= 0 &&
    columnIndex(grid[1], COL.arrival) >= 0;
  if (paired) return 'paired';

  throw new Error(
    'Не похоже на выгрузку отметок: в шапке нет ни пары «Подразделение» + «Приход» ' +
      '(обычная выгрузка), ни строки «Сотрудник» со следующей строкой «Подразделение» ' +
      '(выгрузка 1С с группировкой)',
  );
}

/** Точное совпадение заголовка: «Подразделение» не должно ловить «Подразделение сотрудника». */
function columnIndex(header: readonly unknown[] | undefined, title: string): number {
  if (!header) return -1;
  return header.findIndex((c) => String(c ?? '').trim().toLowerCase() === title.toLowerCase());
}

function readFlat(grid: readonly unknown[][]): { rows: SourceRow[]; warnings: ParseWarning[] } {
  const header = grid[0];
  const at = {
    shop: columnIndex(header, COL.shop),
    employee: columnIndex(header, COL.employee),
    role: columnIndex(header, COL.role),
    homeShop: columnIndex(header, COL.homeShop),
    arrival: columnIndex(header, COL.arrival),
    departure: columnIndex(header, COL.departure),
  };

  const rows: SourceRow[] = [];
  for (let i = 1; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (isBlank(row)) continue;

    rows.push({
      rowNo: i + 1, // +1 за 1-based нумерацию Excel
      shop: cell(row, at.shop),
      employee: cell(row, at.employee),
      role: cell(row, at.role),
      homeShop: cell(row, at.homeShop),
      arrival: cell(row, at.arrival),
      departure: cell(row, at.departure),
    });
  }

  return { rows, warnings: [] };
}

/**
 * Парный формат: строка сотрудника задаёт «кто и кем работает», следующие за
 * ней строки отметок — «где и во сколько». Одна и та же пара колонок значит в
 * этих строках разное, поэтому разбирать их одним проходом по ключам нельзя.
 */
function readPaired(grid: readonly unknown[][]): { rows: SourceRow[]; warnings: ParseWarning[] } {
  const person = {
    employee: columnIndex(grid[0], COL.employee),
    role: columnIndex(grid[0], COL.role),
    homeShop: columnIndex(grid[0], COL.homeShop),
  };
  const stamp = {
    shop: columnIndex(grid[1], COL.shop),
    arrival: columnIndex(grid[1], COL.arrival),
    departure: columnIndex(grid[1], COL.departure),
  };

  const rows: SourceRow[] = [];
  const warnings: ParseWarning[] = [];

  let current: { employee: unknown; role: unknown; homeShop: unknown; rowNo: number } | null = null;
  let stampsForCurrent = 0;

  const closeCurrent = () => {
    if (current && stampsForCurrent === 0) {
      warnings.push({
        kind: 'no_stamps',
        message: `Строка ${current.rowNo}: у «${String(current.employee ?? '').trim()}» нет ни одной отметки — строка пропущена`,
        row: current.rowNo,
      });
    }
  };

  for (let i = 2; i < grid.length; i++) {
    const row = grid[i] ?? [];
    if (isBlank(row)) continue;

    // Отметка узнаётся по коду лавки в первой колонке: ФИО кодом лавки не бывает.
    if (parseShop(cell(row, stamp.shop))) {
      if (!current) {
        warnings.push({
          kind: 'no_stamps',
          message: `Строка ${i + 1}: отметка «${String(cell(row, stamp.shop) ?? '')}» идёт без строки сотрудника — пропущена`,
          row: i + 1,
        });
        continue;
      }

      stampsForCurrent++;
      rows.push({
        rowNo: i + 1,
        shop: cell(row, stamp.shop),
        employee: current.employee,
        role: current.role,
        homeShop: current.homeShop,
        arrival: cell(row, stamp.arrival),
        departure: cell(row, stamp.departure),
      });
      continue;
    }

    const label = String(cell(row, person.employee) ?? '').trim();
    if (!label || SERVICE_LABELS.has(label.toLowerCase())) continue;

    closeCurrent();
    current = {
      employee: label,
      role: cell(row, person.role),
      homeShop: cell(row, person.homeShop),
      rowNo: i + 1,
    };
    stampsForCurrent = 0;
  }
  closeCurrent();

  return { rows, warnings };
}

function cell(row: readonly unknown[], index: number): unknown {
  return index >= 0 ? (row[index] ?? null) : null;
}

function isBlank(row: readonly unknown[]): boolean {
  return row.every((c) => c == null || String(c).trim() === '');
}
