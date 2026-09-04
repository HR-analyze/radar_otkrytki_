import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Тесты читают снимок из репозитория, а не локальную SQLite: результат
// не должен зависеть от того, запускали ли на этой машине `npm run seed`.
process.env.RADAR_STORAGE = 'snapshot';

// То же и с витринами: база ручных данных поднимается пустой во временной
// папке и наполняется из закоммиченного сида. Рабочую data/manual.db тесты
// не трогают — там живые правки, и цифры в них меняются каждый день.
process.env.RADAR_MANUAL_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'radar-queries-')),
  'manual.db',
);

// Импорт отложен до установки переменной: queries тянет snapshot.ts,
// который выбирает источник при первом обращении.
type Queries = typeof import('./queries');
let q: Queries;

// Границы периода берём из самих данных: дни добавляются, зашивать их нельзя.
let ALL: { from: string; to: string };

before(async () => {
  q = await import('./queries');
  const dates = await q.listDates();
  ALL = { from: dates[0], to: dates[dates.length - 1] };
});

test('в снимке есть непрерывный ряд дней', async () => {
  const dates = await q.listDates();
  assert.ok(dates.length >= 7, `дней всего ${dates.length}`);
  assert.deepEqual([...dates].sort(), dates, 'даты должны быть отсортированы');
});

test('виджеты меняются при смене дня — иначе смена даты ни на что не влияет', async () => {
  // Берём три разнесённых дня из имеющихся, а не зашитые даты.
  const all = await q.listDates();
  const days = [all[0], all[Math.floor(all.length / 2)], all[all.length - 1]];
  const totals = await Promise.all(days.map((d) => q.shopTotals(d, d)));
  const drivers = await Promise.all(
    days.map(async (d) => (await q.summaryByCriterion(d, d)).find((x) => x.criterion === 'driver')!),
  );

  const asKey = (t: Awaited<ReturnType<typeof q.shopTotals>>) => `${t.green}/${t.yellow}/${t.red}`;
  assert.equal(new Set(totals.map(asKey)).size, days.length, 'счётчики лавок совпали у разных дней');

  const driverKey = new Set(drivers.map((d) => `${d.green}/${d.yellow}/${d.red}`));
  assert.equal(driverKey.size, days.length, 'счётчики по водителю совпали у разных дней');
});

test('за один день счётчики — точные, не усреднённые', async () => {
  const day = '2026-08-25';
  const t = await q.shopTotals(day, day);
  assert.equal(t.days, 1);
  assert.equal(t.green + t.yellow + t.red, 80, 'все 80 лавок распределены по статусам');
  assert.equal(t.total, 80);
});

test('за период счётчики усреднены по дням и не вырождаются в «все красные»', async () => {
  const period = await q.shopTotals(ALL.from, ALL.to);
  assert.equal(period.days, (await q.listDates()).length);
  assert.ok(
    period.green + period.yellow + period.red <= period.total,
    'среднее за день не может превышать число лавок',
  );

  // Среднее обязано лежать между минимумом и максимумом посуточных значений.
  const daily = await Promise.all(
    (await q.listDates()).map((d) => q.shopTotals(d, d)),
  );
  const reds = daily.map((d) => d.red);
  assert.ok(
    period.red >= Math.min(...reds) && period.red <= Math.max(...reds),
    `среднее ${period.red} вне диапазона посуточных [${Math.min(...reds)}, ${Math.max(...reds)}]`,
  );
});

test('фильтр по РМ сужает выборку и счётчики', async () => {
  // Имя не зашиваем: РМ приходят из справочника лавок и меняются вместе с ним.
  const regions = await q.listRegions('2026-08-25', '2026-08-25');
  assert.ok(regions.current.length > 0, 'у лавок проставлены РМ');

  const all = await q.shopTotals('2026-08-25', '2026-08-25');
  const one = await q.shopTotals('2026-08-25', '2026-08-25', regions.current[0]);
  assert.ok(
    one.total > 0 && one.total < all.total,
    `${regions.current[0]}: ${one.total} из ${all.total}`,
  );
  assert.ok(one.red <= all.red);
  assert.ok(one.green + one.yellow + one.red <= one.total);
});

test('список РМ зависит от периода: справочник обновляют каждый месяц', async () => {
  // Выбрали август — видно менеджеров августа, включая ушедших. Выбрали
  // сентябрь — только нынешний состав. Иначе сравнить показатели прошлого
  // РМ с показателями преемника было бы не с кем.
  const august = await q.listRegions('2026-08-19', '2026-08-31');
  const september = await q.listRegions('2026-09-01', '2026-09-03');

  assert.ok(august.past.length > 0, 'в августе были РМ, которых сейчас нет');
  assert.equal(september.past.length, 0, 'в сентябре ушедших быть не должно');
  assert.ok(
    august.current.length + august.past.length > september.current.length,
    'в августе менеджеров больше, чем в сентябре',
  );

  // Период через стык месяцев собирает и тех, и других.
  const both = await q.listRegions('2026-08-25', '2026-09-03');
  for (const name of [...august.past, ...september.current]) {
    assert.ok(
      both.current.includes(name) || both.past.includes(name),
      `${name} потерялся в периоде через стык месяцев`,
    );
  }
});

