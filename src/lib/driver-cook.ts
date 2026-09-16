import type { AttendanceRow } from './types';

/**
 * Сверка отметок водителя и первого повара в лавке.
 *
 * Зачем. Водитель приезжает в лавку раньше смены — привозит товар, и его
 * отметка face id по смыслу не может совпадать с отметкой повара: это два
 * разных человека, каждый подходит к терминалу сам. Когда отметки совпадают
 * секунда в секунду или расходятся на минуту-две, а до них в лавке не
 * отмечался никто, это уже не совпадение, а признак того, что отмечались за
 * двоих — одним лицом, одним телефоном, одним «помоги, я опаздываю».
 *
 * Здесь не выносится вердикт «фрод»: модуль только сводит пары «водитель ↔
 * первый повар» по лавко-дням и раскладывает их по близости отметок. Решение
 * принимает человек, глядя на повторяемость по лавке и по водителю.
 *
 * Что считается отметкой. Только `arrivalSource === 'mark'` — живой face id с
 * секундами. Время из журнала отгрузок (`delivery`) и досчёт «уход − 30 минут»
 * (`derived_minus30`) сюда не годятся: они восстановлены, а не отмечены, и
 * разница в минутах у них ничего не значит.
 */

/** Секунды от полуночи + исходная строка — чтобы показать время как в выгрузке. */
interface Mark {
  row: AttendanceRow;
  seconds: number;
}

export type DriverCookBucket =
  /** Водитель отметился раньше первого повара больше чем на порог «одновременно». */
  | 'driver_before'
  /** Отметки в пределах порога «одновременно» — фактически один момент. */
  | 'simultaneous'
  /** Повар раньше водителя, но разрыв не больше `closeMinutes`. */
  | 'cook_before_close'
  /** Повар раньше водителя с нормальным разрывом — обычный день. */
  | 'cook_before';

export interface DriverCookOptions {
  /** Разрыв, внутри которого отметки считаем одновременными. По умолчанию 60 секунд. */
  simultaneousSeconds?: number;
  /** Что считать «отметились рядом». По умолчанию 5 минут. */
  closeMinutes?: number;
}

export const DEFAULT_OPTIONS: Required<DriverCookOptions> = {
  simultaneousSeconds: 60,
  closeMinutes: 5,
};

export interface DriverCookPair {
  date: string;
  shopCode: string;
  shopName: string;
  driverName: string;
  /** «06:23:31» — время отметки водителя. */
  driverTime: string;
  cookName: string;
  cookRole: string;
  cookTime: string;
  /**
   * Разрыв в минутах, положительный — водитель раньше повара.
   * Округлён до десятых: секунды в отчёте не читаются, а знак и величина важны.
   */
  deltaMinutes: number;
  bucket: DriverCookBucket;
  /**
   * До пары «водитель + повар» в лавке в этот день не отметился никто.
   * Именно этот флаг отличает подозрительную пару от лавки, где смена уже
   * работала и к терминалу подходили по очереди.
   */
  aloneAtOpen: boolean;
  /** Первая отметка в лавке — водителя. */
  driverFirst: boolean;
  /** Кто отметился раньше пары, если такой был: «Кассир 06:01:12». */
  precedingMark: string | null;
}

export interface DriverCookSummary {
  /** Лавко-дни, где нашлись обе отметки — знаменатель всех долей. */
  pairs: number;
  /** Лавко-дни, где face id был только у одной стороны или не было вовсе. */
  skipped: number;
  byBucket: Record<DriverCookBucket, number>;
  /** Из них — те, где до пары в лавке никого не было. */
  aloneByBucket: Record<DriverCookBucket, number>;
}

export interface DriverCookReport {
  from: string;
  to: string;
  options: Required<DriverCookOptions>;
  pairs: DriverCookPair[];
  summary: DriverCookSummary;
  byShop: DriverCookGroup[];
  byDriver: DriverCookGroup[];
  byDate: DriverCookGroup[];
}

export interface DriverCookGroup {
  key: string;
  title: string;
  pairs: number;
  driverBefore: number;
  simultaneous: number;
  cookBeforeClose: number;
  /** Сколько из подозрительных пар пришлись на пустую лавку. */
  alone: number;
}

