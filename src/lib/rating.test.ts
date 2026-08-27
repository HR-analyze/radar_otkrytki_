import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';
import { rateShopDay, type RatedPerson } from './rating';
import type { Status } from './types';

const config = loadConfig();

const person = (criterion: RatedPerson['criterion'], status: Status): RatedPerson => ({
  criterion,
  status,
});

test('баллы сотрудников делятся на людей: пример заказчика 9 / 5 = 1,8 → 🔴', () => {
  // Пять сотрудников: 🟢 + 🟡 + 🔴 + 🟡 + 🔴 = 3+2+1+2+1 = 9.
  const people = [
    person('cook', 'green'),
    person('cook', 'yellow'),
    person('cook', 'red'),
    person('cashier', 'yellow'),
    person('barista', 'red'),
  ];

  const staff = rateShopDay(people, null, config).components.find((c) => c.key === 'staff')!;
  assert.equal(staff.score, 1.8);
  assert.equal(staff.status, 'red');
  assert.equal(staff.count, 5);
});

test('итог лавки = (водитель + сотрудники + витрина) ÷ 3', () => {
  const people = [
    person('driver', 'green'),
    person('cook', 'green'),
    person('cook', 'yellow'),
    person('cook', 'red'),
    person('cashier', 'yellow'),
    person('barista', 'red'),
  ];

  const r = rateShopDay(people, 'green', config);
  // (3 + 1,8 + 3) / 3 = 2,6 — верхняя граница жёлтой зоны.
  assert.equal(r.score, 2.6);
  assert.equal(r.status, 'yellow');
  assert.deepEqual(
    r.components.map((c) => [c.key, c.score]),
    [
      ['driver', 3],
      ['staff', 1.8],
      ['showcase', 3],
    ],
  );
});

test('три повара весят втрое: усредняем по людям, а не по должностям', () => {
  const people = [
    person('cook', 'red'),
    person('cook', 'red'),
    person('cook', 'red'),
    person('cashier', 'green'),
  ];

  const staff = rateShopDay(people, null, config).components.find((c) => c.key === 'staff')!;
  // По людям: (1+1+1+3)/4 = 1,5 🔴. По должностям было бы (1+3)/2 = 2 🟡.
  assert.equal(staff.score, 1.5);
  assert.equal(staff.status, 'red');
});

test('слагаемое без данных не делает лавку красной — делим на то, что есть', () => {
  const r = rateShopDay([person('driver', 'green'), person('cook', 'green')], null, config);
  assert.equal(r.score, 3, 'витрины за день нет — среднее только по двум слагаемым');
  assert.equal(r.status, 'green');
  assert.equal(r.components.find((c) => c.key === 'showcase')?.score, null);
});

test('«другой график» не влияет на балл, но и не обнуляет день', () => {
  const withOther = rateShopDay(
    [person('cook', 'green'), person('cook', 'other_schedule')],
    null,
    config,
  );
  const without = rateShopDay([person('cook', 'green')], null, config);
  assert.equal(withOther.score, without.score);
  assert.equal(withOther.components.find((c) => c.key === 'staff')?.count, 1);
});

test('ни одной оценки за день → нет данных, а не 🔴', () => {
  const r = rateShopDay([], null, config);
  assert.equal(r.status, 'no_data');
  assert.equal(r.score, null);
});
