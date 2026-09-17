import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-contest-penalties-'));
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_SNAPSHOT_PATH = path.join(dir, 'snapshot.json');
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');

fs.writeFileSync(process.env.RADAR_SNAPSHOT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(), source: 'json',
  configFingerprint: 'test', fixturesFingerprint: 'test',
  shops: [
    { code: 'М25', name: 'М25 Мясницкая', region: 'Новый РМ' },
    { code: 'М1', name: 'М1 Тестовая', region: 'Другой РМ' },
  ],
  regionHistory: [
    { shopCode: 'М25', manager: 'Лясецкая Юлия', from: '2026-09-01', to: '2026-09-15' },
    { shopCode: 'М25', manager: 'Новый РМ', from: '2026-09-16', to: null },
    { shopCode: 'М1', manager: 'Другой РМ', from: '2026-09-01', to: null },
  ],
  attendance: [], showcase: [], criteria: [], legacyPeople: [], runs: [], departures: [],
}));
fs.writeFileSync(process.env.RADAR_SHOWCASE_PATH, JSON.stringify({
  days: {
    '2026-09-14': { М25: 1, М1: 1 },
    '2026-09-15': { М25: 1, М1: 1 },
    '2026-09-16': { М25: 1, М1: 1 },
  },
}));

test('М25: постоянный −1 один раз за период, РМ и сеть не штрафуются дважды', async () => {
  const { contest } = await import('./queries');
  const result = await contest({ from: '2026-09-14', to: '2026-09-15' });
  const row = result.rows.find((r) => r.shop.code === 'М25')!;
  assert.equal(row.score.points, 1, 'два зелёных дня минус один постоянный штраф');
  assert.equal(row.score.rated, 2);
  assert.equal(row.score.green, 2, 'штраф не перекрашивает дни');
  assert.equal(result.regions.find((r) => r.region === 'Лясецкая Юлия')!.score.points, 1);
  assert.equal(result.total.points, 3, 'четыре зелёных дня минус один штраф');
  assert.equal(result.rows[0].shop.code, 'М1', 'штраф влияет на место');
});

test('постоянный штраф сохраняется при смене дня и без витрин', async () => {
  const { contest } = await import('./queries');
  for (const date of ['2026-09-14', '2026-09-15', '2026-10-01']) {
    const result = await contest({ from: date, to: date, shop: 'М25' });
    assert.equal(result.rows.length, 1);
    assert.equal(result.total.points, date === '2026-10-01' ? -1 : 0);
  }
});

test('штраф закреплён за прежним РМ и уважает фильтры', async () => {
  const { contest } = await import('./queries');
  const filters = { from: '2026-09-16', to: '2026-09-16' };
  const old = await contest({ ...filters, region: 'Лясецкая Юлия' });
  assert.equal(old.total.points, -1, 'штраф остаётся у ответственного РМ');
  assert.deepEqual(old.regions.map((r) => r.region), ['Лясецкая Юлия']);
  const next = await contest({ ...filters, region: 'Новый РМ' });
  assert.equal(next.total.points, 1, 'новому РМ чужой штраф не переносится');
  assert.equal((await contest({ ...filters, shop: 'М1' })).total.points, 1);
  assert.equal((await contest({ ...filters, shop: 'несуществующая' })).rows.length, 0);
});

test('штраф конкурса не меняет радар', async () => {
  const { radar } = await import('./queries');
  const result = await radar({ from: '2026-09-14', to: '2026-09-14', shop: 'М25', criterion: 'showcase' });
  assert.equal(result.rows[0].cells['2026-09-14'].status, 'green');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
