import fs from 'node:fs';
import path from 'node:path';
import type BetterSqlite3 from 'better-sqlite3';

/**
 * База данных, которые вводят люди, а не выгружает 1С.
 *
 * Почему отдельно и почему вообще база. Наполнение витрин сначала хранилось в
 * `fixtures/showcase.json` — файле внутри репозитория. На сервере правки
 * ложились в него же, а очередной деплой (`git pull` и разрешение конфликта)
 * возвращал файл к версии из репозитория: всё, что заполнили руками после
 * последнего коммита, пропадало. Так и потерялись витрины за 03.09.2026.
 *
 * Отсюда правило: то, что вводит человек, живёт в `data/` — вне git. Деплой
 * туда не заглядывает, а SQLite вдобавок переживает одновременную правку с
 * двух компьютеров, чего JSON-файл не умеет: там побеждал бы тот, кто сохранил
 * последним, затирая чужие цифры.
 *
 * Файл свой, не `data/radar.db`: тот включает режим SQLite для всего дашборда
 * (см. storageMode), и появление базы ручных данных ломало бы чтение выгрузок.
 *
 * На хостинге без диска (Vercel) базы нет — там витрины читаются из
 * закоммиченного сида и не правятся.
 */

export function manualDbPath(): string {
  return process.env.RADAR_MANUAL_DB_PATH ?? path.join(process.cwd(), 'data', 'manual.db');
}

/** Можно ли писать: нужен диск, а на Vercel его нет. */
export function manualDbWritable(): boolean {
  if (process.env.VERCEL) return false;

  const dir = path.dirname(manualDbPath());
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
    fs.accessSync(/* turbopackIgnore: true */ dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

let cached: BetterSqlite3.Database | null = null;

/**
 * `better-sqlite3` подключается только динамическим import() — на serverless
 * нативный модуль не собирается, и статический импорт уронил бы страницы.
 * Не открылась — значит работаем без базы, а не падаем.
 */
export async function openManualDb(): Promise<BetterSqlite3.Database | null> {
  if (cached) return cached;
  if (!manualDbWritable()) return null;

  try {
    const { default: Database } = await import('better-sqlite3');
    const file = manualDbPath();
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });

    const db = new Database(file);
    db.pragma('journal_mode = WAL');
    migrate(db);

    cached = db;
    return db;
  } catch {
    return null;
  }
}

function migrate(db: BetterSqlite3.Database): void {
  db.exec(`
    -- Наполнение витрины: одна строка = лавка за день.
    CREATE TABLE IF NOT EXISTS showcase_fill (
      date       TEXT NOT NULL,
      shop_code  TEXT NOT NULL,
      -- Доля 0–1. Отсутствие строки значит «в этот день не заполняли»,
      -- и это не то же самое, что 0.
      fill       REAL NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (date, shop_code)
    );

    -- Комментарий к лавке за день: «не привезли ягоды», «витрину чинили».
    -- Живёт отдельно от наполнения: заметку можно оставить и без процента.
    CREATE TABLE IF NOT EXISTS showcase_note (
      date       TEXT NOT NULL,
      shop_code  TEXT NOT NULL,
      note       TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (date, shop_code)
    );

    -- Когда день трогали последний раз — для вкладки «История».
    CREATE TABLE IF NOT EXISTS showcase_day (
      date       TEXT PRIMARY KEY,
      updated_at TEXT NOT NULL
    );

    -- Журнал загрузок для вкладки «История»: что и когда залили кнопкой.
    CREATE TABLE IF NOT EXISTS uploads (
      id            INTEGER PRIMARY KEY AUTOINCREMENT,
      at            TEXT NOT NULL,
      original_name TEXT NOT NULL,
      file_name     TEXT NOT NULL,
      kind          TEXT NOT NULL,
      summary       TEXT NOT NULL,
      -- JSON-массив дат, за которые файл принёс данные.
      dates         TEXT NOT NULL,
      "rows"        INTEGER NOT NULL,
      mode          TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS uploads_at ON uploads (at DESC);

    -- История «какой РМ отвечал за лавку» — см. roster-history.ts.
    -- to_date IS NULL значит «период ещё действует».
    CREATE TABLE IF NOT EXISTS region_periods (
      id         INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_code  TEXT NOT NULL,
      manager    TEXT NOT NULL,
      from_date  TEXT NOT NULL,
      to_date    TEXT,
      source     TEXT NOT NULL
    );

    CREATE INDEX IF NOT EXISTS region_periods_shop ON region_periods (shop_code, from_date);

    -- Разовые отметки: например, что сид из репозитория уже залит.
    CREATE TABLE IF NOT EXISTS meta (
      key   TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
}

export function getMeta(db: BetterSqlite3.Database, key: string): string | null {
  const row = db.prepare(`SELECT value FROM meta WHERE key = ?`).get(key) as
    | { value: string }
    | undefined;
  return row?.value ?? null;
}

export function setMeta(db: BetterSqlite3.Database, key: string, value: string): void {
  db.prepare(
    `INSERT INTO meta (key, value) VALUES (?, ?)
     ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, value);
}
