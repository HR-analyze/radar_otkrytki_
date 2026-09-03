import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * База ручных данных и журнал загрузок. Переменные окружения выставляются до
 * первого импорта модулей, поэтому импорт отложен до before.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-manual-db-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_UPLOAD_LOG_PATH = path.join(dir, 'upload-log.json');

fs.writeFileSync(
  process.env.RADAR_UPLOAD_LOG_PATH,
  JSON.stringify({
    entries: [
      {
        at: '2026-09-01T08:00:00.000Z',
        originalName: 'старое.xls',
        fileName: '2026-08-31_vyhody.xls',
        kind: 'attendance',
        summary: 'Выгрузка отметок',
        dates: ['2026-08-31'],
        rows: 120,
        mode: 'disk',
      },
    ],
  }),
);

let log: typeof import('./upload-log');
let db: typeof import('./manual-db');

before(async () => {
  log = await import('./upload-log');
  db = await import('./manual-db');
});

test('ручные данные лежат вне git — иначе их снова затрёт деплой', () => {
  // Ровно так пропали витрины за 03.09.2026: файл с ними был закоммичен,
  // и `git pull` на сервере вернул его к версии из репозитория.
  const was = process.env.RADAR_MANUAL_DB_PATH;
  delete process.env.RADAR_MANUAL_DB_PATH;
  const file = db.manualDbPath();
  process.env.RADAR_MANUAL_DB_PATH = was;

  assert.equal(file, path.join(process.cwd(), 'data', 'manual.db'));
  assert.ok(isGitIgnored(file), `${file} должен игнорироваться git`);
});

/** `git check-ignore` выходит с кодом 1, когда путь НЕ игнорируется. */
function isGitIgnored(file: string): boolean {
  try {
    execFileSync('git', ['check-ignore', '-q', file], { cwd: process.cwd(), stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

test('журнал загрузок пишется в базу и читается свежими записями вперёд', async () => {
  await log.appendUploadLog([
    {
      at: '2026-09-04T10:00:00.000Z',
      originalName: 'выходы 04.09.xls',
      fileName: '2026-09-04_vyhody.xls',
      kind: 'attendance',
      summary: 'Выгрузка отметок за 04.09',
      dates: ['2026-09-04'],
      rows: 310,
      mode: 'disk',
    },
  ]);

  const entries = await log.readUploadLog();
  assert.equal(entries[0].fileName, '2026-09-04_vyhody.xls', 'сверху последняя загрузка');
  assert.deepEqual(entries[0].dates, ['2026-09-04'], 'даты переживают запись в базу');
  assert.equal(entries[0].rows, 310);
});

test('старый файл-журнал переносится в базу один раз, а не дублируется', async () => {
  const first = await log.readUploadLog();
  const old = first.filter((e) => e.originalName === 'старое.xls');
  assert.equal(old.length, 1, 'запись из файла перенеслась');

  await log.appendUploadLog([
    {
      at: '2026-09-05T10:00:00.000Z',
      originalName: 'ещё одна.xls',
      fileName: '2026-09-05_vyhody.xls',
      kind: 'attendance',
      summary: 'Выгрузка отметок за 05.09',
      dates: ['2026-09-05'],
      rows: 300,
      mode: 'disk',
    },
  ]);

  const again = await log.readUploadLog();
  assert.equal(
    again.filter((e) => e.originalName === 'старое.xls').length,
    1,
    'повторный импорт файла удвоил бы историю',
  );
  assert.equal(again.length, first.length + 1);
});

test('без диска база не открывается, а код не падает', async () => {
  // На Vercel диска нет: витрины и журнал там только для чтения.
  const was = process.env.VERCEL;
  process.env.VERCEL = '1';
  try {
    assert.equal(db.manualDbWritable(), false);
  } finally {
    if (was == null) delete process.env.VERCEL;
    else process.env.VERCEL = was;
  }
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