test('по ушедшему РМ видны его прежние лавки, а после смены — уже нет', async () => {
  const august = await q.listRegions('2026-08-19', '2026-08-31');
  const gone = august.past[0];

  const before = await q.radar({ from: '2026-08-19', to: '2026-08-31', region: gone });
  assert.ok(before.rows.length > 0, `${gone}: за август лавок не нашлось`);

  const after = await q.radar({ from: '2026-09-01', to: '2026-09-03', region: gone });
  assert.equal(after.rows.length, 0, `${gone}: после смены справочника лавок быть не должно`);
});

test('топ считает долю зелёных, а не их число', async () => {
  // По абсолютному счёту наверх лезли лавки покрупнее с посредственными 70%,
  // обгоняя тех, у кого 92%: у лавок разное число оценённых ячеек.
  const best = await q.bestShops(ALL.from, ALL.to, 12);
  assert.ok(best.length > 0);

  const shares = best.map((b) => b.share);
  assert.deepEqual(shares, [...shares].sort((a, b) => b - a), 'отсортировано по доле');

  for (const b of best) {
    assert.ok(b.total > 0, `${b.shop.code}: знаменатель должен быть больше нуля`);
    assert.equal(b.share, b.greenCount / b.total, 'доля должна сходиться со счётчиками');
    assert.ok(b.greenCount <= b.total);
  }

  // Лавка с максимальным числом зелёных не обязана быть первой — и это суть.
  const byCount = [...best].sort((a, b) => b.greenCount - a.greenCount);
  assert.ok(byCount[0].share <= best[0].share, 'первое место — за долей, не за счётом');
});

test('лавки без достаточных данных в топ не попадают', async () => {
  // «1 из 1 = 100%» — не достижение: порог отсекает такие строки.
  const best = await q.bestShops(ALL.from, ALL.to, 80);
  const totals = best.map((b) => b.total);
  const min = Math.min(...totals);
  const median = [...totals].sort((a, b) => a - b)[Math.floor(totals.length / 2)];

  assert.ok(min >= median / 2, `минимум ${min} должен быть не меньше половины медианы ${median}`);
});

test('топ и анти-топ смотрят на одни данные с разных сторон', async () => {
  const best = await q.bestShops(ALL.from, ALL.to, 5);
  const worst = await q.antiTop(ALL.from, ALL.to, 5);

  const bestCodes = new Set(best.map((b) => b.shop.code));
  const worstCodes = new Set(worst.map((w) => w.shop.code));
  const both = [...bestCodes].filter((c) => worstCodes.has(c));

  assert.deepEqual(both, [], `лавка не может быть и в топе, и в анти-топе: ${both.join(', ')}`);
});

test('топ уважает фильтр по РМ', async () => {
  const regions = await q.listRegions(ALL.from, ALL.to);
  const region = regions.current[0];

  const all = await q.bestShops(ALL.from, ALL.to, 80);
  const one = await q.bestShops(ALL.from, ALL.to, 80, region);

  assert.ok(one.length > 0 && one.length < all.length, `${region}: ${one.length} из ${all.length}`);
});

test('сводка комментариев собирает их за период и сортирует свежими вверх', async () => {
  const { saveShowcaseEdits } = await import('./showcase-store');
  await saveShowcaseEdits([
    { date: '2026-08-25', shopCode: 'М1', note: 'не привезли ягоды' },
    { date: '2026-08-27', shopCode: 'М2', note: 'витрину чинили' },
    { date: '2026-08-27', shopCode: 'М1', note: 'поставка опоздала' },
    // За границей периода — в сводку попасть не должен.
    { date: '2026-07-01', shopCode: 'М3', note: 'прошлый месяц' },
  ]);

  const notes = await q.showcaseNotes('2026-08-01', '2026-08-31');

  assert.deepEqual(
    notes.map((n) => `${n.date} ${n.shopCode}`),
    ['2026-08-27 М1', '2026-08-27 М2', '2026-08-25 М1'],
    'свежее сверху, внутри дня — по номеру лавки',
  );
  assert.ok(!notes.some((n) => n.date < '2026-08-01'), 'чужой месяц не попал');
  assert.equal(notes[0].shopName, 'М1 Милютинский', 'название лавки подставлено');
  assert.ok(notes[0].region, 'РМ проставлен');
});

