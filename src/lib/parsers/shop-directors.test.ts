import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { nameOf, parseShopDirectors } from './shop-directors';

const HEADER = [null, 'Лавка', 'Рабочий телефон лавки', 'Телефон управляющего', 'ФИ Управляющего', 'Территориальный директор', 'Региональный менеджер'];

/** Таблица как в жизни: ТД и телефон с именем слиты в одну ячейку на две строки. */
function book(): Buffer {
  const rows = [
    HEADER,
    ['М38', 'Лесная', '8 (968) 636-95-10', '8 (915) 320-03-88', null, 'Макарова Дарья', 'Шевкун Виктория 8 (916) 253-08-23'],
    ['М54', 'Ямского Поля', '89 688 792 458', null, null, null, null],
    ['М17', 'Б.Сухаревский', '8 (968) 636-94-74', '8(929) 600-00-07', 'Тольберг Лика', null, null],
    ['М75', 'Жулебино', null, null, 'Радучич (Пахомова) Ольга', null, null],
    ['М05', 'Щепкина', null, 'ЛАВКА ЗАКРЫТА', null, null, null],
  ];
  const sheet = XLSX.utils.aoa_to_sheet(rows);
  sheet['!merges'] = [
    XLSX.utils.decode_range('D2:E3'), // телефон ТД на две лавки, поверх колонки имени
    XLSX.utils.decode_range('F2:F3'), // ТД на две лавки
    XLSX.utils.decode_range('G2:G6'), // РМ на блок
  ];
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, sheet, 'Лавки');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test('таблица «Лавки»: ТД на обе лавки, телефон именем не становится', () => {
  const { rows, warnings } = parseShopDirectors(book());
  assert.deepEqual(warnings, []);
  assert.deepEqual(rows, [
    { code: 'М38', director: null, territorial: 'Макарова Дарья' },
    { code: 'М54', director: null, territorial: 'Макарова Дарья' },
    { code: 'М17', director: 'Тольберг Лика', territorial: null },
    { code: 'М75', director: 'Радучич Ольга', territorial: null },
    { code: 'М5', director: null, territorial: null },
  ]);
});

test('имя из клетки: скобки с фамилией убираются, телефон и пометки — не имя', () => {
  assert.equal(nameOf('Радучич (Пахомова) Ольга'), 'Радучич Ольга');
  assert.equal(nameOf('Жоробекова Элина '), 'Жоробекова Элина');
  assert.equal(nameOf('8 (915) 320-03-88'), null);
  assert.equal(nameOf('ЛАВКА ЗАКРЫТА'), null);
  assert.equal(nameOf(null), null);
});

test('в разобранной таблице нет телефонов и почты', () => {
  const json = JSON.stringify(parseShopDirectors(book()).rows);
  assert.ok(!/\d{3}/.test(json.replace(/М\d+/g, '')), 'в справочник утекли цифры — похоже на телефон');
  assert.ok(!json.includes('@'), 'в справочник утекла почта');
});
