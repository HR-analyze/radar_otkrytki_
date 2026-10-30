import { STAFF_ROLES, normalizePlace, type StaffNorm, type StaffPost, type StaffRole } from './staffing';

/**
 * Единые названия функционалов (мест в расстановке) — вкладка «Функционалы».
 *
 * ТД пишут одно и то же по-разному: «разогрев», «разог», «разлгрев»,
 * «повар разогре». Привести это в книгах руками нельзя — их семь, и завтра
 * впишут восьмое написание. Поэтому словарь: «как написано → как называем»,
 * одна строка на написание. Поправили строку — название меняется во всех
 * лавках, окнах и выгрузках сразу.
 *
 * Словарь накладывается последним, поверх книг, правил руководства и правок
 * лавок (см. readStaffingLive): переименовать можно и то, что пишет правило
 * («подготовка витрин»). Совпали два места в одном окне после переименования —
 * люди складываются: «1 разог» + «2 разогрев» → «3 разогрев».
 *
 * Модуль без сервера: страница вкладки собирает список написаний в браузере.
 */

/** Строка словаря: написание (как в книгах) и единое название. */
export interface PlaceAlias {
  place: string;
  name: string;
}

/**
 * Явные опечатки и обрезки из книг 28.10.2026 — словарь по умолчанию, пока
 * их не поправили на вкладке. Строка с сайта главнее: вернуть «разог» как
 * есть — вписать «разог» в единое название.
 */
export const DEFAULT_PLACE_ALIASES: readonly PlaceAlias[] = [
  { place: 'разог', name: 'разогрев' },
  { place: 'разлгрев', name: 'разогрев' },
  { place: 'повар разогре', name: 'повар разогрев' },
  { place: 'повара разогрев', name: 'повар разогрев' },
  { place: 'витр', name: 'витрина' },
  { place: 'загот', name: 'заготовки' },
  { place: 'подгтовка бара, настройка', name: 'подготовка бара, настройка' },
  { place: 'официант + дост', name: 'официант + доставка' },
  { place: 'официант( доставка)', name: 'официант + доставка' },
  { place: 'официант(доставка)', name: 'официант + доставка' },
  { place: 'разогрев-доставка', name: 'разогрев + доставка' },
  { place: 'доставка-разогрев', name: 'разогрев + доставка' },
  { place: 'разогрев(доставка)', name: 'разогрев + доставка' },
  { place: 'сборкщик доставки', name: 'сборщик доставки' },
];

/** Ключ написания: «Официант+дост» и «официант + дост» — одна строка словаря. */
export function placeKey(place: string): string {
  return normalizePlace(place).toLowerCase();
}

/** Словарь по ключу написания: строки с сайта поверх словаря по умолчанию. */
export function placeAliasMap(
  saved: readonly PlaceAlias[],
  defaults: readonly PlaceAlias[] = DEFAULT_PLACE_ALIASES,
): Map<string, string> {
  const map = new Map<string, string>();
  for (const a of [...defaults, ...saved]) map.set(placeKey(a.place), normalizePlace(a.name) || normalizePlace(a.place));
  return map;
}

/**
 * Единое название написания. Цепочку «а → б, б → в» проходим до конца — так
 * переименование группы одной строкой («разогрев» → «разогрев блюд») тянет за
 * собой и все её опечатки. Петля «а → б → а» останавливается на повторе.
 */
export function resolvePlace(place: string, aliases: ReadonlyMap<string, string>): string {
  let name = normalizePlace(place);
  const seen = new Set<string>();
  for (;;) {
    const key = name.toLowerCase();
    const next = aliases.get(key);
    if (next == null || seen.has(key)) return name;
    seen.add(key);
    name = next;
  }
}

/** Переименовать места окна; одинаковые после переименования — сложить. */
function renamePosts(posts: readonly StaffPost[], aliases: ReadonlyMap<string, string>): StaffPost[] {
  const out: StaffPost[] = [];
  for (const p of posts) {
    const place = resolvePlace(p.place, aliases);
    const same = out.find((q) => q.place.toLowerCase() === place.toLowerCase() && q.count != null && p.count != null);
    if (same) same.count! += p.count!;
    else out.push({ count: p.count, place });
  }
  return out;
}

/** Нормы с едиными названиями мест — во всех окнах и в местах лавки. */
export function applyPlaceAliases(norms: readonly StaffNorm[], aliases: ReadonlyMap<string, string>): StaffNorm[] {
  if (aliases.size === 0) return [...norms];
  return norms.map((n) => {
    const roles = { ...n.roles };
    for (const role of STAFF_ROLES) {
      const r = roles[role];
      if (r.posts) roles[role] = { ...r, posts: r.posts.map((w) => renamePosts(w, aliases)) };
    }
    return {
      ...n,
      roles,
      ...(n.layout && { layout: { ...n.layout, stations: renamePosts(n.layout.stations, aliases) } }),
    };
  });
}

