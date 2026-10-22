import guids from '../../config/1c-guids.json';
import { timingSafeEqual } from './auth';
import { todayIso } from './time';
import type { Status } from './types';

/**
 * API показателей для 1С: радар открытий идёт в KPI сотрудников.
 *
 * 1С забирает по лавкам и дням цвет итога и узнаёт лавку по GUID своего
 * подразделения, а не по нашему коду «М12»: в 1С ключ — GUID, и сводить по
 * названиям значило бы сломаться на первом переименовании.
 *
 * Токен у API свой (`RADAR_1C_TOKEN`), не пароль управления и не CRON_SECRET:
 * его отдают в другой отдел, и он не должен открывать ничего, кроме выдачи
 * показателей. У радара бара — другой токен, чтобы один можно было сменить, не
 * трогая второй.
 */

export const TOKEN_ENV = 'RADAR_1C_TOKEN';

/** Шкала, о которой договорились с отделом 1С (22.10.2026): 🔴 0 · 🟡 1 · 🟢 2. */
export const ONEC_VALUE: Partial<Record<Status, 0 | 1 | 2>> = { red: 0, yellow: 1, green: 2 };

/**
 * Цвет → число для 1С. «Нет данных» и «другой график» — не оценка, и
 * передавать их нулём значило бы ставить сотрудникам красный за пропуск,
 * которого не было. Такой день в выдачу не попадает вовсе.
 */
export function onecValue(status: Status): 0 | 1 | 2 | null {
  return ONEC_VALUE[status] ?? null;
}

const UNITS: Record<string, { name: string; guid: string }> = guids.units;

/** GUID подразделения 1С по коду лавки «М12»; null — лавки в справочнике 1С нет. */
export function guidOf(shopCode: string): string | null {
  return UNITS[shopCode]?.guid ?? null;
}

/* --------------------------------- токен --------------------------------- */

export type TokenCheck = { ok: true } | { ok: false; status: 401 | 503; error: string };

/**
 * Authorization: Bearer <RADAR_1C_TOKEN>.
 *
 * Токен не задан — API закрыт, а не открыт: в отличие от пароля на вкладки,
 * здесь некому увидеть полосу «вкладки открыты», и забытая переменная тихо
 * раздавала бы показатели всем.
 */
export function checkOnecToken(req: Request): TokenCheck {
  const expected = process.env[TOKEN_ENV];
  if (!expected) return { ok: false, status: 503, error: `${TOKEN_ENV} не задан на сервере` };

  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7).trim() : '';
  if (!token || !timingSafeEqual(token, expected)) {
    return { ok: false, status: 401, error: 'Неверный или отсутствующий токен' };
  }
  return { ok: true };
}

/* --------------------------------- период -------------------------------- */

/** Больше квартала за раз не отдаём: 1С забирает показатели по дням, а не всю историю. */
export const MAX_DAYS = 93;

export type Period = { ok: true; from: string; to: string } | { ok: false; error: string };

/**
 * Период запроса: `date=2026-10-21`, либо `from=…&to=…`, либо ничего — тогда
 * вчерашний день по Москве. Сегодняшний день по умолчанию не берём: он ещё
 * идёт, и витрину на 16:00 к утру никто не заполнил.
 */
export function onecPeriod(params: URLSearchParams, now: Date = new Date()): Period {
  const date = params.get('date');
  const from = date ?? params.get('from');
  const to = date ?? params.get('to');

  if (!from && !to) {
    const yesterday = addDays(todayIso(now), -1);
    return { ok: true, from: yesterday, to: yesterday };
  }
  if (!from || !to) return { ok: false, error: 'Нужны оба параметра: from и to' };
  if (!isIsoDate(from) || !isIsoDate(to)) {
    return { ok: false, error: 'Дата — в формате ГГГГ-ММ-ДД, например 2026-10-21' };
  }
  if (from > to) return { ok: false, error: 'from позже, чем to' };
  if (daysBetween(from, to) + 1 > MAX_DAYS) {
    return { ok: false, error: `Не больше ${MAX_DAYS} дней за запрос` };
  }
  return { ok: true, from, to };
}

function isIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false;
  const d = new Date(`${value}T00:00:00Z`);
  // 2026-02-31 Date молча превращает в 3 марта — сверяем обратно.
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === value;
}

function addDays(iso: string, days: number): string {
  const d = new Date(`${iso}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

function daysBetween(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);
}
