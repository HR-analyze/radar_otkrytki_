import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { excelSerial, showcaseXlsx, showcaseXlsxRows, SHOWCASE_XLSX_HEADER } from './showcase-xlsx';

const store = {
  days: { '2026-09-29': { М1: 1, М2: 0.9 }, '2026-09-30': { М1: 0.95 } },
  afternoon: { '2026-09-30': { М1: 0.5, М2: 0.8 } },
};

test('строки: лавка за лавкой, внутри — по дням, оба замера и их среднее', () => {
  const rows = showcaseXlsxRows(store, ['М1', 'М2'], ['2026-09-29', '2026-09-30']);

  assert.deepEqual(rows, [
    { shopCode: 'М1', date: '2026-09-29', morning: 1, afternoon: null, average: 1 },
    // 72,5% — до целого процента, как итог дня на радаре (см. dayFill).
    { shopCode: 'М1', date: '2026-09-30', morning: 0.95, afternoon: 0.5, average: 0.73 },
    { shopCode: 'М2', date: '2026-09-29', morning: 0.9, afternoon: null, average: 0.9 },
    // Мерили только в 16:00 — утро пустое, а не ноль.
    { shopCode: 'М2', date: '2026-09-30', morning: null, afternoon: 0.8, average: 0.8 },
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
  assert.deepEqual(aoa[1], ['М1', excelSerial('2026-09-30'), 0.95, 0.5, 0.73]);
  assert.deepEqual(aoa[2], ['М2', excelSerial('2026-09-30'), null, 0.8, 0.8]);

  // Как увидит человек в Excel. Дату SheetJS при чтении текстом не рисует —
  // проверяем формат ячейки, по нему Excel и покажет «30.09.2026».
  assert.equal(sheet.B2.z, 'dd.mm.yyyy');
  assert.equal(sheet.C2.w, '95%');
  assert.equal(sheet.D2.w, '50%');
  assert.equal(sheet.E2.w, '73%', 'среднее 95% и 50%');
  assert.equal(sheet.C3, undefined, 'не мерили — ячейки нет вовсе');
  assert.equal(sheet['!autofilter']?.ref, 'A1:E3');
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
