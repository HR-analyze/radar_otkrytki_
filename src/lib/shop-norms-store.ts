import fs from 'node:fs';
import path from 'node:path';
import { manualDbWritable, openManualDb } from './manual-db';
import { sortTimes } from './parsers/shop-norms';
import type { ShopNorms } from './types';

/**
 * Нормативы открытия по лавкам: во сколько должен приехать водитель и к
 * какому времени выйти повара.
 *
 * Откуда берутся. Основа — справочник «Лавки», разобранный в
 * `fixtures/shop-norms.json` (см. scripts/build-shop-norms.ts). Поверх сида
 * ложатся правки, сделанные на вкладке «Пороги»; они живут в базе ручных
 * данных `data/manual.db` — вне git, потому что деплой затирает всё, что
 * лежит в репозитории (см. manual-db.ts).
 *
 * Почему правка перекрывает сид, а не заливается в базу один раз, как
 * витрины: нормы — справочник, а не история. Справочник перевыгружают, и
 * лавка, которую руками не трогали, должна поехать по новым цифрам; лавка с
 * правкой — остаться на своих. Оверлей делает ровно это, разовая заливка —
 * наоборот, навсегда заморозила бы первую версию справочника.
 */

export const SHOP_NORMS_SEED_PATH = path.join('fixtures', 'shop-norms.json');

export interface ShopNormsStore {
  /** Код лавки → норматив. */
  byCode: Record<string, ShopNorms>;
  /** Когда последний раз правили нормы на сайте; null — правок не было. */
  updatedAt: string | null;
  /** Есть ли поверх сида правки из базы. */
  hasEdits: boolean;
}

/** Правка норматива: строка заменяет норму лавки целиком. */
export interface ShopNormsEdit {
  shopCode: string;
  /** «06:30»; null — у лавки нет нормы приезда водителя. */
  driverAt: string | null;
  /** Часы выхода поваров: ['06:20'] или ['06:00', '06:30']. */
  cookAt: string[];
}

function seedPath(): string {
  return process.env.RADAR_SHOP_NORMS_PATH ?? path.join(process.cwd(), SHOP_NORMS_SEED_PATH);
}

export function canEditNorms(): boolean {
  return manualDbWritable();
}

export function normsEditHint(): string {
  return canEditNorms()
    ? 'Правки сохраняются в базу сразу и действуют со следующей пересборки снимка.'
    : 'Здесь только просмотр: на этом хостинге нет диска под базу ручных данных. ' +
        'Правьте нормы там, где радар развёрнут на своём сервере.';
}

/** Сид из репозитория — разобранный справочник «Лавки». */
export function readNormsSeed(): ShopNorms[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ seedPath(), 'utf8'),
    ) as { norms?: unknown };
    if (!Array.isArray(raw.norms)) return [];
    return raw.norms.filter(isShopNorms);
  } catch {
    return [];
  }
}

export async function readNorms(): Promise<ShopNormsStore> {
  const byCode: Record<string, ShopNorms> = {};
  for (const n of readNormsSeed()) byCode[n.code] = n;

  const db = await openManualDb();
  if (!db) return { byCode, updatedAt: null, hasEdits: false };

  const rows = db
    .prepare(`SELECT shop_code, driver_at, cook_shifts, updated_at FROM shop_norms`)
    .all() as { shop_code: string; driver_at: string | null; cook_shifts: string; updated_at: string }[];

  let updatedAt: string | null = null;
  for (const r of rows) {
    const base = byCode[r.shop_code];
    byCode[r.shop_code] = {
      // Лавки может не быть в сиде вовсе — норму завели руками, а справочник
      // ещё не перевыгрузили. Тогда имя берём из кода: другого источника нет.
      code: r.shop_code,
      name: base?.name ?? r.shop_code,
      driverAt: r.driver_at,
      cookAt: parseCookJson(r.cook_shifts),
      rawDriver: base?.rawDriver ?? null,
      rawCook: base?.rawCook ?? null,
      source: 'manual',
      // Предупреждения относятся к разбору справочника. Строку поправили
      // руками — значит на неё уже посмотрели, и жалобы разбора неактуальны.
      warnings: [],
    };
    if (!updatedAt || r.updated_at > updatedAt) updatedAt = r.updated_at;
  }

  return { byCode, updatedAt, hasEdits: rows.length > 0 };
}

/**
 * Сохраняет правки. Возвращает, сколько лавок реально изменилось: повтор той
 * же нормы правкой не считается.
 */
export async function saveNormsEdits(
  edits: readonly ShopNormsEdit[],
  now = new Date().toISOString(),
): Promise<{ changed: number }> {
  const db = await openManualDb();
  if (!db) {
    throw new Error(
      'Нормы некуда сохранять: на этом хостинге нет диска под базу ручных данных. ' +
        'Правьте там, где радар развёрнут на своём сервере.',
    );
  }

  const put = db.prepare(
    `INSERT INTO shop_norms (shop_code, driver_at, cook_shifts, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(shop_code) DO UPDATE SET
       driver_at = excluded.driver_at,
       cook_shifts = excluded.cook_shifts,
       updated_at = excluded.updated_at`,
  );
  const current = db.prepare(
    `SELECT driver_at, cook_shifts FROM shop_norms WHERE shop_code = ?`,
  );

  const apply = db.transaction((list: readonly ShopNormsEdit[]) => {
    let changed = 0;
    for (const e of list) {
      const plan = JSON.stringify(sortTimes(e.cookAt));
      const before = current.get(e.shopCode) as
        | { driver_at: string | null; cook_shifts: string }
        | undefined;

      if (before && before.driver_at === e.driverAt && before.cook_shifts === plan) continue;

      put.run(e.shopCode, e.driverAt, plan, now);
      changed++;
    }
    return changed;
  });

  return { changed: apply(edits) };
}

/** Убирает правку: лавка возвращается к норме из справочника. */
export async function resetNorms(shopCode: string): Promise<boolean> {
  const db = await openManualDb();
  if (!db) return false;
  return db.prepare(`DELETE FROM shop_norms WHERE shop_code = ?`).run(shopCode).changes > 0;
}

/**
 * Дешёвая «версия» норм: по ней снимок понимает, что нормы правили, и
 * пересчитывает статусы. Читать все строки на каждый рендер незачем.
 */
export async function normsVersion(): Promise<string> {
  const db = await openManualDb();
  if (!db) return 'seed';

  const row = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS at FROM shop_norms`)
    .get() as { n: number; at: string };
  return `db|${row.at}|${row.n}`;
}

/**
 * Часы плана из базы.
 *
 * Понимает и прежний формат `[{"count":2,"at":"06:20"}]`: до того, как
 * количество поваров убрали из нормы, правки писались так, и база у людей на
 * своих серверах уже могла их накопить.
 */
function parseCookJson(raw: string): string[] {
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];

    const times = parsed
      .map((item) => {
        if (typeof item === 'string') return item;
        const legacy = item as { at?: unknown };
        return typeof legacy?.at === 'string' ? legacy.at : null;
      })
      .filter((t): t is string => t != null && CLOCK.test(t));

    return sortTimes(times);
  } catch {
    return [];
  }
}

const CLOCK = /^\d{1,2}:\d{2}$/;

function isShopNorms(value: unknown): value is ShopNorms {
  const n = value as ShopNorms;
  return typeof n === 'object' && n !== null && typeof n.code === 'string';
}
