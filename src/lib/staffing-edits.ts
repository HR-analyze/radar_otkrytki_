import { manualDbWritable, openManualDb } from './manual-db';
import { STAFF_ROLES, normalizePlace, type StaffNorm, type StaffPost, type StaffRole } from './staffing';
import { readStaffing, type StaffingSeed } from './staffing-store';

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
  posts: StaffPost[][];
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
 * Наложить правки на нормы. Окна правка не двигает — только числа и посты:
 * если в новом шаблоне у должности стало другое число окон, правка этой
 * должности не подходит и пропускается (лавка поедет по шаблону), а не
 * разъезжается по чужим окнам.
 */
export function applyStaffingEdits(norms: readonly StaffNorm[], edits: readonly StaffingEdit[]): StaffNorm[] {
  const byCode = new Map(edits.map((e) => [e.shopCode, e]));
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
        slots: base.slots.map((s, i) => ({ ...s, count: e.counts[i] })),
        posts: base.slots.map((_, i) => e.posts[i] ?? []),
      };
    }
    return { ...n, roles, editedAt: edit.updatedAt };
  });
}

/**
 * Разбор правки из запроса. Окна должны совпасть с текущими, числа — целые
 * от 0 до 50, постов в окне — не больше 20, место — не длиннее 80 знаков:
 * всё остальное — опечатка или чужой запрос, и в базу оно не пойдёт.
 */
export function parseStaffingEdit(
  norm: StaffNorm,
  body: unknown,
): { ok: true; roles: StaffingEdit['roles'] } | { ok: false; error: string } {
  const raw = (body as { roles?: unknown })?.roles;
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'Нет правок' };
  const roles: StaffingEdit['roles'] = {};
  for (const role of STAFF_ROLES) {
    const r = (raw as Record<string, unknown>)[role] as { counts?: unknown; posts?: unknown } | undefined;
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
    const posts: StaffPost[][] = [];
    for (let i = 0; i < slots.length; i++) {
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
    roles[role] = { counts, posts };
  }
  return { ok: true, roles };
}

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

/** Нормы из репозитория с правками сайта поверх — то, что видят вкладка и выгрузки. */
export async function readStaffingLive(): Promise<StaffingSeed> {
  const seed = readStaffing();
  try {
    return { ...seed, norms: applyStaffingEdits(seed.norms, await readStaffingEdits()) };
  } catch {
    // База недоступна — показываем шаблон, а не падаем: правки вернутся,
    // когда вернётся база.
    return seed;
  }
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
