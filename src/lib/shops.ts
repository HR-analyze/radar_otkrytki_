/**
 * Ключ лавки — код «М12», а не название.
 *
 * Названия расходятся между источниками: в выгрузке за 25.08 есть
 * «М32 Кржижановского» и «М63 Стремянная», а в Витрины.xlsx те же лавки
 * называются «М32 Профсоюзная» и «М63 Серпуховская» (переименование).
 * Плюс расхождения в пробелах: «М17 Б.Сухаревский» / «М17 Б. Сухаревский»,
 * «М22 Проспект мира» / «М22 Проспект Мира », хвостовые пробелы.
 * Код — единственное, что стабильно.
 */

const CODE_RE = /^\s*([А-ЯA-Zа-яa-z]{1,3}\s*\d{1,4})\b/;

/** Строки-итоги и служебные значения, которые не являются лавками. */
const NOT_A_SHOP = new Set(['итого', 'всего', 'total', '']);

export interface ShopRef {
  code: string;
  name: string;
}

/** «М12 Даниловская мануфактура » → { code: 'М12', name: 'М12 Даниловская мануфактура' } */
export function parseShop(value: unknown): ShopRef | null {
  const raw = String(value ?? '').replace(/\s+/g, ' ').trim();
  if (NOT_A_SHOP.has(raw.toLowerCase())) return null;

  const m = CODE_RE.exec(raw);
  if (!m) return null;

  return { code: normalizeCode(m[1]), name: raw };
}

/**
 * «м 12» → «М12». Латинская M из раскладки приводится к кириллической,
 * ведущий ноль убирается: в справочнике лавок пишут «М09», в выгрузках — «М9».
 */
export function normalizeCode(code: string): string {
  return code
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/^M/, 'М')
    .replace(/^([А-ЯA-Z]+)0+(\d)/, '$1$2');
}

/**
 * Из нескольких написаний названия выбираем каноничное: самое длинное
 * («М17 Б. Сухаревский» информативнее, чем «М17 Б.Сухаревский»), при равной
 * длине — первое встреченное. Легаси-лист имеет приоритет как справочник.
 */
export function pickCanonicalName(candidates: readonly string[]): string {
  return candidates.reduce((best, cur) =>
    cur.length > best.length ? cur : best,
  );
}

/**
 * Поиск лавки по коду или названию: «М17» найдёт М17, «Сухаревский» — её же,
 * «М1» — М1 и М10–М19 (но см. findShops: точный код важнее).
 */
export function matchesShop(shop: ShopRef, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  if (shop.code.toLowerCase() === q) return true;
  return `${shop.code} ${shop.name}`.toLowerCase().includes(q);
}

/** Совпал ли код лавки с запросом точно: «м1» → М1, но не М10. */
export function isExactCode(shop: ShopRef, query: string): boolean {
  return shop.code.toLowerCase() === query.trim().toLowerCase();
}

/**
 * Лавки под запрос с правилом радара: **точное совпадение кода важнее
 * подстроки**. Набрав «М1», человек хочет посмотреть М1, а не М1 вместе
 * с М10–М19.
 *
 * Функция чистая, без БД: то же правило нужно на клиенте — переключателю
 * лавки в карточке (см. ShopSwitcher). Иначе правил стало бы два, и они
 * разъехались бы при первой же правке.
 */
export function findShops<T extends ShopRef>(shops: readonly T[], query: string): T[] {
  const q = query.trim();
  if (!q) return [...shops];

  const exact = shops.filter((s) => isExactCode(s, q));
  return exact.length > 0 ? exact : shops.filter((s) => matchesShop(s, q));
}

/**
 * Порядок лавок «как в справочнике»: М1, М2, М3… , а не по алфавиту, где
 * М10 встаёт между М1 и М2. Живёт здесь, а не в queries: тот же порядок
 * нужен таблицам на клиенте, а два правила однажды разъехались бы.
 */
export function compareShopNumber(a: ShopRef, b: ShopRef): number {
  return shopNumber(a.code) - shopNumber(b.code) || a.code.localeCompare(b.code);
}

/** Число из кода лавки: «М12» → 12. Без цифр — в конец списка. */
export function shopNumber(code: string): number {
  const n = Number(code.replace(/\D/g, ''));
  return Number.isFinite(n) && code.replace(/\D/g, '') !== '' ? n : Number.MAX_SAFE_INTEGER;
}
