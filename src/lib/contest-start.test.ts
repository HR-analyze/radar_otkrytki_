import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Нижняя граница периода на вкладке конкурса.
 *
 * Конкурс объявили 14.09.2026, дни до старта лавкам не засчитываются — и на
 * вкладке их не должно быть ни в баллах, ни в календаре, ни по прямой ссылке
 * с `from` до старта. Радар при этом продолжает показывать историю целиком,
 * поэтому граница живёт в параметрах страницы, а не в запросах.
 *
 * Отдельный файл, потому что путь к снимку читается при первом импорте
 * модуля: снимок под тест пишется синтетический.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-contest-start-'));
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_SNAPSHOT_PATH = path.join(dir, 'snapshot.json');
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');

const day = (date: string) => ({
  date,
  shopCode: 'М17',
  criterion: 'showcase',
  status: 'green',
  note: null,
});

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
    // Дни по обе стороны старта конкурса.
    criteria: ['2026-09-11', '2026-09-13', '2026-09-14', '2026-09-15'].map(day),
    legacyPeople: [],
    runs: [],
    regionHistory: [],
    departures: [],
  }),
);

test('дни до старта конкурса не попадают ни в календарь, ни в период', async () => {
  const { resolveParams } = await import('./params');
  const { CONTEST_START } = await import('./contest');

  const p = await resolveParams({}, { minDate: CONTEST_START });

  assert.deepEqual(p.dates, ['2026-09-14', '2026-09-15'], 'с 1 по 13 сентября — не конкурс');
  assert.equal(p.from, '2026-09-14');
  assert.equal(p.to, '2026-09-15');
});

test('ссылка с датой до старта подтягивается к первому дню конкурса', async () => {
  const { resolveParams } = await import('./params');
  const { CONTEST_START } = await import('./contest');

  const p = await resolveParams(
    { from: '2026-09-01', to: '2026-09-15' },
    { minDate: CONTEST_START },
  );

  assert.equal(p.from, '2026-09-14', 'сентябрь до 14-го в конкурс не входит');
  assert.equal(p.to, '2026-09-15');
});

test('период целиком до старта схлопывается в первый день конкурса', async () => {
  // Иначе вкладка показала бы «за период витрины не заполняли» по дням,
  // которых в конкурсе нет вовсе.
  const { resolveParams } = await import('./params');
  const { CONTEST_START } = await import('./contest');

  const p = await resolveParams(
    { from: '2026-09-01', to: '2026-09-13' },
    { minDate: CONTEST_START },
  );

  assert.deepEqual({ from: p.from, to: p.to }, { from: CONTEST_START, to: CONTEST_START });
});

test('без нижней границы страница по-прежнему видит всю историю', async () => {
  // Радар и история конкурсом не ограничены — ограничение включает страница.
  const { resolveParams } = await import('./params');

  const p = await resolveParams({ from: '2026-09-01', to: '2026-09-15' });

  assert.equal(p.from, '2026-09-01');
  assert.deepEqual(p.dates, ['2026-09-11', '2026-09-13', '2026-09-14', '2026-09-15']);

  fs.rmSync(dir, { recursive: true, force: true });
});
