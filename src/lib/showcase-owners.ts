import { compareShopNumber, normalizeCode, type ShopRef } from './shops';

/**
 * Кто какие лавки заполняет на вкладке «Витрины» и у кого остались пустые
 * замеры.
 *
 * Раньше это выясняли руками: картинка «ФИО → лавки» и SQL по базе витрин.
 * Теперь список хранится в базе ручных данных (см. showcase-owners-store.ts),
 * а пропуски считаются здесь — чистой функцией, без базы: так её легко
 * проверить тестом, и одно правило работает при любом хранилище.
 *
 * Пустой замер — это отсутствие значения, а не 0%: ноль кто-то вписал, значит
 * заполнил. Так же устроено и само хранилище витрин (см. manual-db.ts).
 */

export interface ShowcaseOwner {
  /** «Иванова Ирина» или «Оператор СБ 1» — как его называют в команде. */
  name: string;
  /** Коды лавок в каноничном виде: «М14», не «M014». */
  shops: string[];
}

/** Какой замер проверяем: утренний или в 16:00. */
export type OwnerSlot = 'morning' | 'afternoon';

export const SLOT_TITLE: Record<OwnerSlot, string> = {
  morning: 'утро',
  afternoon: '16:00',
};

/**
 * С какого часа замер за сегодня считается просроченным. До него сегодняшний
 * день в отчёт не идёт: в 11:00 нельзя не заполнить витрину на 16:00.
 */
export const SLOT_DUE_MINUTES: Record<OwnerSlot, number> = {
  morning: 8 * 60,
  afternoon: 16 * 60,
};

const SHOP_CODE = /^[А-ЯA-Z]{1,3}\d{1,4}$/;
const MAX_OWNERS = 100;
const MAX_NAME = 80;
const MAX_SHOPS = 200;

type Parsed = { ok: true; value: ShowcaseOwner[] } | { ok: false; error: string };

/**
 * Ввод недоверенный: список приходит из браузера, а ложится в базу.
 *
 * Лавки принимаются и массивом, и строкой — «М14, М16 м17; M018»: человек
 * копирует их из таблицы как есть. Латинская M и ведущий ноль приводятся к
 * виду базы (см. normalizeCode) — иначе «M01» никогда не совпал бы с «М1».
 *
 * Одна лавка — один ответственный. Две фамилии на лавке означали бы, что за
 * пустой замер отвечают оба, то есть никто.
 */
export function parseOwners(raw: unknown): Parsed {
  if (!Array.isArray(raw)) return { ok: false, error: 'Нужен список ответственных' };
  if (raw.length > MAX_OWNERS) return { ok: false, error: 'Слишком много ответственных' };

  const value: ShowcaseOwner[] = [];
  const names = new Map<string, string>();
  const owners = new Map<string, string>();

  for (const item of raw) {
    const o = item as { name?: unknown; shops?: unknown };
    const name = String(o?.name ?? '').replace(/\s+/g, ' ').trim();
    const pieces = Array.isArray(o?.shops) ? o.shops.map(String) : splitShops(String(o?.shops ?? ''));

    // Совсем пустая строка — недописанная в редакторе, её просто нет.
    if (name === '' && pieces.length === 0) continue;
    if (name === '') return { ok: false, error: `Лавки ${pieces.join(', ')}: не указано, чьи они` };
    if (name.length > MAX_NAME) return { ok: false, error: `«${name.slice(0, 20)}…»: слишком длинное имя` };

    const key = name.toLowerCase();
    if (names.has(key)) return { ok: false, error: `«${name}» записан дважды` };
    names.set(key, name);

    if (pieces.length > MAX_SHOPS) return { ok: false, error: `${name}: слишком много лавок` };
    const shops: string[] = [];
    for (const piece of pieces) {
      const code = normalizeCode(piece);
      if (!SHOP_CODE.test(code)) {
        return { ok: false, error: `${name}: не понял код лавки «${piece}» — нужно М14` };
      }
      if (shops.includes(code)) continue;
      const other = owners.get(code);
      if (other) return { ok: false, error: `${code} уже у «${other}», а не только у «${name}»` };
      owners.set(code, name);
      shops.push(code);
    }

    value.push({ name, shops });
  }

  return { ok: true, value };
}

