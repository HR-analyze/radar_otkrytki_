import { manualDbWritable, openManualDb } from './manual-db';
import { STAFF_ROLES, normalizePlace, type StaffNorm, type StaffPost, type StaffRole } from './staffing';
import { readStaffing, readStaffingBook, type StaffingSeed } from './staffing-store';
import {
  applyPlaceAliases,
  defaultPlaceName,
  placeAliasMap,
  placeKey,
  resolvePlace,
  type FunctionOption,
  type PlaceAlias,
} from './staffing-places';

/**
 * Правки «Графика пиков» с сайта: сколько человек в окне и кто где стоит.
 *
 * Как и нормы открытия (shop-norms-store.ts), правка — оверлей поверх сида:
 * строка на лавку, которая перекрывает её окна и дислокации. Шаблон
 * пересобрали — лавка без правки поедет по новым цифрам, лавка с правкой
 * останется на своих, пока правку не сбросят кнопкой «Вернуть шаблон».
 *
 * Хранится там же, где остальные ручные данные: PostgreSQL на RelaxDev,
 * SQLite `data/manual.db` на своём сервере. Нет ни того, ни другого — только
 * просмотр.
 */

/** Правка одной должности: число людей в каждом окне и посты окна. */
export interface StaffRoleEdit {
  counts: number[];
  /**
   * Посты окна; null — окно не трогали, в нём остаётся расстановка из книги
   * или по правилам руководства (staffing-rules.ts).
   */
  posts: (StaffPost[] | null)[];
  /**
   * Время окон, [начало, конец] в минутах от полуночи, параллельно counts.
   * Поля нет — время как в шаблоне (правки, сохранённые до 28.10.2026).
   */
  times?: [number, number][];
}

export interface StaffingEdit {
  shopCode: string;
  roles: Partial<Record<StaffRole, StaffRoleEdit>>;
  updatedAt: string;
}

export function canEditStaffing(): boolean {
  return process.env.RADAR_STORAGE === 'postgres' || manualDbWritable();
}

/**
 * Наложить правки на нормы: числа, посты и время окон. Число окон правка не
 * меняет: если в новом шаблоне у должности их стало другое число, правка этой
 * должности не подходит и пропускается (лавка поедет по шаблону), а не
 * разъезжается по чужим окнам.
 */
export function applyStaffingEdits(
  norms: readonly StaffNorm[],
  edits: readonly StaffingEdit[],
  /**
   * Нормы как в книгах, до правил руководства. Нужны для старых правок: до
   * 28.10.2026 форма сохраняла расстановку лавки целиком, и правка М50
   * заморозила книжное «2 разогрев» поверх правила. Пост правки, который
   * совпадает с книгой, — не правка, а копия: в этом окне работает правило.
   */
  book: readonly StaffNorm[] = norms,
): StaffNorm[] {
  const byCode = new Map(edits.map((e) => [e.shopCode, e]));
  const bookByCode = new Map(book.map((b) => [b.code, b]));
  return norms.map((n) => {
    const edit = byCode.get(n.code);
    if (!edit) return n;
    const roles = { ...n.roles };
    for (const role of STAFF_ROLES) {
      const e = edit.roles[role];
      const base = n.roles[role];
      if (!e || e.counts.length !== base.slots.length) continue;
      roles[role] = {
        ...base,
        slots: base.slots.map((s, i) => {
          const t = e.times?.length === base.slots.length ? e.times[i] : null;
          return { ...s, ...(t && { from: t[0], to: t[1] }), count: e.counts[i] };
        }),
        // Через normalizePlace и на чтении: правило мест могло поменяться после
        // того, как правку сохранили («прием» → «официант»).
        posts: base.slots.map((_, i) => {
          const edited = e.posts[i];
          if (edited == null) return base.posts?.[i] ?? [];
          const clean = edited.map((p) => ({ ...p, place: normalizePlace(p.place) }));
          const fromBook = bookByCode.get(n.code)?.roles[role].posts?.[i] ?? [];
          return sameDislocation(clean, fromBook) ? (base.posts?.[i] ?? []) : clean;
        }),
      };
    }
    return { ...n, roles, editedAt: edit.updatedAt };
  });
}

/**
 * Разбор правки из запроса. Окон — столько же, сколько в шаблоне, числа —
 * целые от 0 до 50, постов в окне — не больше 20, место — не длиннее 80
 * знаков. Время окна — «ЧЧ:ММ», начало раньше конца, окна идут по порядку и
 * не наезжают друг на друга: иначе в одну минуту действовали бы два окна, и
 * калькулятор показывал бы первое попавшееся. Всё остальное — опечатка или
 * чужой запрос, и в базу оно не пойдёт.
 */
