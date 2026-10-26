import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseStaffing, parseWindow } from './staffing';
import { findStaffNorm, slotLabel, slotShortLabel, staffAt, parseTimeOfDay } from '../staffing';

const HEADER = [
  'Лавка', 'ТО план', 'Грейд', 'Кофемашина',
  'Кассир\r\n6.5-7,5', 'Кассир\r\n7,5-11', 'Кассир\r\n11-16', 'Кассир\r\nFTE', 'ЧЕЛ-КО часы',
  'Повар\r\nдо 8', 'Повар\r\n8-11', 'Повар\r\n11-16', 'Повар\r\nFTE', 'ЧЕЛ-КО часы',
  'Бариста\r\nдо 8', 'Бариста\r\n8-11', 'Бариста\r\n11-16', 'Бариста\r\nFTE', 'ЧЕЛ-КО часы',
  'Уборщик\r\nдо 8', 'Уборщик\r\n8-11', 'Уборщик\r\n11-16', 'Уборщик\r\nFTE', 'ЧЕЛ-КО часы',
];

/** Шаблон как в жизни: лавки, потом служебная строка с длиной окон в часах. */
function book(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Шаблон по часам-пикам');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const M1 = ['М01 Милютинский', 12812500, '10-14 млн', 'Нет', 2, 2, 3, 6, 1054, 2, 3, 3, 3, 806, 0, 0, 0, 0, 0, 1, 2, 2, 3, 651];
const M73 = ['М 73 Зиларт', 13530000, '10-14 млн', null, 2, 2, 3, 6, 1054, 2, 2, 2, 2, 620, 1, 1, 1, 2, 0, 1, 1, 2, 2, 527];
const DURATIONS = [null, null, null, null, 1, 3.5, 5, 9.5, null, 1.5, 3, 5, 9.5, null, 1.5, 3, 5, 9.5, null, 1, 3, 5, 9, null];

test('окна из заголовков: точка и запятая в часах, «до N»', () => {
  assert.deepEqual(parseWindow('6.5-7,5'), { from: 390, to: 450 });
  assert.deepEqual(parseWindow('17,5-21'), { from: 1050, to: 1260 });
  assert.deepEqual(parseWindow('до 8'), { from: null, to: 480 });
  assert.deepEqual(parseWindow('6:30 – 7:30'), { from: 390, to: 450 });
  assert.equal(parseWindow('FTE'), null);
  assert.equal(parseWindow('16-11'), null, 'конец раньше начала — не окно');
});

test('шаблон: лавки, грейд, кофемашина; план товарооборота не берётся', () => {
  const { norms, warnings } = parseStaffing(book([M1, M73, DURATIONS]));

  assert.deepEqual(warnings, []);
  assert.deepEqual(norms.map((n) => [n.code, n.name]), [['М1', 'Милютинский'], ['М73', 'Зиларт']]);
  assert.equal(norms[0].grade, '10-14 млн');
  assert.equal(norms[0].coffeeMachine, false);
  assert.equal(norms[1].coffeeMachine, null, 'пустая клетка — не «нет»');
  assert.ok(!JSON.stringify(norms).includes('12812500'), 'ТО план утёк в нормы');

  const cashier = norms[0].roles.cashier;
  assert.deepEqual(cashier.slots.map((s) => s.count), [2, 2, 3]);
  assert.equal(cashier.fte, 6);
  assert.equal(cashier.hours, 1054, '«ЧЕЛ-КО часы» относятся к должности слева');
});

test('начало окна «до 8» берётся из строки с длиной окон', () => {
  const { norms } = parseStaffing(book([M1, DURATIONS]));
  assert.equal(norms[0].roles.cook.slots[0].from, 390, 'у повара «до 8» — полтора часа, с 06:30');
  assert.equal(norms[0].roles.cleaner.slots[0].from, 420, 'у уборщика — час, с 07:00');

  // Без служебной строки начала не выдумываем.
  const bare = parseStaffing(book([M1]));
  assert.equal(bare.norms[0].roles.cook.slots[0].from, null);
  assert.ok(bare.warnings.some((w) => w.includes('с начала смены')));
});

test('калькулятор: 14:00 в М1 — окно 11–16 у каждой должности', () => {
  const [m1] = parseStaffing(book([M1, DURATIONS])).norms;
  const at = staffAt(m1, parseTimeOfDay('14:00')!);

  assert.deepEqual(
    at.map((a) => [a.role, a.count]),
    [['cashier', 3], ['cook', 3], ['barista', 0], ['cleaner', 2]],
  );
  assert.equal(slotLabel(at[0].slot!), '11:00–16:00');
  assert.equal(slotShortLabel(m1.roles.cashier.slots[0]), '6:30–7:30');
  assert.equal(slotShortLabel(m1.roles.cashier.slots[2]), '11–16');
});

test('калькулятор: граница окна — уже следующее окно, вне смены — никого', () => {
  const [m1] = parseStaffing(book([M1, DURATIONS])).norms;

  const at11 = staffAt(m1, 11 * 60);
  assert.equal(at11.find((a) => a.role === 'cook')?.slot?.from, 660, 'в 11:00 действует окно 11–16');

  const early = staffAt(m1, 6 * 60);
  assert.ok(early.every((a) => a.count === 0 && a.slot === null), 'в 06:00 по шаблону ещё никого');

  const late = staffAt(m1, 23 * 60);
  assert.ok(late.every((a) => a.count === 0), 'после конца последнего окна — никого');
});

test('время и лавка из адреса', () => {
  assert.equal(parseTimeOfDay('7:05'), 425);
  assert.equal(parseTimeOfDay('24:00'), null);
  assert.equal(parseTimeOfDay('мусор'), null);

  const { norms } = parseStaffing(book([M1, M73, DURATIONS]));
  assert.equal(findStaffNorm(norms, 'м01')?.code, 'М1');
  assert.equal(findStaffNorm(norms, 'M73')?.code, 'М73', 'латинская M из раскладки');
  assert.equal(findStaffNorm(norms, 'зилар')?.code, 'М73');
  assert.equal(findStaffNorm(norms, ''), null);
});
