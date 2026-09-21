import assert from 'node:assert/strict';
import test from 'node:test';
import {
  MAX_SHOWCASE_RANGE_DAYS,
  defaultShowcaseRange,
  lastDaysRange,
  monthRange,
  resolveShowcaseRange,
  shiftShowcaseRange,
} from './showcase-range';

const TODAY = '2026-09-21';

test('перепутанные местами границы меняются обратно', () => {
  assert.deepEqual(resolveShowcaseRange('2026-09-20', '2026-09-10', TODAY), {
    from: '2026-09-10',
    to: '2026-09-20',
  });
});

test('будущие дни отрезаются: витрину за завтра заполнять нечем', () => {
  assert.deepEqual(resolveShowcaseRange('2026-09-15', '2026-12-31', TODAY), {
    from: '2026-09-15',
    to: TODAY,
  });
});

test('окно целиком в будущем схлопывается в сегодняшний день', () => {
  assert.deepEqual(resolveShowcaseRange('2026-10-01', '2026-10-05', TODAY), {
    from: TODAY,
    to: TODAY,
  });
});

test('слишком длинное окно обрезается слева — свежий край важнее', () => {
  const range = resolveShowcaseRange('2020-01-01', TODAY, TODAY);
  assert.equal(range.to, TODAY);
  // Ровно предел: 62 дня, считая оба конца.
  assert.equal(range.from, '2026-07-22');
  const span = (Date.parse(range.to) - Date.parse(range.from)) / 86_400_000 + 1;
  assert.equal(span, MAX_SHOWCASE_RANGE_DAYS);
});

test('по умолчанию — текущий месяц до сегодня', () => {
  assert.deepEqual(defaultShowcaseRange(TODAY), { from: '2026-09-01', to: TODAY });
});

test('первого числа окно по умолчанию тянется назад на неделю, а не в один день', () => {
  assert.deepEqual(defaultShowcaseRange('2026-09-01'), {
    from: '2026-08-26',
    to: '2026-09-01',
  });
});

test('стрелка влево показывает предыдущие столько же дней', () => {
  const week = { from: '2026-09-15', to: '2026-09-21' };
  assert.deepEqual(shiftShowcaseRange(week, -1, TODAY), {
    from: '2026-09-08',
    to: '2026-09-14',
  });
});

test('стрелка вправо не уводит окно в будущее и не схлопывает его', () => {
  const week = { from: '2026-09-15', to: '2026-09-21' };
  // Окно уже упёрлось в сегодня: длину сохраняем, шага не делаем.
  assert.deepEqual(shiftShowcaseRange(week, 1, TODAY), week);
  // Из середины истории шаг вправо обычный.
  assert.deepEqual(shiftShowcaseRange({ from: '2026-09-01', to: '2026-09-07' }, 1, TODAY), {
    from: '2026-09-08',
    to: '2026-09-14',
  });
});

test('«7 дней» считают сегодняшний день седьмым, а не восьмым', () => {
  assert.deepEqual(lastDaysRange(7, TODAY), { from: '2026-09-15', to: TODAY });
});

test('месяц берётся календарный, но не дальше сегодняшнего дня', () => {
  assert.deepEqual(monthRange('2026-08', TODAY), { from: '2026-08-01', to: '2026-08-31' });
  assert.deepEqual(monthRange('2026-09', TODAY), { from: '2026-09-01', to: TODAY });
  // Февраль високосного 2028-го — длину месяца считает Date, а не таблица.
  assert.deepEqual(monthRange('2028-02', '2028-03-10'), { from: '2028-02-01', to: '2028-02-29' });
});
