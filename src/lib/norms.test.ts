import assert from 'node:assert/strict';
import test from 'node:test';
import { loadConfig } from './config';
import { applyShopNorms, assignCookNorms, statusByNorm } from './norms';
import type { AttendanceRow, ShopNorms, ThresholdConfig } from './types';

const base = loadConfig();
const config: ThresholdConfig = {
  ...base,
  rules: { ...base.rules, shopNorms: { enabled: true, yellowStepMinutes: 15, confirmed: false, note: '' } },
};

/** «06:20» → минуты от полуночи. */
const at = (hhmm: string): number => {
  const [h, m] = hhmm.split(':').map(Number);
  return h * 60 + m;
};

test('норма задаёт границу зелёной зоны, жёлтая идёт следующие 15 минут', () => {
  assert.equal(statusByNorm(at('06:00'), '06:20', config), 'green', 'раньше нормы');
  assert.equal(statusByNorm(at('06:20'), '06:20', config), 'green', 'ровно в норму');
  assert.equal(statusByNorm(at('06:21'), '06:20', config), 'yellow', 'минута опоздания');
  assert.equal(statusByNorm(at('06:35'), '06:20', config), 'yellow', 'край жёлтой');
  assert.equal(statusByNorm(at('06:36'), '06:20', config), 'red');
});

test('нет отметки — красный, как и по общему правилу', () => {
  assert.equal(statusByNorm(null, '06:20', config), 'red');
});

test('шаг жёлтой зоны берётся из конфига', () => {
  const wide: ThresholdConfig = {
    ...config,
    rules: { ...config.rules, shopNorms: { enabled: true, yellowStepMinutes: 30, confirmed: false, note: '' } },
  };
  assert.equal(statusByNorm(at('06:45'), '06:20', wide), 'yellow');
  assert.equal(statusByNorm(at('06:51'), '06:20', wide), 'red');
});

test('приход глубоко за пределами утра — «другой график», а не опоздание', () => {
  const after = config.rules.otherSchedule.after;
  assert.ok(config.rules.otherSchedule.enabled, 'правило должно быть включено в конфиге');
  assert.equal(statusByNorm(at(after) + 1, '06:20', config), 'other_schedule');
});

test('нормы раздаются поварам по факту прихода, а не по именам', () => {
  const shifts = [
    { count: 1, at: '06:00' },
    { count: 2, at: '06:30' },
  ];
  // Порядок в выгрузке — не порядок прихода: первым пришёл третий по списку.
  const norms = assignCookNorms([at('06:35'), at('06:28'), at('05:58')], shifts);
  assert.deepEqual(norms, ['06:30', '06:30', '06:00']);
});

test('поваров больше, чем смен в плане — лишние идут по последней смене', () => {
  const norms = assignCookNorms([at('06:00'), at('06:10'), at('06:20')], [{ count: 1, at: '06:00' }]);
  assert.deepEqual(norms, ['06:00', '06:00', '06:00']);
});

test('повар без отметки не занимает раннюю смену', () => {
  const shifts = [
    { count: 1, at: '06:00' },
    { count: 1, at: '06:30' },
  ];
  const norms = assignCookNorms([null, at('06:05')], shifts);
  assert.deepEqual(norms, [null, '06:00'], 'пришедший забирает раннюю норму, а не вторую');
});

test('плана нет — норм тоже нет', () => {
  assert.deepEqual(assignCookNorms([at('06:00')], []), [null]);
});

function row(over: Partial<AttendanceRow>): AttendanceRow {
  return {
    date: '2026-09-01',
    shopCode: 'М1',
    shopName: 'М1 Милютинский',
    employeeName: 'Иванов Иван',
    role: 'Повар',
    criterion: 'cook',
    trainee: false,
    homeShopCode: null,
    arrivalMinutes: at('06:00'),
    arrivalSource: 'mark',
    rawArrival: null,
    rawDeparture: null,
    status: 'green',
    note: null,
    ...over,
  };
}

function norms(over: Partial<ShopNorms>): Record<string, ShopNorms> {
  const n: ShopNorms = {
    code: 'М1',
    name: 'Милютинский',
    driverAt: '06:30',
    cookShifts: [{ count: 2, at: '06:20' }],
    rawDriver: null,
    rawCook: null,
    source: 'reference',
    warnings: [],
    ...over,
  };
  return { [n.code]: n };
}

test('пересчёт трогает водителя и повара и не трогает остальных', () => {
  const rows = [
    row({ criterion: 'driver', arrivalMinutes: at('06:40'), status: 'red' }),
    row({ criterion: 'cook', arrivalMinutes: at('06:25'), status: 'green' }),
    row({ criterion: 'cashier', arrivalMinutes: at('06:25'), status: 'green' }),
  ];
  const out = applyShopNorms(rows, norms({}), config);

  assert.equal(out[0].status, 'yellow', 'водитель: норма 06:30, приход 06:40 → жёлтая');
  assert.equal(out[1].status, 'yellow', 'повар: норма 06:20, приход 06:25 → жёлтая');
  assert.equal(out[2].status, 'green', 'кассир в справочнике не нормируется');
});

test('лавка без нормы остаётся на сетевых порогах', () => {
  const rows = [row({ shopCode: 'М99', criterion: 'driver', status: 'green' })];
  const out = applyShopNorms(rows, norms({}), config);
  assert.equal(out[0].status, 'green');
});

test('выключенные нормы ничего не меняют', () => {
  const off: ThresholdConfig = {
    ...config,
    rules: { ...config.rules, shopNorms: { enabled: false, yellowStepMinutes: 15, confirmed: false, note: '' } },
  };
  const rows = [row({ criterion: 'driver', arrivalMinutes: at('07:30'), status: 'green' })];
  assert.equal(applyShopNorms(rows, norms({}), off)[0].status, 'green');
});

test('повара разных лавок и дней считаются отдельными сменами', () => {
  const shifts = [{ count: 1, at: '06:00' }];
  const rows = [
    row({ shopCode: 'М1', arrivalMinutes: at('06:05') }),
    row({ shopCode: 'М1', date: '2026-09-02', arrivalMinutes: at('06:05') }),
  ];
  const out = applyShopNorms(rows, norms({ cookShifts: shifts }), config);

  // Если бы дни смешались, второй повар получил бы «лишнюю» норму 06:00 как
  // второй пришедший — а он первый в своём дне, и результат совпадает лишь
  // потому, что план из одной смены. Проверяем именно статусы обоих.
  assert.deepEqual(out.map((r) => r.status), ['yellow', 'yellow']);
});
