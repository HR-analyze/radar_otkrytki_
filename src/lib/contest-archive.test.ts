import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { contestArchiveDays, parseContestArchive } from './contest-archive';

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-contest-archive-'));
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_SNAPSHOT_PATH = path.join(dir, 'snapshot.json');
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');

fs.writeFileSync(process.env.RADAR_SNAPSHOT_PATH, JSON.stringify({
  generatedAt: new Date().toISOString(), source: 'json',
  configFingerprint: 'test', fixturesFingerprint: 'test',
  shops: [
    { code: 'М1', name: 'М1 Милютинский', region: 'Осин Анатолий' },
    { code: 'М65', name: 'М65 Пятницкая', region: 'Осин Анатолий' },
  ],
  regionHistory: [],
  attendance: [], showcase: [], criteria: [], legacyPeople: [], runs: [], departures: [],
}));
// В архиве у М1: 14.09 красный, 15.09 и 16.09 жёлтые. В базе 14.09 — 100%,
// 15.09 — только замер в 16:00, которого конкурс не видит.
fs.writeFileSync(process.env.RADAR_SHOWCASE_PATH, JSON.stringify({
  days: { '2026-09-14': { М1: 1 } },
  afternoon: { '2026-09-15': { М1: 1 } },
}));

test('архив совпадает с PDF-отчётом за 14.09–29.09', () => {
  const days = contestArchiveDays();
  const shops = new Set(days.map((d) => d.shopCode));
  assert.equal(shops.size, 81);
  assert.equal(new Set(days.map((d) => d.date)).size, 16);

  const count = (code: string) => {
    const own = days.filter((d) => d.shopCode === code);
    return [own.filter((d) => d.status === 'red').length, own.filter((d) => d.status === 'yellow').length, own.filter((d) => d.status === 'green').length];
  };
  assert.deepEqual(count('М65'), [9, 6, 1]);
  assert.deepEqual(count('М16'), [1, 0, 11], 'четыре дня у Сити витрину не заполняли');
  assert.deepEqual(count('М3'), [0, 0, 16]);

  // +939 у сети в отчёте — это витрины минус три нарушения М25.
  const points = days.reduce((sum, d) => sum + (d.status === 'green' ? 1 : d.status === 'red' ? -1 : 0), 0);
  assert.equal(points, 942);
});

test('битая строка архива — ошибка, а не тихий сдвиг цветов', () => {
  const report = (days: string, fill = 0.9) => ({
    reports: [{ file: 'x.pdf', dates: ['2026-09-14', '2026-09-15'], shops: { М1: { fill, days } } }],
  });
  assert.equal(parseContestArchive(report('g-')).length, 1);
  assert.throws(() => parseContestArchive(report('g')), /1 дней вместо 2/);
  assert.throws(() => parseContestArchive(report('gx')), /непонятный день/);
  assert.throws(() => parseContestArchive(report('gg', 1.2)), /вне 0–1/);
  const twice = report('gg');
  twice.reports.push(twice.reports[0]);
  assert.throws(() => parseContestArchive(twice), /встречается дважды/);
});

test('конкурс: утренний замер из базы важнее архива, архив закрывает пустые дни', async () => {
  const { contest } = await import('./queries');
  const result = await contest({ from: '2026-09-14', to: '2026-09-16', shop: 'М1' });
  const row = result.rows.find((r) => r.shop.code === 'М1')!;

  assert.deepEqual(row.cells['2026-09-14'], { status: 'green', fill: 1, points: 1 }, 'замер из базы, не красный из архива');
  assert.deepEqual(row.cells['2026-09-15'], { status: 'yellow', fill: 0.94, points: 0, archived: true });
  assert.deepEqual(row.cells['2026-09-16'], { status: 'yellow', fill: 0.94, points: 0, archived: true });
  assert.equal(row.score.points, 1);
  assert.deepEqual(result.archive, { from: '2026-09-15', to: '2026-09-16' });
});

test('конкурс за период отчёта повторяет строку PDF', async () => {
  const { contest } = await import('./queries');
  const result = await contest({ from: '2026-09-14', to: '2026-09-29', shop: 'М65' });
  const row = result.rows.find((r) => r.shop.code === 'М65')!;
  assert.deepEqual([row.score.red, row.score.yellow, row.score.green], [9, 6, 1]);
  assert.equal(row.score.points, -8);
  assert.equal(Math.round(row.avgFill! * 100), 66);
});

test('вне периода архива его нет', async () => {
  const { contest } = await import('./queries');
  const result = await contest({ from: '2026-10-01', to: '2026-10-05' });
  assert.equal(result.archive, null);
  assert.equal(result.rows.length, 0);
});