/** Где встречается написание: окно должности или «места лавки» из шапки расстановки. */
export type PlaceSource = StaffRole | 'stations';

/** Написание со всеми его появлениями — строка таблицы на вкладке. */
export interface PlaceUsage {
  /** Ключ словаря (см. placeKey). */
  key: string;
  /** Как написано — самое частое написание с этим ключом. */
  place: string;
  /** Сколько раз встречается: окно × лавка. */
  uses: number;
  /** Коды лавок, по порядку норм. */
  shops: string[];
  /** Какие должности (и места лавки), по порядку STAFF_ROLES. */
  sources: PlaceSource[];
  /** Счёт по каждой должности — для фильтра и группировки по должностям. */
  bySource: Partial<Record<PlaceSource, { uses: number; shops: string[] }>>;
}

/**
 * Все написания мест по сети — ДО словаря: иначе «разог», уже сведённый к
 * «разогрев», пропал бы из таблицы, и вернуть его было бы негде.
 */
export function collectPlaces(norms: readonly StaffNorm[]): PlaceUsage[] {
  type Acc = {
    spellings: Map<string, number>;
    uses: number;
    shops: Set<string>;
    sources: Set<PlaceSource>;
    bySource: Map<PlaceSource, { uses: number; shops: Set<string> }>;
  };
  const acc = new Map<string, Acc>();
  const add = (place: string, shop: string, source: PlaceSource) => {
    const spelling = normalizePlace(place);
    if (!spelling) return;
    const key = spelling.toLowerCase();
    const a: Acc = acc.get(key) ?? { spellings: new Map(), uses: 0, shops: new Set(), sources: new Set(), bySource: new Map() };
    a.spellings.set(spelling, (a.spellings.get(spelling) ?? 0) + 1);
    a.uses += 1;
    a.shops.add(shop);
    a.sources.add(source);
    const b = a.bySource.get(source) ?? { uses: 0, shops: new Set<string>() };
    b.uses += 1;
    b.shops.add(shop);
    a.bySource.set(source, b);
    acc.set(key, a);
  };
  for (const n of norms) {
    for (const role of STAFF_ROLES) for (const w of n.roles[role].posts ?? []) for (const p of w) add(p.place, n.code, role);
    for (const p of n.layout?.stations ?? []) add(p.place, n.code, 'stations');
  }
  const order: PlaceSource[] = [...STAFF_ROLES, 'stations'];
  const shopOrder = new Map(norms.map((n, i) => [n.code, i]));
  const sortShops = (shops: Set<string>) => [...shops].sort((x, y) => shopOrder.get(x)! - shopOrder.get(y)!);
  return [...acc].map(([key, a]) => ({
    key,
    place: [...a.spellings].sort((x, y) => y[1] - x[1])[0][0],
    uses: a.uses,
    shops: sortShops(a.shops),
    sources: order.filter((s) => a.sources.has(s)),
    bySource: Object.fromEntries([...a.bySource].map(([s, b]) => [s, { uses: b.uses, shops: sortShops(b.shops) }])),
  }));
}

/** Название написания по словарю по умолчанию — без правок сайта. */
export function defaultPlaceName(place: string): string {
  return resolvePlace(place, placeAliasMap([]));
}

/**
 * Написание разобрано: его строку сохраняли на сайте или оно — известная
 * опечатка из словаря по умолчанию. Остальное — «новое»: так пришло из книги,
 * и никто ещё не сказал, какой это функционал. Каждая новая книга приносит
 * такие — их и надо пройти, а не все полсотни строк.
 */
export function isReviewedPlace(key: string, savedKeys: ReadonlySet<string>): boolean {
  return savedKeys.has(key) || DEFAULT_PLACE_ALIASES.some((a) => placeKey(a.place) === key);
}

/** Функционал для выпадающего списка в правке лавки. */
export interface FunctionOption {
  name: string;
  /** У каких должностей он уже стоит — их функционалы в списке идут первыми. */
  roles: StaffRole[];
}

/**
 * Справочник функционалов для правки лавки: единые названия из расстановки
 * (уже после словаря) и всё, во что переименовали на вкладке «Функционалы»,
 * включая добавленные там функционалы, которые пока нигде не стоят. Вписать
 * своё в правке лавки нельзя — только выбрать отсюда, иначе разночтения
 * поползли бы снова.
 */