export function parseStaffingEdit(
  norm: StaffNorm,
  body: unknown,
): { ok: true; roles: StaffingEdit['roles'] } | { ok: false; error: string } {
  const raw = (body as { roles?: unknown })?.roles;
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Нет правок' };
  const roles: StaffingEdit['roles'] = {};
  for (const role of STAFF_ROLES) {
    const r = (raw as Record<string, unknown>)[role] as { counts?: unknown; posts?: unknown; times?: unknown } | undefined;
    if (!r) continue;
    const slots = norm.roles[role].slots;
    if (!Array.isArray(r.counts) || r.counts.length !== slots.length) {
      return { ok: false, error: `${role}: окон должно быть ${slots.length}` };
    }
    const counts = r.counts.map(Number);
    if (counts.some((c) => !Number.isInteger(c) || c < 0 || c > 50)) {
      return { ok: false, error: `${role}: людей в окне — целое число от 0 до 50` };
    }
    const postsRaw = Array.isArray(r.posts) ? r.posts : [];
    const posts: (StaffPost[] | null)[] = [];
    for (let i = 0; i < slots.length; i++) {
      // null — окно не трогали (форма шлёт только изменённые окна).
      if (postsRaw[i] === null || postsRaw[i] === undefined) {
        posts.push(null);
        continue;
      }
      const list = Array.isArray(postsRaw[i]) ? (postsRaw[i] as unknown[]) : [];
      if (list.length > 20) return { ok: false, error: `${role}: в окне больше 20 постов` };
      const clean: StaffPost[] = [];
      for (const p of list) {
        const place = normalizePlace(String((p as StaffPost)?.place ?? ''));
        const count = (p as StaffPost)?.count;
        if (!place) continue;
        if (place.length > 80) return { ok: false, error: `${role}: место длиннее 80 знаков` };
        if (count != null && (!Number.isInteger(count) || count < 0 || count > 50)) {
          return { ok: false, error: `${role}: людей на посту — целое число от 0 до 50` };
        }
        clean.push({ count: count ?? null, place });
      }
      posts.push(clean);
    }
    let times: [number, number][] | undefined;
    if (r.times != null) {
      if (!Array.isArray(r.times) || r.times.length !== slots.length) {
        return { ok: false, error: `${role}: время нужно для всех ${slots.length} окон` };
      }
      times = [];
      for (const t of r.times as unknown[]) {
        const [a, b] = Array.isArray(t) ? t.map(clock) : [null, null];
        if (a == null || b == null || a >= b) return { ok: false, error: `${role}: у окна начало должно быть раньше конца` };
        const prev = times[times.length - 1];
        if (prev && a < prev[1]) return { ok: false, error: `${role}: окна наезжают друг на друга — ${fmt(a)} раньше ${fmt(prev[1])}` };
        times.push([a, b]);
      }
    }
    roles[role] = { counts, posts, ...(times && { times }) };
  }
  return { ok: true, roles };
}

/** «07:30» или 450 → минуты от полуночи; конец суток — «24:00» → 1440. */
function clock(v: unknown): number | null {
  if (typeof v === 'number') return Number.isInteger(v) && v >= 0 && v <= 1440 ? v : null;
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(v ?? '').trim());
  if (!m) return null;
  const minutes = Number(m[1]) * 60 + Number(m[2]);
  return Number(m[2]) < 60 && minutes <= 1440 ? minutes : null;
}

const fmt = (m: number) => `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`;

export async function readStaffingEdits(): Promise<StaffingEdit[]> {
  const rows = await readRows();
  return rows.flatMap((r) => {
    try {
      return [{ shopCode: r.shop_code, roles: JSON.parse(r.roles), updatedAt: r.updated_at }];
    } catch {
      return [];
    }
  });
}

/**
 * Нормы с правками лавок, но ещё со своими написаниями мест — из них вкладка
 * «Функционалы» собирает список написаний (см. collectPlaces).
 */
export async function readStaffingUnnamed(): Promise<StaffingSeed> {
  const seed = readStaffing();
  try {
    return { ...seed, norms: applyStaffingEdits(seed.norms, await readStaffingEdits(), readStaffingBook().norms) };
  } catch {
    // База недоступна — показываем шаблон, а не падаем: правки вернутся,
    // когда вернётся база.
    return seed;
  }
}

/**
 * Нормы из репозитория с правками сайта поверх и едиными названиями мест —
 * то, что видят вкладка и выгрузки.
 */
export async function readStaffingLive(): Promise<StaffingSeed> {
  const seed = await readStaffingUnnamed();
  return { ...seed, norms: applyPlaceAliases(seed.norms, placeAliasMap(await readPlaceAliasesSafe())) };
}

