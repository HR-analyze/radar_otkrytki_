import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { excelSerial, showcaseXlsx, showcaseXlsxRows, SHOWCASE_XLSX_HEADER } from './showcase-xlsx';

const store = {
  days: { '2026-09-29': { М1: 1, М2: 0.9 }, '2026-09-30': { М1: 0.95 } },
  afternoon: { '2026-09-30': { М1: 0.5, М2: 0.8 } },
  evening: { '2026-10-26': { М1: 0.7 } },
};

test('строки: лавка за лавкой, внутри — по дням, оба замера и их среднее', () => {
  const rows = showcaseXlsxRows(store, ['М1', 'М2'], ['2026-09-29', '2026-09-30']);

  assert.deepEqual(rows, [
    { shopCode: 'М1', date: '2026-09-29', morning: 1, afternoon: null, evening: null, average: 1 },
    // 72,5% — до целого процента, как итог дня на радаре (см. dayFill).
    { shopCode: 'М1', date: '2026-09-30', morning: 0.95, afternoon: 0.5, evening: null, average: 0.73 },
    { shopCode: 'М2', date: '2026-09-29', morning: 0.9, afternoon: null, evening: null, average: 0.9 },
    // Мерили только в 16:00 — утро пустое, а не ноль.
    { shopCode: 'М2', date: '2026-09-30', morning: null, afternoon: 0.8, evening: null, average: 0.8 },
  ]);
});

test('дни, когда лавка закрыта, в выгрузку не попадают', () => {
  const rows = showcaseXlsxRows(
    store,
    ['М1', 'М2'],
    ['2026-09-29', '2026-09-30'],
    (code, date) => !(code === 'М2' && date >= '2026-09-30'),
  );
  assert.deepEqual(
    rows.map((r) => `${r.shopCode} ${r.date}`),
    ['М1 2026-09-29', 'М1 2026-09-30', 'М2 2026-09-29'],
  );
});

test('книга: заголовок, настоящие даты и проценты, пустой замер — пустая ячейка', () => {
  const rows = showcaseXlsxRows(store, ['М1', 'М2'], ['2026-09-30']);
  const book = XLSX.read(showcaseXlsx(rows), { type: 'buffer', cellNF: true });
  const sheet = book.Sheets[book.SheetNames[0]];

  const aoa = XLSX.utils.sheet_to_json<unknown[]>(sheet, { header: 1, raw: true, defval: null });
  assert.deepEqual(aoa[0], [...SHOWCASE_XLSX_HEADER]);
  assert.deepEqual(aoa[1], ['М1', excelSerial('2026-09-30'), 0.95, 0.5, null, 0.73]);
  assert.deepEqual(aoa[2], ['М2', excelSerial('2026-09-30'), null, 0.8, null, 0.8]);

  // Как увидит человек в Excel. Дату SheetJS при чтении текстом не рисует —
  // проверяем формат ячейки, по нему Excel и покажет «30.09.2026».
  assert.equal(sheet.B2.z, 'dd.mm.yyyy');
  assert.equal(sheet.C2.w, '95%');
  assert.equal(sheet.D2.w, '50%');
  assert.equal(sheet.E2, undefined, '18:30 до 26.10 не мерили — ячейки нет');
  assert.equal(sheet.F2.w, '73%', 'среднее 95% и 50%');
  assert.equal(sheet.C3, undefined, 'не мерили — ячейки нет вовсе');
  assert.equal(sheet['!autofilter']?.ref, 'A1:F3');
});

test('18:30 — своя колонка и входит в среднее', () => {
  const [row] = showcaseXlsxRows(store, ['М1'], ['2026-10-26']);
  assert.deepEqual(row, {
    shopCode: 'М1',
    date: '2026-10-26',
    morning: null,
    afternoon: null,
    evening: 0.7,
    average: 0.7,
  });

  const both = showcaseXlsxRows(
    { ...store, days: { '2026-10-26': { М1: 1 } }, afternoon: { '2026-10-26': { М1: 0.9 } } },
    ['М1'],
    ['2026-10-26'],
  );
  // (100 + 90 + 70) / 3 = 86,67 → 87%.
  assert.equal(both[0].average, 0.87);
});

test('среднее: ни одного замера — пусто, а не ноль', () => {
  // Само правило среднего проверяется у dayFill (showcase-store.test.ts).
  const [row] = showcaseXlsxRows(store, ['М3'], ['2026-09-30']);
  assert.equal(row.average, null);
});

test('серийный номер Excel не зависит от зоны сервера', () => {
  assert.equal(excelSerial('1900-03-01'), 61);
  assert.equal(excelSerial('2026-09-30'), 46295);
});
