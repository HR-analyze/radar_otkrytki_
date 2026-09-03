import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';
import {
  applyEdits,
  readShowcaseStore,
  showcaseRowsFromStore,
  writeShowcaseStore,
  type ShowcaseStore,
} from './showcase-store';

const empty: ShowcaseStore = { days: {}, touched: {}, updatedAt: null };

test('правка проставляет значение, повтор того же — ничего не меняет', () => {
  const first = applyEdits(empty, [{ date: '2026-09-01', shopCode: 'М1', fill: 0.95 }]);
  assert.equal(first.changed, 1);
  assert.equal(first.store.days['2026-09-01']['М1'], 0.95);
  assert.ok(first.store.touched['2026-09-01'], 'день помечен временем правки');

  const again = applyEdits(first.store, [{ date: '2026-09-01', shopCode: 'М1', fill: 0.95 }]);
  assert.equal(again.changed, 0, 'то же значение — не правка');
});

test('пустое значение стирает день у лавки, а не записывает ноль', () => {
  // «Не заполняли» и «заполнили на 0%» — разные вещи: первое в средние не входит.
  const filled = applyEdits(empty, [{ date: '2026-09-01', shopCode: 'М1', fill: 0.8 }]).store;
  const cleared = applyEdits(filled, [{ date: '2026-09-01', shopCode: 'М1', fill: null }]);

  assert.equal(cleared.changed, 1);
  assert.equal(cleared.store.days['2026-09-01']['М1'], undefined);
});

test('проценты и доли приводятся к одному виду и округляются', () => {
  const store = applyEdits(empty, [
    { date: '2026-09-01', shopCode: 'М1', fill: 0.955 },
    { date: '2026-09-01', shopCode: 'М2', fill: 87 }, // пришло процентами
    { date: '2026-09-01', shopCode: 'М3', fill: 0.999 },
  ]).store;

  // В файле хранится доля с точностью до процента: 0.9500000000000001 не нужен.
  assert.equal(store.days['2026-09-01']['М1'], 0.96);
  assert.equal(store.days['2026-09-01']['М2'], 0.87);
  assert.equal(store.days['2026-09-01']['М3'], 1);
});

test('статусы считаются по действующим порогам, критерий помечен как ручной', () => {
  const config = loadConfig();
  const store = applyEdits(empty, [
    { date: '2026-09-01', shopCode: 'М1', fill: 0.97 },
    { date: '2026-09-01', shopCode: 'М2', fill: 0.9 },
    { date: '2026-09-01', shopCode: 'М3', fill: 0.5 },
  ]).store;

  const { showcase, criteria } = showcaseRowsFromStore(store);
  assert.deepEqual(
    showcase.map((s) => s.status),
    ['green', 'yellow', 'red'],
    `пороги: 🟢 ${config.criteria.showcase.kind === 'percent' ? config.criteria.showcase.greenFrom : '?'}`,
  );
  assert.ok(criteria.every((c) => c.criterion === 'showcase' && c.origin === 'manual'));
});

test('файл переживает перезапись и остаётся отсортированным', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-showcase-'));
  const before = process.env.RADAR_SHOWCASE_PATH;
  process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');

  try {
    const store = applyEdits(empty, [
      { date: '2026-09-02', shopCode: 'М2', fill: 0.9 },
      { date: '2026-09-01', shopCode: 'М10', fill: 0.8 },
      { date: '2026-09-01', shopCode: 'М1', fill: 0.7 },
    ]).store;
    writeShowcaseStore(store);

    const read = readShowcaseStore();
    assert.deepEqual(Object.keys(read.days), ['2026-09-01', '2026-09-02'], 'дни по возрастанию');
    assert.deepEqual(Object.keys(read.days['2026-09-01']), ['М1', 'М10'], 'лавки отсортированы');
    assert.equal(read.days['2026-09-01']['М1'], 0.7);
  } finally {
    if (before === undefined) delete process.env.RADAR_SHOWCASE_PATH;
    else process.env.RADAR_SHOWCASE_PATH = before;
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('в перенесённых из книги витринах те же 457 значений', () => {
  // Перенос разовый: если файл потеряется, дашборд молча останется без витрин.
  const store = readShowcaseStore();
  const values = Object.values(store.days).reduce((n, d) => n + Object.keys(d).length, 0);

  assert.equal(values, 457);
  assert.ok(
    Object.values(store.days).every((day) =>
      Object.values(day).every((v) => v >= 0 && v <= 1),
    ),
    'наполнение хранится долей 0–1',
  );
});
