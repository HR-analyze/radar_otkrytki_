import assert from 'node:assert/strict';
import test from 'node:test';
import { PRESENCE_TTL_MS, PresenceBoard } from './showcase-presence';

test('метка видна остальным, но не себе, и гаснет без пульса', () => {
  const board = new PresenceBoard();
  board.touch('tab-ira-0001', 'Иванова Ирина', { date: '2026-10-19', shopCode: 'М16' }, 1000);
  board.touch('tab-dima-0001', 'Горностаев Дмитрий', { date: '2026-10-19', shopCode: 'М79' }, 1000);

  assert.deepEqual(
    board.others('tab-dima-0001', 2000).map((e) => `${e.who}|${e.shopCode}`),
    ['Иванова Ирина|М16'],
  );
  assert.deepEqual(board.others('tab-dima-0001', 1000 + PRESENCE_TTL_MS + 1), [], 'вкладку закрыли — метки нет');
});

test('ушёл со строки — метка снимается сразу', () => {
  const board = new PresenceBoard();
  board.touch('tab-ira-0001', 'Иванова Ирина', { date: '2026-10-19', shopCode: 'М16' }, 1000);
  board.touch('tab-ira-0001', 'Иванова Ирина', null, 1500);
  assert.deepEqual(board.others('someone-else', 1600), []);
});