/** Пары, ради которых всё и затевалось: одновременно или почти, и лавка пустая. */
export function isSuspicious(p: DriverCookPair): boolean {
  if (p.bucket === 'cook_before') return false;
  // Водитель заметно раньше повара — это нормальная работа (привёз товар до
  // смены), подозрительно только если он же и открыл лавку в одиночку.
  if (p.bucket === 'driver_before') return false;
  return p.aloneAtOpen;
}

export function analyzeDriverCook(
  rows: readonly AttendanceRow[],
  from: string,
  to: string,
  options: DriverCookOptions = {},
): DriverCookReport {
  // Не spread: вызывающий передаёт сюда разобранные аргументы командной строки,
  // где незаданный ключ приходит как undefined и затёр бы значение по умолчанию.
  const opts: Required<DriverCookOptions> = {
    simultaneousSeconds: options.simultaneousSeconds ?? DEFAULT_OPTIONS.simultaneousSeconds,
    closeMinutes: options.closeMinutes ?? DEFAULT_OPTIONS.closeMinutes,
  };
  const byShopDay = new Map<string, Mark[]>();

  for (const row of rows) {
    if (row.date < from || row.date > to) continue;
    if (row.arrivalSource !== 'mark') continue;
    const seconds = markSeconds(row);
    if (seconds == null) continue;
    const key = `${row.date}|${row.shopCode}`;
    const list = byShopDay.get(key);
    if (list) list.push({ row, seconds });
    else byShopDay.set(key, [{ row, seconds }]);
  }

  const pairs: DriverCookPair[] = [];
  let skipped = 0;

  for (const key of [...byShopDay.keys()].sort()) {
    const marks = byShopDay.get(key)!;
    const driver = earliest(marks.filter((m) => m.row.criterion === 'driver'));
    const cook = earliest(marks.filter((m) => m.row.criterion === 'cook'));
    if (!driver || !cook) {
      skipped += 1;
      continue;
    }

    const deltaSeconds = cook.seconds - driver.seconds;
    // «Раньше пары» считаем по всем, кто отмечался в лавке, включая уборщика и
    // директора: вопрос в том, был ли в лавке кто-то ещё, а не в том, входит ли
    // его должность в критерии радара.
    const pairStart = Math.min(driver.seconds, cook.seconds);
    const before = marks
      .filter((m) => m !== driver && m !== cook && m.seconds < pairStart)
      .sort((a, b) => a.seconds - b.seconds);

    pairs.push({
      date: driver.row.date,
      shopCode: driver.row.shopCode,
      shopName: driver.row.shopName,
      driverName: driver.row.employeeName,
      driverTime: formatSeconds(driver.seconds),
      cookName: cook.row.employeeName,
      cookRole: cook.row.role,
      cookTime: formatSeconds(cook.seconds),
      deltaMinutes: Math.round((deltaSeconds / 60) * 10) / 10,
      bucket: bucketOf(deltaSeconds, opts),
      aloneAtOpen: before.length === 0,
      driverFirst: driver.seconds <= cook.seconds && before.length === 0,
      precedingMark: before.length
        ? `${before[0].row.role} ${formatSeconds(before[0].seconds)}`
        : null,
    });
  }

  return {
    from,
    to,
    options: opts,
    pairs,
    summary: summarize(pairs, skipped),
    byShop: group(pairs, (p) => p.shopCode, (p) => `${p.shopCode} ${stripCode(p.shopName)}`),
    byDriver: group(pairs, (p) => p.driverName, (p) => p.driverName),
    byDate: group(pairs, (p) => p.date, (p) => p.date),
  };
}

function bucketOf(deltaSeconds: number, opts: Required<DriverCookOptions>): DriverCookBucket {
  if (Math.abs(deltaSeconds) <= opts.simultaneousSeconds) return 'simultaneous';
  if (deltaSeconds > 0) return 'driver_before';
  return -deltaSeconds <= opts.closeMinutes * 60 ? 'cook_before_close' : 'cook_before';
}

function summarize(pairs: readonly DriverCookPair[], skipped: number): DriverCookSummary {
  const empty = (): Record<DriverCookBucket, number> => ({
    driver_before: 0,
    simultaneous: 0,
    cook_before_close: 0,
    cook_before: 0,
  });
  const byBucket = empty();
  const aloneByBucket = empty();

  for (const p of pairs) {
    byBucket[p.bucket] += 1;
    if (p.aloneAtOpen) aloneByBucket[p.bucket] += 1;
  }

  return { pairs: pairs.length, skipped, byBucket, aloneByBucket };
}

