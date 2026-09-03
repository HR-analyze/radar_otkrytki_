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