/** «М14, М16 м17;M18» → ['М14', 'М16', 'м17', 'M18']. */
export function splitShops(text: string): string[] {
  return text
    .split(/[\s,;]+/)
    .map((s) => s.trim())
    .filter(Boolean);
}

export interface OwnerMissingDay {
  date: string;
  /** Лавки этого человека с пустым замером в этот день. */
  shops: string[];
}

export interface OwnerGaps {
  name: string;
  shops: string[];
  /**
   * Лавки из списка, которых нет в справочнике радара. Их не заполнить в
   * редакторе — в дневном списке их нет, — поэтому и в пропуски они не идут.
   */
  unknown: string[];
  /** Сколько замеров должно было быть: лавка × день, пока лавка работала. */
  expected: number;
  filled: number;
  missing: OwnerMissingDay[];
  missingCount: number;
}

export interface GapsReport {
  owners: OwnerGaps[];
  /** Лавки радара, работавшие в периоде, за которые никто не отвечает. */
  unassigned: ShopRef[];
}

export interface GapsInput {
  owners: readonly ShowcaseOwner[];
  /** Выбранный замер: дата → код лавки → доля 0–1. */
  fills: Readonly<Record<string, Readonly<Record<string, number>>>>;
  /** Дни отчёта, уже без «сегодня, если час замера не наступил». */
  dates: readonly string[];
  /** Справочник радара. */
  shops: readonly ShopRef[];
  /** Работала ли лавка в этот день: закрытую с даты не спрашиваем. */
  isOpen: (shopCode: string, date: string) => boolean;
}

/**
 * Пропуски по каждому ответственному. Сортировка — по числу пропусков, от
 * худшего: страницу открывают ровно затем, чтобы увидеть, кого дёргать.
 */
export function showcaseGaps(input: GapsInput): GapsReport {
  const known = new Set(input.shops.map((s) => s.code));
  const assigned = new Set<string>();

  const owners = input.owners.map((owner): OwnerGaps => {
    const shops = [...owner.shops];
    for (const code of shops) assigned.add(code);
    const live = shops.filter((code) => known.has(code));

    let expected = 0;
    let filled = 0;
    const missing: OwnerMissingDay[] = [];
    for (const date of input.dates) {
      const empty: string[] = [];
      for (const code of live) {
        if (!input.isOpen(code, date)) continue;
        expected++;
        if (input.fills[date]?.[code] == null) empty.push(code);
        else filled++;
      }
      if (empty.length > 0) missing.push({ date, shops: sortCodes(empty) });
    }

    return {
      name: owner.name,
      shops,
      unknown: shops.filter((code) => !known.has(code)),
      expected,
      filled,
      missing,
      missingCount: expected - filled,
    };
  });

  owners.sort((a, b) => b.missingCount - a.missingCount || a.name.localeCompare(b.name, 'ru'));

  const unassigned = input.shops
    .filter((s) => !assigned.has(s.code) && input.dates.some((d) => input.isOpen(s.code, d)))
    .sort(compareShopNumber);

  return { owners, unassigned };
}

/**
 * Дни отчёта: от from до to, но не дальше сегодняшнего, а сегодняшний — только
 * если час замера уже прошёл.
 */
export function reportDates(
  range: readonly string[],
  today: string,
  nowMinutes: number,
  slot: OwnerSlot,
): { dates: string[]; todaySkipped: boolean } {
  const due = nowMinutes >= SLOT_DUE_MINUTES[slot];
  const dates = range.filter((d) => d < today || (d === today && due));
  return { dates, todaySkipped: range.includes(today) && !due };
}

function sortCodes(codes: readonly string[]): string[] {
  return [...codes].sort((a, b) => compareShopNumber({ code: a, name: a }, { code: b, name: b }));
}

/**
 * Список успели сохранить с другого компьютера, пока этот был открыт.
 * Список пишется целиком, и без этой проверки второй сохранивший молча
 * затёр бы правку первого.
 */
export class OwnersConflictError extends Error {
  constructor() {
    super('Список ответственных уже поменяли с другого компьютера. Обновите страницу и внесите правку заново.');
    this.name = 'OwnersConflictError';
  }
}

/** Лавки из базы: JSON-массив кодов. Битая строка — пустой список, а не падение. */
export function parseShopsJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((x): x is string => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
