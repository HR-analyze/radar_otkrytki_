import fs from 'node:fs';
import path from 'node:path';
import { getMeta, manualDbWritable, openManualDb, setMeta } from './manual-db';
import { OwnersConflictError, parseOwners, parseShopsJson, type ShowcaseOwner } from './showcase-owners';
import bundledSeed from '../../fixtures/showcase-owners.json';

/**
 * Где живёт список «кто какие лавки заполняет».
 *
 * Как и витрины, это данные, которые вводит человек, поэтому они в базе
 * ручных данных, а не в репозитории: деплой затирает всё, что лежит в git
 * (см. manual-db.ts). `fixtures/showcase-owners.json` — сид: из него база
 * наполняется один раз, и он же показывается там, где базы нет вовсе.
 *
 * Сид заливается один раз, а не накладывается поверх, как нормы лавок: это не
 * справочник, который перевыгружают, а решение команды. Убранный из списка
 * человек не должен воскреснуть из файла при следующем запуске.
 */

export interface OwnersStore {
  owners: ShowcaseOwner[];
  /** Когда список последний раз сохраняли; по нему же ловится чужая правка. */
  updatedAt: string | null;
  source: 'db' | 'seed';
}

export interface OwnersSeed {
  owners: ShowcaseOwner[];
  updatedAt: string | null;
}

export interface SaveOwnersOptions {
  /**
   * updatedAt, с которым редактор открывал список. Не совпал с текущим —
   * значит, список успели поменять, и сохранение отклоняется. undefined — не
   * проверять (скрипты, тесты).
   */
  expectedUpdatedAt?: string | null;
  now?: string;
}

const SEEDED = 'showcase_owners_seeded';
const UPDATED = 'showcase_owners_updated_at';

export function ownersSeedPath(): string {
  return process.env.RADAR_OWNERS_PATH ?? path.join(process.cwd(), 'fixtures', 'showcase-owners.json');
}

export function canEditOwners(): boolean {
  return process.env.RADAR_STORAGE === 'postgres' || manualDbWritable();
}

/** Сид из репозитория. Сервер, запущенный не из корня, берёт вшитую копию. */
export function readOwnersSeed(): OwnersSeed {
  let raw: { owners?: unknown; updatedAt?: unknown };
  try {
    raw = JSON.parse(fs.readFileSync(/* turbopackIgnore: true */ ownersSeedPath(), 'utf8'));
  } catch {
    raw = bundledSeed;
  }
  const parsed = parseOwners(raw.owners ?? []);
  return {
    owners: parsed.ok ? parsed.value : [],
    updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null,
  };
}

export async function readOwners(): Promise<OwnersStore> {
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgReadOwners } = await import('./pg-manual');
    return { ...(await pgReadOwners(readOwnersSeed)), source: 'db' };
  }
  const db = await openManualDb();
  if (!db) return { ...readOwnersSeed(), source: 'seed' };

  seedOnce(db);
  const rows = db
    .prepare(`SELECT name, shops FROM showcase_owners ORDER BY position`)
    .all() as { name: string; shops: string }[];
  return {
    owners: rows.map((r) => ({ name: r.name, shops: parseShopsJson(r.shops) })),
    updatedAt: getMeta(db, UPDATED),
    source: 'db',
  };
}

/** Заменяет список целиком: что прислали, то и стало. */
export async function saveOwners(
  owners: readonly ShowcaseOwner[],
  options: SaveOwnersOptions = {},
): Promise<OwnersStore> {
  const now = options.now ?? new Date().toISOString();
  if (process.env.RADAR_STORAGE === 'postgres') {
    const { pgSaveOwners } = await import('./pg-manual');
    await pgSaveOwners(owners, options.expectedUpdatedAt, now, readOwnersSeed);
    return readOwners();
  }
  const db = await openManualDb();
  if (!db) {
    throw new Error(
      'Список некуда сохранять: на этом хостинге нет диска под базу ручных данных. ' +
        'Правьте там, где радар развёрнут на своём сервере.',
    );
  }
  seedOnce(db);

  const put = db.prepare(
    `INSERT INTO showcase_owners (position, name, shops, updated_at) VALUES (?, ?, ?, ?)`,
  );
  db.transaction(() => {
    if (options.expectedUpdatedAt !== undefined && options.expectedUpdatedAt !== getMeta(db, UPDATED)) {
      throw new OwnersConflictError();
    }
    db.prepare(`DELETE FROM showcase_owners`).run();
    owners.forEach((o, i) => put.run(i, o.name, JSON.stringify(o.shops), now));
    setMeta(db, UPDATED, now);
  })();

  return readOwners();
}

function seedOnce(db: NonNullable<Awaited<ReturnType<typeof openManualDb>>>): void {
  if (getMeta(db, SEEDED)) return;
  const seed = readOwnersSeed();
  const put = db.prepare(
    `INSERT OR IGNORE INTO showcase_owners (position, name, shops, updated_at) VALUES (?, ?, ?, ?)`,
  );
  const at = seed.updatedAt ?? new Date().toISOString();
  db.transaction(() => {
    seed.owners.forEach((o, i) => put.run(i, o.name, JSON.stringify(o.shops), at));
    setMeta(db, UPDATED, at);
    setMeta(db, SEEDED, new Date().toISOString());
  })();
}
