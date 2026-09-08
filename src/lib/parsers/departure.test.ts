import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { looksLikeDeparture, mergeDepartures, parseDepartures } from './departure';
import { detectFixtureKind, peekGrid } from '../fixtures';

/**
 * Выгрузка по РЦ: те же колонки, что у отметок, но в «Подразделении» склад,
 * а не лавка. Раньше такой файл радар отбрасывал целиком.
 */

const HEADER = ['Подразделение', 'Сотрудник', 'Должность', 'Приход', 'Уход'];

function book(rows: unknown[][]): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([HEADER, ...rows]), 'Лист_1');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const RC = [
  ['РЦ Свобода', 'Иванов Иван Иванович', 'Водитель-экспедитор', '05.09.2026 3:22:14', '05.09.2026 4:17:06'],
  ['РЦ Свобода', 'Петров Пётр Петрович', 'Водитель-экспедитор', '05.09.2026 4:01:00', '05.09.2026 5:44:00'],
  ['Итого', '', '', '', ''],
];

test('склад в «Подразделении» опознаётся как выгрузка по РЦ', () => {
  const buf = book(RC);
  assert.equal(looksLikeDeparture(peekGrid(buf)), true);
  assert.equal(detectFixtureKind(['Лист_1'], peekGrid(buf)), 'departure');
});

test('выгрузка отметок по лавкам выгрузкой по РЦ не считается', () => {
  // Иначе обычные «выходы» и «водители» уехали бы не в ту ветку разбора.
  const shops = [
    ['М1 Милютинский', 'Сидоров Сидор', 'Повар', '05.09.2026 6:20:00', '05.09.2026 15:00:00'],
  ];
  const buf = book(shops);

  assert.equal(looksLikeDeparture(peekGrid(buf)), false);
  assert.equal(detectFixtureKind(['Лист_1'], peekGrid(buf)), 'attendance');
});

test('без содержимого тип по-прежнему определяется по листам', () => {
  // Старое поведение не должно ломаться: grid — необязательный аргумент.
  assert.equal(detectFixtureKind(['Все данные']), 'legacy');
  assert.equal(detectFixtureKind(['Время поставки']), 'delivery');
  assert.equal(detectFixtureKind(['Лавки БК ']), 'roster');
  assert.equal(detectFixtureKind(['Лист_1']), 'attendance');
});

test('уход разбирается как выезд, приход остаётся справочно', () => {
  const r = parseDepartures(book(RC));

  assert.equal(r.rows.length, 2, '«Итого» — не сотрудник');
  assert.deepEqual(r.units, ['РЦ Свобода']);
  assert.deepEqual(r.dates, ['2026-09-05']);

  const [first] = r.rows;
  assert.equal(first.employeeName, 'Иванов Иван Иванович');
  assert.equal(first.departureMinutes, 4 * 60 + 17, 'выезд — это «Уход»');
  assert.equal(first.arrivalMinutes, 3 * 60 + 22);
});

test('строка без ухода попадает в предупреждения, а не теряется молча', () => {
  const r = parseDepartures(
    book([['РЦ Свобода', 'Иванов Иван', 'Водитель-экспедитор', '05.09.2026 3:22:14', '']]),
  );

  assert.equal(r.rows.length, 1, 'строка остаётся: приход в ней есть');
  assert.equal(r.rows[0].departureMinutes, null);
  assert.match(r.warnings.join('\n'), /нет ухода/);
});

test('файл без нужных колонок отвергается с понятной причиной', () => {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([['А', 'Б'], [1, 2]]), 'Лист_1');
  const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

  assert.throws(() => parseDepartures(buf), /не выгрузка по РЦ/);
});

test('несколько выгрузок склеиваются в одну ленту по дням', () => {
  const first = parseDepartures(book(RC)).rows; // 05.09
  const second = parseDepartures(
    book([
      ['РЦ Свобода', 'Иванов Иван Иванович', 'Водитель-экспедитор', '08.09.2026 3:10:00', '08.09.2026 4:40:00'],
    ]),
  ).rows;

  const merged = mergeDepartures([first, second]);
  assert.deepEqual(
    [...new Set(merged.map((r) => r.date))],
    ['2026-09-05', '2026-09-08'],
    'день из второго файла не должен теряться — из-за этого он и не появлялся на сводке',
  );
  assert.equal(merged.length, first.length + second.length);
});

test('день, попавший в две выгрузки, берётся из последней, а не удваивается', () => {
  const stale = parseDepartures(
    book([
      ['РЦ Свобода', 'Иванов Иван Иванович', 'Водитель-экспедитор', '05.09.2026 3:22:14', '05.09.2026 5:44:00'],
    ]),
  ).rows;
  const fixed = parseDepartures(
    book([
      ['РЦ Свобода', 'Иванов Иван Иванович', 'Водитель-экспедитор', '05.09.2026 3:22:14', '05.09.2026 4:17:06'],
    ]),
  ).rows;

  const merged = mergeDepartures([stale, fixed]);
  assert.equal(merged.length, 1, 'один выезд, а не два');
  assert.equal(merged[0].departureMinutes, 4 * 60 + 17, 'время из исправленной выгрузки');
});
