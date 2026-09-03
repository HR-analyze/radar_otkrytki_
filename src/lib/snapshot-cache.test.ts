import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Отдельный файл, потому что путь к снимку читается при первом импорте модуля:
 * переменные окружения надо выставить до него, а импорт сделать динамическим.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-snap-'));
const file = path.join(dir, 'snapshot.json');

function writeSnapshot(dates: readonly string[]): void {
  fs.writeFileSync(
    file,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'json',
      configFingerprint: 'test',
      fixturesFingerprint: dates.join(','),
      shops: [{ code: 'М1', name: 'М1 Милютинский', region: null }],
      attendance: [],
      showcase: [],
      criteria: dates.map((date) => ({
        date,
        shopCode: 'М1',
        criterion: 'cook',
        status: 'green',
        score: 3,
        origin: 'computed',
      })),
      legacyPeople: [],
      runs: [],
    }),
  );
}

test('свежий снимок на диске виден без перезапуска приложения', async () => {
  // Так ломалась загрузка с дашборда: страницы и API-роуты Next собирает в
  // разные бандлы, и сброс кеша в роуте страница не видела — файл на диске уже
  // новый, а на экране прежние цифры.
  process.env.RADAR_STORAGE = 'snapshot';
  process.env.RADAR_SNAPSHOT_PATH = file;
  // Витрины подмешиваются в снимок из своего файла — в этом тесте он не нужен.
  process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');
  writeSnapshot(['2026-08-30']);

  const { loadSnapshot } = await import('./snapshot');

  const before = await loadSnapshot();
  assert.deepEqual(before.criteria.map((c) => c.date), ['2026-08-30']);

  // Загрузка файла кнопкой пересобирает снимок — вот она.
  writeSnapshot(['2026-08-30', '2026-08-31']);

  const after = await loadSnapshot();
  assert.deepEqual(
    after.criteria.map((c) => c.date),
    ['2026-08-30', '2026-08-31'],
    'страница обязана увидеть новый день без перезапуска',
  );

  fs.rmSync(dir, { recursive: true, force: true });
});
