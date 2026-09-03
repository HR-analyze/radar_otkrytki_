import fs from 'node:fs';
import path from 'node:path';
import { fixturesDir } from './upload-store';

/**
 * Журнал загрузок: что и когда попало в радар.
 *
 * Файлы в `fixtures/` показывают только текущее состояние — по ним не видно,
 * когда выгрузку залили и что радар в ней тогда понял. Для человека, который
 * ведёт данные, это первый вопрос при разборе «почему цифры такие»: журнал
 * отвечает на него, не заглядывая в git.
 *
 * Лежит рядом с самими файлами и коммитится вместе с ними — как и всё
 * остальное, что радар считает данными.
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

export function uploadLogPath(): string {
  return process.env.RADAR_UPLOAD_LOG_PATH ?? path.join(fixturesDir(), 'upload-log.json');
}

export function readUploadLog(): UploadLogEntry[] {
  try {
    const raw = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ uploadLogPath(), 'utf8'),
    ) as { entries?: UploadLogEntry[] };
    return Array.isArray(raw.entries) ? raw.entries : [];
  } catch {
    return [];
  }
}

/** Дописывает записи в начало журнала. Не роняет загрузку, если не вышло. */
export function appendUploadLog(entries: readonly UploadLogEntry[]): void {
  if (entries.length === 0) return;

  try {
    const all = [...entries, ...readUploadLog()].slice(0, LIMIT);
    const file = uploadLogPath();
    fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });
    fs.writeFileSync(
      /* turbopackIgnore: true */ file,
      JSON.stringify(
        {
          $comment: 'Журнал загрузок радара. Пишется автоматически, вкладка «История».',
          entries: all,
        },
        null,
        2,
      ) + '\n',
    );
  } catch {
    // Журнал — удобство, а не данные: его отказ не должен ронять загрузку файла.
  }
}
