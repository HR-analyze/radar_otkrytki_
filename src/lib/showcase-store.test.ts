import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from './config';

/**
 * Витрины живут в базе `data/manual.db`, поэтому тесты поднимают свою базу во
 * временной папке: переменные окружения выставляются до первого импорта модуля.
 */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-manual-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'seed.json');

fs.writeFileSync(
  process.env.RADAR_SHOWCASE_PATH,
  JSON.stringify({
    updatedAt: '2026-09-01T00:00:00.000Z',
    touched: { '2026-08-31': '2026-09-01T00:00:00.000Z' },
    days: { '2026-08-31': { М1: 1, М2: 0.9 } },
  }),
);

// Импорт откладывается до before: наверху файла await не поддерживается
// транспайлером тестов, а модуль должен подняться уже с этими переменными.
let store: typeof import('./showcase-store');
before(async () => {
  store = await import('./showcase-store');
});

test('база наполняется из закоммиченного сида один раз', async () => {
  const read = await store.readShowcase();

  assert.equal(read.source, 'db', 'читаем из базы, а не из файла');
  assert.deepEqual(read.days['2026-08-31'], { М1: 1, М2: 0.9 });
});

test('правка проставляет значение, повтор того же — ничего не меняет', async () => {
  const first = await store.saveShowcaseEdits([
    { date: '2026-09-03', shopCode: 'М1', fill: 0.95 },
  ]);
  assert.equal(first.changed, 1);

  const again = await store.saveShowcaseEdits([
    { date: '2026-09-03', shopCode: 'М1', fill: 0.95 },
  ]);
  assert.equal(again.changed, 0, 'то же значение — не правка');

  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-03']['М1'], 0.95);
  assert.ok(read.touched['2026-09-03'], 'день помечен временем правки');
});

test('пустое значение стирает день у лавки, а не записывает ноль', async () => {
  // «Не заполняли» и «заполнили на 0%» — разные вещи: первое в средние не входит.
  await store.saveShowcaseEdits([{ date: '2026-09-04', shopCode: 'М7', fill: 0.8 }]);
  const cleared = await store.saveShowcaseEdits([
    { date: '2026-09-04', shopCode: 'М7', fill: null },
  ]);

  assert.equal(cleared.changed, 1);
  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-04']?.['М7'], undefined);
});

test('стёртое значение не возвращается из сида при следующем чтении', async () => {
  // Ровно этого ждёшь от базы: она главнее файла, из которого её наполнили.
  await store.saveShowcaseEdits([{ date: '2026-08-31', shopCode: 'М2', fill: null }]);

  const read = await store.readShowcase();
  assert.equal(read.days['2026-08-31']?.['М2'], undefined, 'сид не воскрешает стёртое');
  assert.equal(read.days['2026-08-31']?.['М1'], 1, 'остальное на месте');
});

test('проценты и доли приводятся к одному виду и округляются', async () => {
  await store.saveShowcaseEdits([
    { date: '2026-09-05', shopCode: 'М1', fill: 0.955 },
    { date: '2026-09-05', shopCode: 'М2', fill: 87 }, // пришло процентами
    { date: '2026-09-05', shopCode: 'М3', fill: 0.999 },
  ]);

  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-05']['М1'], 0.96);
  assert.equal(read.days['2026-09-05']['М2'], 0.87);
  assert.equal(read.days['2026-09-05']['М3'], 1);
});

test('статусы считаются по действующим порогам, критерий помечен как ручной', async () => {
  const config = loadConfig();
  await store.saveShowcaseEdits([
    { date: '2026-09-06', shopCode: 'М1', fill: 0.97 },
    { date: '2026-09-06', shopCode: 'М2', fill: 0.9 },
    { date: '2026-09-06', shopCode: 'М3', fill: 0.5 },
  ]);

  const { showcase, criteria } = store.showcaseRowsFromStore(await store.readShowcase());
  const day = showcase.filter((s) => s.date === '2026-09-06');
  assert.deepEqual(
    day.map((s) => s.status),
    ['green', 'yellow', 'red'],
    `пороги: 🟢 ${config.criteria.showcase.kind === 'percent' ? config.criteria.showcase.greenFrom : '?'}`,
  );
  assert.ok(criteria.every((c) => c.criterion === 'showcase' && c.origin === 'manual'));
});

test('версия витрин меняется от правки — снимок узнаёт о ней сразу', async () => {
  const before = await store.showcaseVersion();
  await store.saveShowcaseEdits([{ date: '2026-09-07', shopCode: 'М9', fill: 0.42 }]);
  const after = await store.showcaseVersion();

  assert.notEqual(before, after);
});

test('экспорт в файл-сид отсортирован и читается обратно', async () => {
  const file = store.writeSeed(await store.readShowcase());
  assert.equal(file, process.env.RADAR_SHOWCASE_PATH);

  const back = store.readSeed();
  assert.deepEqual(Object.keys(back.days), Object.keys(back.days).sort(), 'дни по возрастанию');
  assert.equal(back.days['2026-09-05']['М1'], 0.96);
});

test('в закоммиченном сиде репозитория те же 457 значений', () => {
  // Сид — резервная копия истории: если он потеряется, свежая установка
  // поднимется с пустыми витринами.
  const seed = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'fixtures', 'showcase.json'), 'utf8'),
  ) as { days: Record<string, Record<string, number>> };
  const values = Object.values(seed.days).reduce((n, d) => n + Object.keys(d).length, 0);

  assert.equal(values, 457);
  assert.ok(
    Object.values(seed.days).every((day) => Object.values(day).every((v) => v >= 0 && v <= 1)),
    'наполнение хранится долей 0–1',
  );
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