/* ------------------------- единые названия мест ------------------------- */

/** Строки словаря, сохранённые с сайта (без словаря по умолчанию). */
export async function readPlaceAliases(): Promise<PlaceAlias[]> {
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgRows } = await import('./postgres');
    return pgRows<{ place: string; name: string }>('SELECT place, name FROM radar_pg_staffing_places');
  }
  const db = await openManualDb();
  if (!db) return [];
  return db.prepare(`SELECT place, name FROM staffing_places`).all() as PlaceAlias[];
}

/** То же, но без базы — пустой список: названия идут по словарю по умолчанию. */
export async function readPlaceAliasesSafe(): Promise<PlaceAlias[]> {
  try {
    return await readPlaceAliases();
  } catch {
    return [];
  }
}

/** Запись журнала правок словаря: что было и что стало у написания. */
export interface PlaceLogEntry {
  id: number;
  at: string;
  /** Ключ написания (см. placeKey). */
  place: string;
  /** Название до правки; null — строки не было (словарь по умолчанию). */
  oldName: string | null;
  /** Название после; null — строку удалили. */
  newName: string | null;
  author: string;
}

/**
 * Сохранить строки словаря (остальные не трогаются) и записать в журнал, что
 * поменялось: кто, когда, что было. Одна строка словаря меняет всю сеть —
 * без журнала сломанное название не из чего вернуть.
 */
export async function savePlaceAliases(aliases: readonly PlaceAlias[], now: string, author: string): Promise<void> {
  await writePlaces(
    aliases.map((a) => ({ place: placeKey(a.place), name: a.name })),
    now,
    author,
  );
}

/** Удалить строку словаря: написание снова идёт по словарю по умолчанию. */
export async function deletePlaceAlias(place: string, now: string, author: string): Promise<void> {
  await writePlaces([{ place: placeKey(place), name: null }], now, author);
}

/**
 * Принять написание как есть — не правка, журнал ею не засоряем: строка
 * появилась, а название не поменялось.
 */
function logged(place: string, oldName: string | null, newName: string | null): boolean {
  if (oldName === newName) return false;
  return !(oldName == null && newName === defaultPlaceName(place));
}

async function writePlaces(rows: readonly { place: string; name: string | null }[], now: string, author: string): Promise<void> {
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgTx } = await import('./postgres');
    await pgTx(async (c) => {
      for (const r of rows) {
        const old = await c.query('SELECT name FROM radar_pg_staffing_places WHERE place=$1', [r.place]);
        const oldName = (old.rows[0] as { name: string } | undefined)?.name ?? null;
        if (r.name == null) await c.query('DELETE FROM radar_pg_staffing_places WHERE place=$1', [r.place]);
        else
          await c.query(
            'INSERT INTO radar_pg_staffing_places(place,name,updated_at) VALUES($1,$2,$3) ' +
              'ON CONFLICT(place) DO UPDATE SET name=excluded.name,updated_at=excluded.updated_at',
            [r.place, r.name, now],
          );
        if (logged(r.place, oldName, r.name)) {
          await c.query(
            'INSERT INTO radar_pg_staffing_places_log(at,place,old_name,new_name,author) VALUES($1,$2,$3,$4,$5)',
            [now, r.place, oldName, r.name, author],
          );
        }
      }
    });
    return;
  }
  const db = await openManualDb();
  if (!db) throw new Error('Названия негде хранить: нет базы ручных данных');
  const get = db.prepare(`SELECT name FROM staffing_places WHERE place = ?`);
  const del = db.prepare(`DELETE FROM staffing_places WHERE place = ?`);
  const put = db.prepare(
    `INSERT INTO staffing_places(place, name, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(place) DO UPDATE SET name = excluded.name, updated_at = excluded.updated_at`,
  );
  const log = db.prepare(`INSERT INTO staffing_places_log(at, place, old_name, new_name, author) VALUES (?, ?, ?, ?, ?)`);
  db.transaction(() => {
    for (const r of rows) {
      const oldName = (get.get(r.place) as { name: string } | undefined)?.name ?? null;
      if (r.name == null) del.run(r.place);
      else put.run(r.place, r.name, now);
      if (logged(r.place, oldName, r.name)) log.run(now, r.place, oldName, r.name, author);
    }
  })();
}

