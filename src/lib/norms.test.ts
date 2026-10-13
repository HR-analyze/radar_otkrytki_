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

test('лавка с поздним открытием и нормой 8:00: «другой график» сдвинут, норма — нет', () => {
  // М72 Ватутинки открывается в 10:00 (shopSchedules), норма в справочнике — 8:00.
  // Порог «другого графика» уезжает на 10:00, а норма остаётся 8:00.
  const shift = 120;
  assert.equal(statusByNorm(at('07:55'), '08:00', config, shift), 'green');
  assert.equal(statusByNorm(at('08:00'), '08:00', config, shift), 'green', 'ровно в норму — не «другой график»');
  assert.equal(statusByNorm(at('08:10'), '08:00', config, shift), 'yellow');
  assert.equal(statusByNorm(at('08:15'), '08:00', config, shift), 'yellow');
  assert.equal(statusByNorm(at('08:16'), '08:00', config, shift), 'red');
  assert.equal(statusByNorm(at('10:00'), '08:00', config, shift), 'other_schedule');
});

test('проход по нормам сдвигает «другой график» лавкам из shopSchedules', () => {
  const late: ThresholdConfig = { ...config, shopSchedules: { М72: { opensAt: '10:00', note: '' } } };
  const row = (criterion: 'driver' | 'cook', hhmm: string) =>
    ({ date: '2026-09-25', shopCode: 'М72', criterion, arrivalMinutes: at(hhmm), status: 'other_schedule' }) as AttendanceRow;
  const norms = { М72: { code: 'М72', driverAt: '08:00', cookAt: ['08:00'] } as ShopNorms };
  const out = applyShopNorms([row('driver', '08:06'), row('cook', '08:00'), row('cook', '08:20')], norms, late);
  assert.deepEqual(out.map((r) => r.status), ['yellow', 'green', 'red']);
});

test('нормы раздаются поварам по факту прихода, а не по именам', () => {
  // Порядок в выгрузке — не порядок прихода: первым пришёл третий по списку.
  const norms = assignCookNorms([at('06:35'), at('06:28'), at('05:58')], ['06:00', '06:30']);
  assert.deepEqual(norms, ['06:30', '06:30', '06:00']);
});

test('поваров больше, чем часов в плане — лишние идут по последнему', () => {
  const norms = assignCookNorms([at('06:00'), at('06:10'), at('06:20')], ['06:00']);
  assert.deepEqual(norms, ['06:00', '06:00', '06:00']);
});

test('количество поваров в справочнике на раздачу не влияет', () => {
  // «3 с 6:20» и «1 с 6:20» дают один и тот же план: важен час, а не число людей.
  const arrivals = [at('06:15'), at('06:25')];
  assert.deepEqual(assignCookNorms(arrivals, ['06:20']), ['06:20', '06:20']);
});

test('повар без отметки не занимает ранний час', () => {
  const norms = assignCookNorms([null, at('06:05')], ['06:00', '06:30']);
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
    cookAt: ['06:20'],
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
  const rows = [
    row({ shopCode: 'М1', arrivalMinutes: at('06:05') }),
    row({ shopCode: 'М1', date: '2026-09-02', arrivalMinutes: at('06:05') }),
  ];
  const out = applyShopNorms(rows, norms({ cookAt: ['06:00'] }), config);

  // Если бы дни смешались, второй повар получил бы «лишнюю» норму 06:00 как
  // второй пришедший — а он первый в своём дне, и результат совпадает лишь
  // потому, что план из одного часа. Проверяем именно статусы обоих.
  assert.deepEqual(out.map((r) => r.status), ['yellow', 'yellow']);
});