function group(
  pairs: readonly DriverCookPair[],
  keyOf: (p: DriverCookPair) => string,
  titleOf: (p: DriverCookPair) => string,
): DriverCookGroup[] {
  const map = new Map<string, DriverCookGroup>();

  for (const p of pairs) {
    const key = keyOf(p);
    let g = map.get(key);
    if (!g) {
      g = {
        key,
        title: titleOf(p),
        pairs: 0,
        driverBefore: 0,
        simultaneous: 0,
        cookBeforeClose: 0,
        alone: 0,
      };
      map.set(key, g);
    }
    g.pairs += 1;
    if (p.bucket === 'driver_before') g.driverBefore += 1;
    if (p.bucket === 'simultaneous') g.simultaneous += 1;
    if (p.bucket === 'cook_before_close') g.cookBeforeClose += 1;
    if (isSuspicious(p)) g.alone += 1;
  }

  return [...map.values()].sort(
    (a, b) => b.alone - a.alone || b.simultaneous - a.simultaneous || a.key.localeCompare(b.key),
  );
}

/**
 * Секунды от полуночи из сырой отметки «25.08.2026 6:25:29».
 *
 * Берём именно `rawArrival`, а не `arrivalMinutes`: в снимке минуты округлены,
 * и две отметки в 6:02:25 и 6:02:43 стали бы «одним временем» независимо от
 * того, что было на самом деле. Здесь важна как раз секундная разница.
 */
export function markSeconds(row: AttendanceRow): number | null {
  const raw = row.rawArrival?.trim();
  if (!raw) return null;
  const m = /(\d{1,2}):(\d{2})(?::(\d{2}))?\s*$/.exec(raw);
  if (!m) return null;
  return Number(m[1]) * 3600 + Number(m[2]) * 60 + Number(m[3] ?? 0);
}

function earliest(marks: readonly Mark[]): Mark | null {
  let best: Mark | null = null;
  for (const m of marks) if (!best || m.seconds < best.seconds) best = m;
  return best;
}

export function formatSeconds(seconds: number): string {
  const h = Math.floor(seconds / 3600);
  const m = Math.floor((seconds % 3600) / 60);
  const s = seconds % 60;
  return [h, m, s].map((n) => String(n).padStart(2, '0')).join(':');
}

/** «М24 Мясницкая» → «Мясницкая»: код и так стоит первой колонкой. */
function stripCode(name: string): string {
  return name.replace(/^М\d+\s*/, '').trim() || name;
}

export const BUCKET_TITLES: Record<DriverCookBucket, string> = {
  driver_before: 'водитель раньше повара',
  simultaneous: 'одновременно',
  cook_before_close: 'повар раньше водителя, в пределах порога',
  cook_before: 'повар раньше водителя',
};

/**
 * Пары таблицей для Excel: разделитель `;` и BOM в начале — иначе Excel
 * открывает файл одной колонкой и ломает кириллицу.
 *
 * Общая для команды в консоли и кнопки «Скачать CSV» на вкладке: колонки в
 * обоих случаях должны быть одни и те же, иначе выгрузки не сравнить между
 * собой.
 */
export function toCsv(pairs: readonly DriverCookPair[]): string {
  const head = [
    'Дата',
    'Код лавки',
    'Лавка',
    'Отметка водителя',
    'Отметка повара',
    'Разрыв, мин',
    'Категория',
    'До пары никого',
    'Кто отметился раньше',
    'Водитель',
    'Повар',
    'Должность повара',
  ];
  const rows = pairs.map((p) => [
    p.date,
    p.shopCode,
    p.shopName,
    p.driverTime,
    p.cookTime,
    String(p.deltaMinutes).replace('.', ','),
    BUCKET_TITLES[p.bucket],
    p.aloneAtOpen ? 'да' : 'нет',
    p.precedingMark ?? '',
    p.driverName,
    p.cookName,
    p.cookRole,
  ]);

  return '﻿' + [head, ...rows].map((r) => r.map(csvCell).join(';')).join('\r\n') + '\r\n';
}

function csvCell(v: string): string {
  return /[";\r\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v;
}

/** «Разрыв» человеку: «+2,4 мин» — водитель раньше, «−0,3 мин» — повар раньше. */
export function formatDelta(minutes: number): string {
  const sign = minutes > 0 ? '+' : minutes < 0 ? '−' : '';
  return `${sign}${String(Math.abs(minutes)).replace('.', ',')} мин`;
}