/** Последние правки словаря, новые сверху; без базы — пусто. */
export async function readPlaceLog(limit = 50): Promise<PlaceLogEntry[]> {
  type Row = { id: number | string; at: string; place: string; old_name: string | null; new_name: string | null; author: string };
  try {
    let rows: Row[];
    if (process.env.RADAR_STORAGE === 'postgres') {
      const { pgRows } = await import('./postgres');
      rows = await pgRows<Row>(
        'SELECT id, at, place, old_name, new_name, author FROM radar_pg_staffing_places_log ORDER BY at DESC, id DESC LIMIT $1',
        [limit],
      );
    } else {
      const db = await openManualDb();
      if (!db) return [];
      rows = db
        .prepare(`SELECT id, at, place, old_name, new_name, author FROM staffing_places_log ORDER BY at DESC, id DESC LIMIT ?`)
        .all(limit) as Row[];
    }
    return rows.map((r) => ({ id: Number(r.id), at: r.at, place: r.place, oldName: r.old_name, newName: r.new_name, author: r.author }));
  } catch {
    return [];
  }
}

/**
 * Посты правки лавки — только функционалы из справочника (см. functionCatalog).
 * Форма даёт лишь выбор из списка, но запрос можно собрать и руками — проверяем
 * и здесь. Написание, которое словарь сводит к функционалу («разог»), проходит
 * и сохраняется уже единым названием.
 */
export function restrictToCatalog(
  roles: StaffingEdit['roles'],
  catalog: readonly FunctionOption[],
  aliases: ReadonlyMap<string, string>,
): { ok: true; roles: StaffingEdit['roles'] } | { ok: false; error: string } {
  const known = new Map(catalog.map((f) => [f.name.toLowerCase(), f.name]));
  const out: StaffingEdit['roles'] = {};
  for (const role of STAFF_ROLES) {
    const r = roles[role];
    if (!r) continue;
    const posts: (StaffPost[] | null)[] = [];
    for (const w of r.posts) {
      if (w == null) {
        posts.push(null);
        continue;
      }
      const clean: StaffPost[] = [];
      for (const p of w) {
        const name = known.get(resolvePlace(p.place, aliases).toLowerCase());
        if (!name) return { ok: false, error: `«${p.place}» нет в справочнике — добавьте функционал на вкладке «Функционалы»` };
        const same = clean.find((q) => q.place === name && q.count != null && p.count != null);
        if (same) same.count! += p.count!;
        else clean.push({ count: p.count, place: name });
      }
      posts.push(clean);
    }
    out[role] = { ...r, posts };
  }
  return { ok: true, roles: out };
}

export async function saveStaffingEdit(shopCode: string, roles: StaffingEdit['roles'], now: string): Promise<void> {
  const json = JSON.stringify(roles);
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgTx } = await import('./postgres');
    await pgTx(async (c) => {
      await c.query(
        'INSERT INTO radar_pg_staffing_edits(shop_code,roles,updated_at) VALUES($1,$2,$3) ' +
          'ON CONFLICT(shop_code) DO UPDATE SET roles=excluded.roles,updated_at=excluded.updated_at',
        [shopCode, json, now],
      );
    });
    return;
  }
  const db = await openManualDb();
  if (!db) throw new Error('Правки негде хранить: нет базы ручных данных');
  db.prepare(
    `INSERT INTO staffing_edits(shop_code, roles, updated_at) VALUES (?, ?, ?)
     ON CONFLICT(shop_code) DO UPDATE SET roles = excluded.roles, updated_at = excluded.updated_at`,
  ).run(shopCode, json, now);
}

export async function resetStaffingEdit(shopCode: string): Promise<boolean> {
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgTx } = await import('./postgres');
    return pgTx(async (c) => ((await c.query('DELETE FROM radar_pg_staffing_edits WHERE shop_code=$1', [shopCode])).rowCount ?? 0) > 0);
  }
  const db = await openManualDb();
  if (!db) return false;
  return db.prepare(`DELETE FROM staffing_edits WHERE shop_code = ?`).run(shopCode).changes > 0;
}

async function readRows(): Promise<{ shop_code: string; roles: string; updated_at: string }[]> {
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgRows } = await import('./postgres');
    return pgRows('SELECT shop_code, roles, updated_at FROM radar_pg_staffing_edits');
  }
  const db = await openManualDb();
  if (!db) return [];
  return db.prepare(`SELECT shop_code, roles, updated_at FROM staffing_edits`).all() as {
    shop_code: string;
    roles: string;
    updated_at: string;
  }[];
}

/** Одна и та же расстановка окна: те же места и числа, порядок неважен. */
function sameDislocation(a: readonly StaffPost[], b: readonly StaffPost[]): boolean {
  const key = (list: readonly StaffPost[]) =>
    list
      .map((p) => `${p.count ?? ''}|${normalizePlace(p.place).toLowerCase()}`)
      .sort()
      .join(';');
  return key(a) === key(b);
}