test('в сводке рядом с комментарием видно наполнение того же дня', async () => {
  const { saveShowcaseEdits } = await import('./showcase-store');
  await saveShowcaseEdits([{ date: '2026-08-26', shopCode: 'М4', fill: 0.6, note: 'мало выпечки' }]);

  const notes = await q.showcaseNotes('2026-08-26', '2026-08-26');
  const m4 = notes.find((n) => n.shopCode === 'М4');

  assert.equal(m4?.percent, 60, 'процент за тот же день подставлен');
  assert.equal(m4?.note, 'мало выпечки');
});

test('пустой комментарий в сводку не попадает', async () => {
  const { saveShowcaseEdits } = await import('./showcase-store');
  await saveShowcaseEdits([{ date: '2026-08-28', shopCode: 'М6', note: 'ошибся' }]);
  await saveShowcaseEdits([{ date: '2026-08-28', shopCode: 'М6', note: '' }]);

  const notes = await q.showcaseNotes('2026-08-28', '2026-08-28');
  assert.ok(!notes.some((n) => n.shopCode === 'М6'), 'стёртая пометка не показывается');
});

test('фильтр по лавке: точный код важнее подстроки', async () => {
  // «М1» — это ровно М1. Иначе, набрав код односимвольной лавки, человек
  // получал бы М1 вместе с М10–М19 и не мог посмотреть её одну.
  const exact = await q.radar({ from: ALL.from, to: ALL.to, shop: 'М1' });
  assert.deepEqual(exact.rows.map((r) => r.shop.code), ['М1']);

  // Часть названия ищет по названию.
  const byName = await q.radar({ from: ALL.from, to: ALL.to, shop: 'Покровка' });
  assert.deepEqual(byName.rows.map((r) => r.shop.code), ['М2']);

  // Часть слова, встречающаяся у нескольких лавок, отбирает их все.
  const group = await q.radar({ from: ALL.from, to: ALL.to, shop: 'ская' });
  assert.ok(group.rows.length > 1, `по «ская» нашлось ${group.rows.length}`);
  assert.ok(group.rows.every((r) => /ская/i.test(r.shop.name)));

  const nothing = await q.radar({ from: ALL.from, to: ALL.to, shop: 'такой лавки нет' });
  assert.deepEqual(nothing.rows, []);
});

test('фильтр по лавке складывается с фильтром по РМ', async () => {
  // Проверяем через пересечение, а не через r.shop.region: РМ теперь
  // историчен, и лавка может попасть в выборку по периоду, который уже
  // закрыт, — тогда её текущий region не совпадёт с именем фильтра.
  const regions = await q.listRegions(ALL.from, ALL.to);
  const region = regions.current[0];

  const byRegion = await q.radar({ from: ALL.from, to: ALL.to, region });
  const byShop = await q.radar({ from: ALL.from, to: ALL.to, shop: 'М' });
  const both = await q.radar({ from: ALL.from, to: ALL.to, region, shop: 'М' });

  assert.ok(both.rows.length > 0);
  const byRegionCodes = new Set(byRegion.rows.map((r) => r.shop.code));
  const byShopCodes = new Set(byShop.rows.map((r) => r.shop.code));
  assert.ok(
    both.rows.every((r) => byRegionCodes.has(r.shop.code) && byShopCodes.has(r.shop.code)),
    'фильтр по РМ или по лавке потерялся при их сочетании',
  );
});

test('сумма по критерию не превышает числа лавок под фильтром', async () => {
  for (const range of [['2026-08-25', '2026-08-25'], [ALL.from, ALL.to]] as const) {
    for (const s of await q.summaryByCriterion(range[0], range[1])) {
      assert.ok(
        s.green + s.yellow + s.red + s.missing === 80,
        `${s.criterion}: ${s.green}+${s.yellow}+${s.red}+${s.missing} ≠ 80`,
      );
    }
  }
});

test('наполнение витрины считается за весь период, а не за один день', async () => {
  const day = await q.showcaseStats('2026-08-25', '2026-08-25');
  const period = await q.showcaseStats(ALL.from, ALL.to);
  assert.ok(period.filled >= 1);
  assert.notEqual(day.avg, period.avg, 'среднее за день и за неделю не должно совпадать');
  for (const s of [day, period]) {
    if (s.avg != null) assert.ok(s.avg >= 0 && s.avg <= 1);
  }
});

test('произвольный период отдаёт только свои дни', async () => {
  const { dates } = await q.radar({ from: '2026-08-21', to: '2026-08-23' });
  assert.deepEqual(dates, ['2026-08-21', '2026-08-22', '2026-08-23']);
});

test('период без данных не ломает выдачу', async () => {
  const { dates, rows } = await q.radar({ from: '2026-07-01', to: '2026-07-15' });
  assert.deepEqual(dates, []);
  assert.deepEqual(rows, []);

  const t = await q.shopTotals('2026-07-01', '2026-07-15');
  assert.deepEqual([t.green, t.yellow, t.red, t.days], [0, 0, 0, 0]);

  const fill = await q.showcaseStats('2026-07-01', '2026-07-15');
  assert.equal(fill.avg, null);
});
