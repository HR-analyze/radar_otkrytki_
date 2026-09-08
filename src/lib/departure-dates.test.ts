import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * День, за который приехала только выгрузка по РЦ.
 *
 * Так бывает каждое утро: файл выездов заливают сразу, а отметки по лавкам —
 * позже. Пока днями радара считались только дни со статусами лавок, такой
 * день не попадал ни в период по умолчанию, ни в подсветку календаря: файл
 * загружен, в «Истории» виден, а на сводке выездов нет — выглядит потерянным.
 *
 * Отдельный файл, потому что путь к снимку читается при первом импорте
 * модуля: снимок под тест пишется синтетический.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-dep-dates-'));
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_SNAPSHOT_PATH = path.join(dir, 'snapshot.json');
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');

fs.writeFileSync(
  process.env.RADAR_SNAPSHOT_PATH,
  JSON.stringify({
    generatedAt: new Date().toISOString(),
    source: 'json',
    configFingerprint: 'test',
    fixturesFingerprint: 'test',
    shops: [{ code: 'М17', name: 'Тестовая', region: 'РМ' }],
    attendance: [],
    showcase: [],
    // Статусы лавок есть по 07.09 — как если бы отметки за 08.09 ещё не залили.
    criteria: [
      { date: '2026-09-05', shopCode: 'М17', criterion: 'driver', status: 'green', note: null },
      { date: '2026-09-07', shopCode: 'М17', criterion: 'driver', status: 'green', note: null },
    ],
    legacyPeople: [],
    runs: [],
    regionHistory: [],
    departures: [
      {
        date: '2026-09-08',
        employeeName: 'Иванов Иван Иванович',
        unit: 'РЦ Свобода',
        role: 'Водитель-экспедитор',
        arrivalMinutes: 202,
        departureMinutes: 257,
        rawDeparture: '08.09.2026 4:17:06',
      },
    ],
  }),
);

test('день только с выездами тоже считается днём с данными', async () => {
  const { listDates } = await import('./queries');
  assert.deepEqual(await listDates(), ['2026-09-05', '2026-09-07', '2026-09-08']);
});

test('период по умолчанию дотягивается до дня, за который есть только выезды', async () => {
  const { listDates } = await import('./queries');
  const { defaultRange } = await import('./params');

  const range = defaultRange(await listDates(), '2026-09-08');
  assert.deepEqual(range, { from: '2026-09-05', to: '2026-09-08' });

  const { departureSummary } = await import('./queries');
  const summary = await departureSummary(range.from, range.to);
  assert.equal(summary?.days.length, 1, 'выезды за 08.09 должны попасть в сводку');
  assert.equal(summary?.days[0].date, '2026-09-08');

  fs.rmSync(dir, { recursive: true, force: true });
});
