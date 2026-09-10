import assert from 'node:assert/strict';
import test from 'node:test';
import { compareShopNumber, shopNumber } from './shops';

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
