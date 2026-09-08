/** Разбор времени и дат из выгрузок 1С. */

/** "06:17" | "6:17" → минуты от полуночи. */
export function parseClock(hhmm: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(hhmm.trim());
  if (!m) throw new Error(`Некорректное время в конфиге: ${hhmm}`);
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Минуты от полуночи → "06:17". Пустое значение → "—". */
export function formatClock(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}`;
}

/**
 * Длительность в минутах → "45 мин" | "1 ч 51 мин". Пустое значение → "—".
 *
 * Отдельно от formatClock: "01:51" рядом с временем выезда читалось бы как
 * время суток, а это интервал.
 */
export function formatDuration(minutes: number | null | undefined): string {
  if (minutes == null) return '—';
  const total = Math.round(minutes);
  const h = Math.floor(total / 60);
  const m = total % 60;
  if (h === 0) return `${m} мин`;
  return m === 0 ? `${h} ч` : `${h} ч ${m} мин`;
}

export interface ParsedStamp {
  /** ISO-дата отметки, YYYY-MM-DD. */
  date: string;
  /** Минуты от полуночи. */
  minutes: number;
}

/**
 * Отметка из выгрузки: "25.08.2026 6:25:29".
 * Excel иногда отдаёт то же значение уже как Date — поддерживаем оба варианта.
 */
export function parseStamp(value: unknown): ParsedStamp | null {
  if (value == null || value === '') return null;

  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return {
      date: toIsoDate(value.getFullYear(), value.getMonth() + 1, value.getDate()),
      minutes: value.getHours() * 60 + value.getMinutes(),
    };
  }

  const s = String(value).trim();
  const m = /^(\d{1,2})[.\-/](\d{1,2})[.\-/](\d{4})\s+(\d{1,2}):(\d{2})(?::(\d{2}))?$/.exec(s);
  if (!m) return null;

  return {
    date: toIsoDate(Number(m[3]), Number(m[2]), Number(m[1])),
    minutes: Number(m[4]) * 60 + Number(m[5]),
  };
}

function toIsoDate(year: number, month: number, day: number): string {
  return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
}

/** Date → YYYY-MM-DD в локальной зоне (даты в выгрузках без времени). */
export function isoDate(d: Date): string {
  return toIsoDate(d.getFullYear(), d.getMonth() + 1, d.getDate());
}

/**
 * Дата из ячейки Excel → YYYY-MM-DD, одна и та же в любой зоне.
 *
 * SheetJS собирает дату ячейки в зоне машины и промахивается на десятки
 * секунд: в UTC выходит ровно полночь, а восточнее — 23:59:24 предыдущего дня,
 * и 19 августа в легаси-книге становится 18-м. Поэтому дата округляется до
 * ближайших суток, а не берётся как есть.
 */
export function excelDay(d: Date): string {
  return isoDate(new Date(d.getTime() + 12 * 60 * 60 * 1000));
}

/**
 * Часовой пояс радара.
 *
 * Всё, что видит человек, — московское: лавки, склад и те, кто смотрит
 * дашборд, живут по Москве, а сервер на хостинге живёт в UTC. Без явной зоны
 * «сегодня» на сервере наступало на три часа позже, чем в лавке, а отчёт,
 * собранный в 02:30 по Москве, подписывался вчерашним днём.
 *
 * Времени из выгрузок это не касается: там уже местные часы, и переводить их
 * не нужно — см. formatClock.
 */
export const RADAR_TZ = 'Europe/Moscow';

const DAY_IN_TZ = new Intl.DateTimeFormat('en-GB', {
  timeZone: RADAR_TZ,
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
});

/**
 * Сегодняшний день по Москве, YYYY-MM-DD.
 *
 * Именно это, а не `isoDate(new Date())`, — «сегодня» для всего радара: на
 * сервере в UTC с полуночи до 03:00 по Москве это разные дни.
 */
export function todayIso(now: Date = new Date()): string {
  const parts = Object.fromEntries(
    DAY_IN_TZ.formatToParts(now).map((p) => [p.type, p.value]),
  ) as Record<string, string>;
  return `${parts.year}-${parts.month}-${parts.day}`;
}

/**
 * Момент времени (ISO с зоной) → «08.09.2026, 06:38» по Москве.
 *
 * Метки загрузок и запусков хранятся в UTC; показывать их в зоне сервера
 * (или браузера) значило бы, что утренняя загрузка в 06:38 выглядит как
 * 03:38 — и в логе не сходится с тем, когда человек её делал.
 */
export function formatMoment(
  iso: string,
  opts: Intl.DateTimeFormatOptions = { dateStyle: 'short', timeStyle: 'short' },
): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString('ru-RU', { ...opts, timeZone: RADAR_TZ });
}

/**
 * Календарный день (YYYY-MM-DD) → человеческая подпись: «пн, 8 сентября».
 *
 * День берётся серединой суток по UTC, поэтому подпись одна и та же в любой
 * зоне: `new Date('2026-09-08T00:00:00')` у клиента восточнее Москвы дал бы
 * седьмое число.
 */
export function formatDay(
  iso: string,
  opts: Intl.DateTimeFormatOptions = { day: 'numeric', month: 'long' },
): string {
  const d = new Date(`${iso}T12:00:00Z`);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString('ru-RU', { ...opts, timeZone: RADAR_TZ });
}

/** "2026-08-25" → "25.08" для заголовков колонок радара. */
export function shortDate(iso: string): string {
  const [, mm, dd] = iso.split('-');
  return `${dd}.${mm}`;
}

/** Все даты от from до to включительно. */
export function dateRange(from: string, to: string): string[] {
  const out: string[] = [];
  const cur = new Date(`${from}T00:00:00`);
  const end = new Date(`${to}T00:00:00`);
  while (cur <= end) {
    out.push(isoDate(cur));
    cur.setDate(cur.getDate() + 1);
  }
  return out;
}
