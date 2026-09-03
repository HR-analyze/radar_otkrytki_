import fs from 'node:fs';
import path from 'node:path';
import { getMeta, openManualDb, setMeta } from './manual-db';
import { fixturesDir } from './upload-store';

/**
 * Журнал загрузок: что и когда попало в радар.
 *
 * Файлы в `fixtures/` показывают только текущее состояние — по ним не видно,
 * когда выгрузку залили и что радар в ней тогда понял. Для человека, который
 * ведёт данные, это первый вопрос при разборе «почему цифры такие»: журнал
 * отвечает на него, не заглядывая в git.
 *
 * Живёт в базе ручных данных `data/manual.db` — вне git. Раньше это был файл
 * `fixtures/upload-log.json` внутри репозитория, и деплой затирал его ровно
 * так же, как затёр наполнение витрин за 03.09.2026. Старый файл, если он
 * остался на сервере, переносится в базу один раз при первом чтении.
 */

export interface UploadLogEntry {
  /** Когда загрузили, ISO. */
  at: string;
  /** Имя файла, каким его дал человек. */
  originalName: string;
  /** Под каким именем файл лёг в fixtures/. */
  fileName: string;
  kind: string;
  /** Строка распознавания — та же, что человек видел в панели загрузки. */
  summary: string;
  dates: string[];
  rows: number;
  /** disk — на диск, github — коммитом в репозиторий. */
  mode: string;
}

const LIMIT = 500;

/** Файл старого журнала: читается один раз, чтобы перенести историю в базу. */
export function legacyUploadLogPath(): string {
  return process.env.RADAR_UPLOAD_LOG_PATH ?? path.join(fixturesDir(), 'upload-log.json');
}

export async function readUploadLog(): Promise<UploadLogEntry[]> {
  const db = await openManualDb();
  if (!db) return readLegacyFile().slice(0, LIMIT);

  importLegacyOnce(db);

  const rows = db
    .prepare(
      `SELECT at, original_name, file_name, kind, summary, dates, "rows", mode
       FROM uploads ORDER BY at DESC, id DESC LIMIT ?`,
    )
    .all(LIMIT) as Record<string, unknown>[];

  return rows.map(toEntry);
}

/** Дописывает записи в журнал. Не роняет загрузку, если не вышло. */
export async function appendUploadLog(entries: readonly UploadLogEntry[]): Promise<void> {
  if (entries.length === 0) return;

  try {
    const db = await openManualDb();
    if (!db) return;

    importLegacyOnce(db);
    insert(db, entries);
  } catch {
    // Журнал — удобство, а не данные: его отказ не должен ронять загрузку файла.
  }
}

type ManualDb = NonNullable<Awaited<ReturnType<typeof openManualDb>>>;

function insert(db: ManualDb, entries: readonly UploadLogEntry[]): void {
  const put = db.prepare(
    `INSERT INTO uploads (at, original_name, file_name, kind, summary, dates, "rows", mode)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );

  db.transaction(() => {
    for (const e of entries) {
      put.run(
        e.at,
        e.originalName,
        e.fileName,
        e.kind,
        e.summary,
        JSON.stringify(e.dates ?? []),
        e.rows,
        e.mode,
      );
    }
  })();
}

/**
 * Разовый перенос старого файла-журнала в базу: на сервере он уже наполнен
 * настоящими временами загрузок, и терять их незачем.
 */
function importLegacyOnce(db: ManualDb): void {
  if (getMeta(db, 'uploads_imported')) return;

  const old = readLegacyFile();
  if (old.length > 0) insert(db, [...old].reverse());
  setMeta(db, 'uploads_imported', new Date().toISOString());
}

function readLegacyFile(): UploadLogEntry[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ legacyUploadLogPath(), 'utf8'),
    ) as { entries?: UploadLogEntry[] };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

function toEntry(r: Record<string, unknown>): UploadLogEntry {
  let dates: string[] = [];
  try {
    const parsed = JSON.parse(String(r.dates ?? '[]')) as unknown;
    if (Array.isArray(parsed)) dates = parsed.map(String);
  } catch {
    // Строка в колонке не разобралась — журнал показываем без дат.
  }

  return {
    at: r.at as string,
    originalName: r.original_name as string,
    fileName: r.file_name as string,
    kind: r.kind as string,
    summary: r.summary as string,
    dates,
    rows: (r.rows as number) ?? 0,
    mode: r.mode as string,
  };
}
