// This storage is independent from SQLite on the old Yandex VM.
export const postgresEnabled = (): boolean => process.env.RADAR_STORAGE === 'postgres';

type Row = Record<string, unknown>;
export type DbClient = {
  query: (sql: string, values?: unknown[]) => Promise<{ rows: Row[]; rowCount: number | null }>;
};

let pool: { query: DbClient['query']; connect: () => Promise<DbClient & { release: () => void }> } | null = null;
let initialized: Promise<void> | null = null;

function getPool() {
  if (pool) return pool;
  const url = process.env.DATABASE_URL;
  if (!url) throw new Error('RADAR_STORAGE=postgres требует DATABASE_URL');
  // Require at runtime: the old SQLite branch does not import the pg driver.
  const { Pool } = require('pg') as { Pool: new (o: { connectionString: string; max: number }) => NonNullable<typeof pool> };
  pool = new Pool({ connectionString: url, max: 8 });
  return pool;
}

const SCHEMA = String.raw`
CREATE TABLE IF NOT EXISTS radar_pg_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS radar_pg_showcase_fill (
  date TEXT NOT NULL, shop_code TEXT NOT NULL, fill DOUBLE PRECISION NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(date, shop_code));
CREATE TABLE IF NOT EXISTS radar_pg_showcase_fill_afternoon (
  date TEXT NOT NULL, shop_code TEXT NOT NULL, fill DOUBLE PRECISION NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(date, shop_code));
CREATE TABLE IF NOT EXISTS radar_pg_showcase_note (
  date TEXT NOT NULL, shop_code TEXT NOT NULL, note TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY(date, shop_code));
CREATE TABLE IF NOT EXISTS radar_pg_showcase_day (date TEXT PRIMARY KEY, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS radar_pg_showcase_audit (
  id BIGSERIAL PRIMARY KEY, at TEXT NOT NULL, date TEXT NOT NULL, shop_code TEXT NOT NULL,
  field TEXT NOT NULL, old_value TEXT, new_value TEXT, source TEXT NOT NULL,
  legacy_id BIGINT UNIQUE);
CREATE INDEX IF NOT EXISTS radar_pg_showcase_audit_at ON radar_pg_showcase_audit(at DESC, id DESC);
CREATE TABLE IF NOT EXISTS radar_pg_shop_norms (
  shop_code TEXT PRIMARY KEY, driver_at TEXT, cook_shifts TEXT NOT NULL, updated_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS radar_pg_region_periods (
  id BIGSERIAL PRIMARY KEY, shop_code TEXT NOT NULL, manager TEXT NOT NULL,
  from_date TEXT NOT NULL, to_date TEXT, source TEXT NOT NULL, legacy_id BIGINT UNIQUE);
CREATE INDEX IF NOT EXISTS radar_pg_region_periods_shop ON radar_pg_region_periods(shop_code,from_date);
CREATE TABLE IF NOT EXISTS radar_pg_contest_violations (
  id TEXT PRIMARY KEY, shop_code TEXT NOT NULL, region TEXT NOT NULL,
  reason TEXT NOT NULL, created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS radar_pg_uploads (
  id BIGSERIAL PRIMARY KEY, at TEXT NOT NULL, original_name TEXT NOT NULL, file_name TEXT NOT NULL,
  kind TEXT NOT NULL, summary TEXT NOT NULL, dates TEXT NOT NULL, "rows" INTEGER NOT NULL, mode TEXT NOT NULL,
  legacy_id BIGINT UNIQUE);
CREATE INDEX IF NOT EXISTS radar_pg_uploads_at ON radar_pg_uploads(at DESC, id DESC);
CREATE TABLE IF NOT EXISTS radar_pg_archive (
  kind TEXT NOT NULL, legacy_key TEXT NOT NULL, payload JSONB NOT NULL,
  PRIMARY KEY(kind,legacy_key));
`;

export async function ensurePg(): Promise<void> {
  if (!initialized) {
    initialized = getPool().query(SCHEMA).then(() => undefined).catch((err: unknown) => {
      initialized = null;
      throw err;
    });
  }
  await initialized;
}

export async function pgRows<T extends Row = Row>(sql: string, values: unknown[] = []): Promise<T[]> {
  await ensurePg();
  const result = await getPool().query(sql, values);
  return result.rows as T[];
}

export async function pgTx<T>(fn: (c: DbClient) => Promise<T>): Promise<T> {
  await ensurePg();
  const c = await getPool().connect();
  try {
    await c.query('BEGIN');
    // Serialize manual edits, seed and legacy imports in one database.
    await c.query('SELECT pg_advisory_xact_lock(117730026)');
    const result = await fn(c);
    await c.query('COMMIT');
    return result;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
