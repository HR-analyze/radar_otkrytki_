import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { readStaffing } from './staffing-store';
import { STAFF_ROLES } from './staffing';
import { STAFFING_XLSX_SHEETS, staffingXlsx } from './staffing-xlsx';

const seed = readStaffing();
const book = (shown = seed.norms) =>
  staffingXlsx({ shown, source: seed.source, builtAt: seed.builtAt, generatedAt: new Date('2026-10-28T08:00:00Z') });

function rows(file: Buffer, sheet: string): unknown[][] {
  const wb = XLSX.read(file, { type: 'buffer' });
  return XLSX.utils.sheet_to_json<unknown[]>(wb.Sheets[sheet], { header: 1, defval: null });
}

test('Excel: четыре листа, люди и рубли М50 — те же, что на вкладке', () => {
  const file = book();
  assert.deepEqual(XLSX.read(file, { type: 'buffer' }).SheetNames, [...STAFFING_XLSX_SHEETS]);

  const people = rows(file, 'Люди');
  assert.equal(people[0][3], 'Кассир', 'над окнами — должность');
  assert.deepEqual(people[1].slice(0, 6), ['Код', 'Лавка', 'Грейд', '6:30–7:30', '7:30–11', '11–16']);
  const m50 = people.find((r) => r[0] === 'М50')!;
  // Кассиры: окна, FTE, чел.-ч в день и в месяц.
  assert.deepEqual(m50.slice(3, 12), [3, 6, 6, 6, 6, 4, 16, 92, 2852]);

  const rub = rows(file, 'Рубли').find((r) => r[0] === 'М50')!;
  // 7:30–11: 6 × 3,5 × 310; день 92 × 310; месяц 2852 × 310.
  assert.deepEqual(rub.slice(3, 11), [930, 6510, 9300, 2790, 6510, 2480, 28520, 884120]);
  // Замы, су-шеф и сборщик — своими группами в конце сетки: окно, FTE (пусто), часы.
  assert.deepEqual(people[0].slice(-16).filter(Boolean), ['ЗД по бару', 'ЗД по залу', 'Су-шеф', 'Сборщик заказов']);
});

test('Excel: «Итого по сети» — формулой по видимым строкам и сразу со значением', () => {
  const wb = XLSX.read(book(), { type: 'buffer', cellFormula: true });
  const sheet = wb.Sheets['Люди'];
  const last = XLSX.utils.decode_range(sheet['!ref']!).e.r;
  assert.equal(sheet[XLSX.utils.encode_cell({ r: last, c: 1 })].v, 'Итого по сети');
  const cell = sheet[XLSX.utils.encode_cell({ r: last, c: 5 })];
  assert.match(cell.f, /^SUBTOTAL\(109,F3:F\d+\)$/);
  const sum = seed.norms.reduce((s, n) => s + n.roles.cashier.slots[2].count, 0);
  assert.equal(cell.v, sum, 'кассиров в 11–16 по сети');

  // У одной лавки строки «итого» нет — она повторяла бы саму лавку.
  const one = rows(book(seed.norms.filter((n) => n.code === 'М50')), 'Люди');
  assert.equal(one.length, 3);
});

test('Excel: шапка и колонки с лавкой закреплены, «Данные» — строка на окно', () => {
  const file = book();
  const zip = XLSX.CFB.read(file, { type: 'buffer' });
  const xml = (i: number) => Buffer.from(XLSX.CFB.find(zip, `/xl/worksheets/sheet${i}.xml`).content).toString('utf8');
  assert.match(xml(1), /<pane xSplit="3" ySplit="2" topLeftCell="D3"[^>]*state="frozen"\/>/);
  assert.match(xml(2), /<pane xSplit="3" ySplit="2"/);
  assert.match(xml(3), /<pane ySplit="1" topLeftCell="A2"/);
  assert.doesNotMatch(xml(4), /<pane/);

  const data = rows(file, 'Данные');
  const windows = seed.norms.reduce((s, n) => s + STAFF_ROLES.reduce((k, r) => k + n.roles[r].slots.length, 0), 0);
  assert.equal(data.length - 1, windows);
  const row = data.find((r) => r[0] === 'М50' && r[4] === 'Кассир' && r[5] === '7:30–11')!;
  // Начало и конец — доля суток, часов, человек, чел.-ч, ставка, ₽, где стоят.
  assert.deepEqual(row.slice(6), [450 / 1440, 660 / 1440, 3.5, 6, 21, 310, 6510, '6 официант']);
  // Су-шеф — где он есть по ШР: весь день, 350 ₽/ч, контроль витрин и доготовка.
  const chef = data.find((r) => r[0] === 'М8' && r[4] === 'Су-шеф')!;
  assert.deepEqual(chef.slice(5), ['6:30–23', 390 / 1440, 1380 / 1440, 16.5, 1, 16.5, 350, 5775, '1 контроль витрин + доготовка']);
  const deputy = data.find((r) => r[0] === 'М50' && r[4] === 'ЗД по бару')!;
  assert.deepEqual(deputy.slice(5, 13), ['6:30–18', 390 / 1440, 1080 / 1440, 11.5, 1, 11.5, 350, 4025]);
});