export function functionCatalog(live: readonly StaffNorm[], saved: readonly PlaceAlias[]): FunctionOption[] {
  const by = new Map<string, FunctionOption>();
  const add = (name: string, role?: StaffRole) => {
    const clean = normalizePlace(name);
    if (!clean) return;
    const o = by.get(clean.toLowerCase()) ?? { name: clean, roles: [] };
    if (role && !o.roles.includes(role)) o.roles.push(role);
    by.set(clean.toLowerCase(), o);
  };
  for (const n of live) for (const role of STAFF_ROLES) for (const w of n.roles[role].posts ?? []) for (const p of w) add(p.place, role);
  const aliases = placeAliasMap(saved);
  for (const a of saved) add(resolvePlace(a.name, aliases));
  return [...by.values()]
    .map((o) => ({ ...o, roles: STAFF_ROLES.filter((r) => o.roles.includes(r)) }))
    .sort((a, b) => a.name.localeCompare(b.name, 'ru'));
}

/** Строка словаря с сайта, которой нет среди написаний. */
export interface UnusedAlias extends PlaceAlias {
  /** 'added' — функционал, добавленный на вкладке; 'gone' — написание пропало из книг. */
  kind: 'added' | 'gone';
}

/**
 * Строки словаря, которые ни на что не влияют: написание пропало из книг
 * (пересобрали — опечатку исправили) или функционал добавили, а в лавки
 * ещё не поставили. Строка, через которую идёт цепочка («разог → разогрев →
 * разогрев блюд»), — в деле, даже если самого «разогрева» в книгах нет.
 */
export function unusedAliases(saved: readonly PlaceAlias[], usages: readonly Pick<PlaceUsage, 'key'>[]): UnusedAlias[] {
  const aliases = placeAliasMap(saved);
  const reached = new Set<string>();
  for (const u of usages) {
    let key = u.key;
    while (!reached.has(key)) {
      reached.add(key);
      const next = aliases.get(key);
      if (next == null) break;
      key = next.toLowerCase();
    }
  }
  return saved
    .filter((a) => !reached.has(placeKey(a.place)))
    .map((a) => ({ ...a, kind: placeKey(a.place) === placeKey(a.name) ? 'added' : 'gone' }));
}

/** Окно для предпросмотра правки словаря: лавка и написания мест как в книгах. */
export interface PlaceWindow {
  shop: string;
  places: string[];
}

export function placeWindows(norms: readonly StaffNorm[]): PlaceWindow[] {
  return norms.flatMap((n) =>
    STAFF_ROLES.flatMap((r) =>
      (n.roles[r].posts ?? []).filter((w) => w.length > 0).map((w) => ({ shop: n.code, places: w.map((p) => p.place) })),
    ),
  );
}

/**
 * Что сделает правка словаря: сколько окон и лавок поменяются и в скольких
 * окнах места сольются в одно («1 разог · 1 разогрев» → «2 разогрев»). Одна
 * строка словаря меняет всю сеть — масштаб надо видеть до «Сохранить».
 */
export function previewAliasChange(
  windows: readonly PlaceWindow[],
  saved: readonly PlaceAlias[],
  changes: readonly PlaceAlias[],
): { windows: number; shops: number; merged: number } {
  const before = placeAliasMap(saved);
  const after = placeAliasMap([...saved, ...changes]);
  const shops = new Set<string>();
  let changed = 0;
  let merged = 0;
  for (const w of windows) {
    const a = w.places.map((p) => resolvePlace(p, before).toLowerCase());
    const b = w.places.map((p) => resolvePlace(p, after).toLowerCase());
    if (a.every((x, i) => x === b[i])) continue;
    changed++;
    shops.add(w.shop);
    if (new Set(b).size < new Set(a).size) merged++;
  }
  return { windows: changed, shops: shops.size, merged };
}

/** Строк в словаре не больше — с запасом к сотне написаний по сети. */
export const MAX_PLACE_ALIASES = 1000;

/**
 * Разбор словаря из запроса: { aliases: [{ place, name }] }. Пустое название
 * — «оставить как написано». Длина — до 80 знаков, как у поста в правке лавки.
 */
export function parsePlaceAliases(body: unknown): { ok: true; aliases: PlaceAlias[] } | { ok: false; error: string } {
  const raw = (body as { aliases?: unknown })?.aliases;
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Нет правок' };
  if (raw.length > MAX_PLACE_ALIASES) return { ok: false, error: `Строк больше ${MAX_PLACE_ALIASES}` };
  const out = new Map<string, PlaceAlias>();
  for (const a of raw) {
    const place = normalizePlace(String((a as PlaceAlias)?.place ?? ''));
    if (!place) return { ok: false, error: 'Пустое написание' };
    const name = normalizePlace(String((a as PlaceAlias)?.name ?? '')) || place;
    if (place.length > 80 || name.length > 80) return { ok: false, error: `«${place.slice(0, 30)}…»: длиннее 80 знаков` };
    out.set(place.toLowerCase(), { place, name });
  }
  return { ok: true, aliases: [...out.values()] };
}
