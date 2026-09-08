import test from 'node:test';
import assert from 'node:assert/strict';
import { averagePoints, formatPoints, pointsOf, scoreOf, sumScores } from './contest';
import type { Status } from './types';

test('пример из постановки: 3🟡 + 1🔴 + 1🟢 = 0', () => {
  const days: Status[] = ['yellow', 'yellow', 'yellow', 'red', 'green'];
  const score = scoreOf(days);

  assert.equal(score.points, 0);
  assert.equal(score.rated, 5);
  assert.deepEqual([score.green, score.yellow, score.red], [1, 3, 1]);
});

test('баллы: 🟢 +1, 🟡 0, 🔴 −1', () => {
  assert.equal(pointsOf('green'), 1);
  assert.equal(pointsOf('yellow'), 0);
  assert.equal(pointsOf('red'), -1);
});

test('дни без оценки в баллы и в знаменатель не входят', () => {
  const score = scoreOf(['no_data', 'other_schedule', 'green']);

  assert.equal(score.rated, 1, 'оценённый день только один');
  assert.equal(score.points, 1);
  assert.equal(pointsOf('no_data'), null);
  assert.equal(pointsOf('other_schedule'), null);
});

test('зелёный компенсирует красный — этим конкурс и отличается от радара', () => {
  const balanced = scoreOf(['red', 'green']);
  const onlyRed = scoreOf(['red']);

  assert.equal(balanced.points, 0);
  assert.equal(onlyRed.points, -1);
  assert.ok(balanced.points > onlyRed.points, 'две лавки с одной красной не равны');
});

test('баллы регионов складываются из баллов лавок', () => {
  const total = sumScores([scoreOf(['green', 'green']), scoreOf(['red', 'yellow'])]);

  assert.equal(total.points, 1);
  assert.equal(total.rated, 4);
  assert.deepEqual([total.green, total.yellow, total.red], [2, 1, 1]);
});

test('средний балл сравнивает РМ с разным числом лавок', () => {
  const big = scoreOf(['green', 'green', 'red', 'yellow']); // +1 за 4 дня
  const small = scoreOf(['green']); // +1 за 1 день

  assert.equal(big.points, small.points, 'суммы равны');
  assert.equal(averagePoints(big), 0.25);
  assert.equal(averagePoints(small), 1);
  assert.equal(averagePoints(scoreOf([])), null, 'оценок нет — среднего нет');
});

test('знак у баллов виден: «+3», «0», «−2»', () => {
  assert.equal(formatPoints(3), '+3');
  assert.equal(formatPoints(0), '0');
  assert.equal(formatPoints(-2), '−2');
});
