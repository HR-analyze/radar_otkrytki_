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

test('комментарий сохраняется отдельно от процента и не трогает его', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-08', shopCode: 'М1', fill: 0.8 }]);
  await store.saveShowcaseEdits([{ date: '2026-09-08', shopCode: 'М1', note: 'не привезли ягоды' }]);

  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-08']['М1'], 0.8, 'процент пережил правку комментария');
  assert.equal(read.notes['2026-09-08']['М1'], 'не привезли ягоды');
});

test('комментарий можно оставить и там, где процента нет', async () => {
  // Лавку не заполнили, но объяснить причину нужно — это разные поля.
  await store.saveShowcaseEdits([{ date: '2026-09-09', shopCode: 'М5', note: 'лавка закрыта' }]);

  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-09']?.['М5'], undefined, 'процента нет');
  assert.equal(read.notes['2026-09-09']['М5'], 'лавка закрыта');
});

test('пустой комментарий стирает пометку, а процент остаётся', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-10', shopCode: 'М2', fill: 0.9, note: 'чинили' }]);
  const cleared = await store.saveShowcaseEdits([
    { date: '2026-09-10', shopCode: 'М2', note: '' },
  ]);

  assert.equal(cleared.changed, 1);
  const read = await store.readShowcase();
  assert.equal(read.notes['2026-09-10']?.['М2'], undefined, 'пометка стёрта');
  assert.equal(read.days['2026-09-10']['М2'], 0.9, 'процент на месте');
});

test('правка процента не стирает уже написанный комментарий', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-11', shopCode: 'М3', note: 'витрину меняли' }]);
  await store.saveShowcaseEdits([{ date: '2026-09-11', shopCode: 'М3', fill: 0.55 }]);

  const read = await store.readShowcase();
  assert.equal(read.notes['2026-09-11']['М3'], 'витрину меняли');
  assert.equal(read.days['2026-09-11']['М3'], 0.55);
});

test('комментарии попадают в резервную копию — иначе их негде хранить', async () => {
  const file = store.writeSeed(await store.readShowcase());
  const back = JSON.parse(fs.readFileSync(file, 'utf8')) as {
    notes: Record<string, Record<string, string>>;
  };

  assert.equal(back.notes['2026-09-08']['М1'], 'не привезли ягоды');
  assert.equal(store.readSeed().notes['2026-09-09']['М5'], 'лавка закрыта');
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

test('итог дня — среднее двух замеров, пустой замер в него не входит', () => {
  assert.equal(store.dayFill(1, 0.5), 0.75, 'утром 100%, в 16:00 50% — итог 75%');
  assert.equal(store.dayFill(0.6, 0.9), 0.75, 'порядок замеров не важен');
  assert.equal(store.dayFill(0.9, null), 0.9, 'в 16:00 не мерили — итог по утру, не половина');
  assert.equal(store.dayFill(null, 0.8), 0.8, 'утром не мерили — итог по 16:00');
  assert.equal(store.dayFill(null, null), null);
});

test('итог дня округляется до целого процента, половинка — вверх', () => {
  // Пороги целые: 94,5% с жёлтым статусом показывались бы как «95%».
  assert.equal(store.dayFill(0.95, 0.94), 0.95, '94,5% → 95%, хотя в долях это 0.9449999…');
  assert.equal(store.dayFill(0.95, 0.5), 0.73, '72,5% → 73%');
  assert.equal(store.dayFill(0.33, 0.34), 0.34);
  assert.equal(store.dayFill(0.85, 0.84), 0.85, '84,5% → 85%: граница жёлтого включительно');
  assert.equal(store.dayFill(0, 0), 0);
  assert.equal(store.dayFill(1, 1), 1);
});

test('замер в 16:00 хранится отдельно и не трогает утренний', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-12', shopCode: 'М1', fill: 1 }]);
  const saved = await store.saveShowcaseEdits([
    { date: '2026-09-12', shopCode: 'М1', afternoonFill: 0.5 },
  ]);
  assert.equal(saved.changed, 1);

  const read = await store.readShowcase();
  assert.equal(read.days['2026-09-12']['М1'], 1, 'утренний замер на месте');
  assert.equal(read.afternoon['2026-09-12']['М1'], 0.5);

  // Стирание 16:00 тоже не задевает утро.
  await store.saveShowcaseEdits([{ date: '2026-09-12', shopCode: 'М1', afternoonFill: null }]);
  const after = await store.readShowcase();
  assert.equal(after.afternoon['2026-09-12']?.['М1'], undefined);
  assert.equal(after.days['2026-09-12']['М1'], 1);
});

test('правка 16:00 пишется в журнал отдельным полем', async () => {
  const { readShowcaseAudit } = await import('./showcase-audit');
  await store.saveShowcaseEdits([{ date: '2026-09-13', shopCode: 'М4', afternoonFill: 0.7 }]);

  const entries = await readShowcaseAudit({ date: '2026-09-13', shopCode: 'М4' });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].field, 'fill_afternoon');
  assert.equal(entries[0].from, null);
  assert.equal(entries[0].to, '0.7');
});

