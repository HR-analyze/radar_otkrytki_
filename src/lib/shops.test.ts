import assert from 'node:assert/strict';
import test from 'node:test';
import { compareShopNumber, looksLikeShopCode, shopNumber } from './shops';

/**
 * Порядок «как в справочнике» — не алфавитный, и именно в этом смысл:
 * при сортировке строками М10 встаёт между М1 и М2, и лавку в таблице из
 * восьмидесяти строк перестаёшь находить глазами.
 */
test('порядок справочника: М10 идёт после М2, а не между М1 и М2', () => {
  const shops = [
    { code: 'М10', name: 'М10 Брестская' },
    { code: 'М2', name: 'М2 Покровка' },
    { code: 'М1', name: 'М1 Милютинский' },
    { code: 'М21', name: 'М21 Гоголевский' },
  ];
  assert.deepEqual(
    [...shops].sort(compareShopNumber).map((s) => s.code),
    ['М1', 'М2', 'М10', 'М21'],
  );
});

test('код без цифр уходит в конец, а не в начало', () => {
  const shops = [
    { code: 'РЦ', name: 'Распределительный центр' },
    { code: 'М3', name: 'М3 Пресня' },
  ];
  assert.deepEqual([...shops].sort(compareShopNumber).map((s) => s.code), ['М3', 'РЦ']);
});

test('число из кода лавки: ведущий ноль не мешает', () => {
  assert.equal(shopNumber('М12'), 12);
  assert.equal(shopNumber('М09'), 9);
});

test('код без цифр не превращается в ноль', () => {
  // Number('') даёт 0 — с ним лавка «РЦ» уехала бы в самое начало списка.
  assert.equal(shopNumber('РЦ'), Number.MAX_SAFE_INTEGER);
});

/**
 * Проверка формата нужна в proxy — до того, как страница начала отвечать.
 * Отвергнуть настоящий код она не должна ни при каких обстоятельствах:
 * коды и извлекаются этой же регуляркой.
 */
test('коды лавок узнаются, в том числе из чужой раскладки и с нулём', () => {
  for (const code of ['М1', 'М12', 'М09', 'M1', 'м 12', 'РЦ12', 'М1 Милютинский']) {
    assert.equal(looksLikeShopCode(code), true, code);
  }
});

test('мусор в адресе кодом не считается', () => {
  for (const junk of ['НЕТ-ТАКОЙ', '', '   ', 'справочник', '12', '..', 'М']) {
    assert.equal(looksLikeShopCode(junk), false, JSON.stringify(junk));
  }
});