test('радар красится по среднему замеров, сами замеры лежат рядом', async () => {
  await store.saveShowcaseEdits([
    { date: '2026-09-14', shopCode: 'М1', fill: 1, afternoonFill: 0.5 },
    // Только 16:00 — лавка всё равно в итоге дня.
    { date: '2026-09-14', shopCode: 'М2', afternoonFill: 0.97 },
  ]);

  const { showcase, criteria } = store.showcaseRowsFromStore(await store.readShowcase());
  const m1 = showcase.find((s) => s.date === '2026-09-14' && s.shopCode === 'М1')!;
  assert.equal(m1.fill, 0.75);
  assert.equal(m1.status, 'red', 'среднее 75% — ниже жёлтого порога');
  assert.equal(m1.morning, 1);
  assert.equal(m1.afternoon, 0.5);
  assert.equal(
    criteria.find((c) => c.date === '2026-09-14' && c.shopCode === 'М1')?.status,
    'red',
    'критерий «витрина» — тоже по итогу',
  );

  const m2 = showcase.find((s) => s.date === '2026-09-14' && s.shopCode === 'М2')!;
  assert.equal(m2.fill, 0.97);
  assert.equal(m2.morning, null);
});

test('замер 16:00 попадает в резервную копию и возвращается из неё', async () => {
  await store.saveShowcaseEdits([{ date: '2026-09-15', shopCode: 'М3', afternoonFill: 0.88 }]);
  store.writeSeed(await store.readShowcase());

  assert.equal(store.readSeed().afternoon['2026-09-15']['М3'], 0.88);
  assert.ok(store.readSeed().touched['2026-09-15'], 'день с одним лишь 16:00 не теряет отметку');
});

test('версия витрин меняется и от правки 16:00', async () => {
  const before = await store.showcaseVersion();
  await store.saveShowcaseEdits([{ date: '2026-09-16', shopCode: 'М9', afternoonFill: 0.42 }]);
  assert.notEqual(before, await store.showcaseVersion());
});

test('в закоммиченном сиде репозитория лежит вся история витрин', () => {
  // Сид — резервная копия истории: если он потеряется, свежая установка
  // поднимется с пустыми витринами. Порог не равенство, а «не меньше»:
  // история только растёт, и каждая выгрузка базы не должна ронять тест.
  const seed = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'fixtures', 'showcase.json'), 'utf8'),
  ) as { days: Record<string, Record<string, number>> };
  const values = Object.values(seed.days).reduce((n, d) => n + Object.keys(d).length, 0);

  assert.ok(values >= 596, `значений в сиде ${values}, а было 596 — история не должна убывать`);
  assert.ok(
    Object.values(seed.days).every((day) => Object.values(day).every((v) => v >= 0 && v <= 1)),
    'наполнение хранится долей 0–1',
  );
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));

test('среднее замеров — одна формула у сервера и у превью в редакторе', async () => {
  const { averagePercent } = await import('./day-fill');
  // Превью в браузере считает в процентах, сервер — в долях; ответ один.
  for (const [m, a] of [[95, 94], [95, 50], [33, 34], [85, 84], [100, 0], [29, 58]]) {
    assert.equal(store.dayFill(m / 100, a / 100), averagePercent(m, a) / 100, `${m}% и ${a}%`);
  }
});
