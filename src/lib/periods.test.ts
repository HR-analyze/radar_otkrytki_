import assert from 'node:assert/strict';
import test from 'node:test';
import { activePreset, periodPresets, shiftDays } from './periods';

const DATES = [
  '2026-08-25', '2026-08-26', '2026-08-27', '2026-08-28', '2026-08-29',
  '2026-08-30', '2026-08-31', '2026-09-01', '2026-09-02', '2026-09-03',
];

test('без дат пресетов нет: показывать «7 дней» не от чего', () => {
  assert.deepEqual(periodPresets([]), []);
});

test('отсчёт идёт от последнего дня с данными, а не от сегодняшнего числа', () => {
  const [day, week] = periodPresets(DATES);
  assert.equal(day.from, '2026-09-03');
  assert.equal(day.to, '2026-09-03');
  assert.equal(week.to, '2026-09-03');
  assert.equal(week.from, '2026-08-28');
});

test('начало периода не уходит раньше первого дня с данными', () => {
  const presets = periodPresets(DATES);
  const month = presets.find((p) => p.key === '30d');
  assert.ok(month);
  // Истории всего десять дней — «30 дней» упираются в её начало.
  assert.equal(month.from, '2026-08-25');
});

test('«все данные» берут историю целиком', () => {
  const all = periodPresets(DATES).find((p) => p.key === 'all');
  assert.ok(all);
  assert.equal(all.from, '2026-08-25');
  assert.equal(all.to, '2026-09-03');
});

test('выбранный пресет узнаётся по совпадению обеих границ', () => {
  const presets = periodPresets(DATES);
  assert.equal(activePreset(presets, '2026-09-03', '2026-09-03'), 'day');
  assert.equal(activePreset(presets, '2026-08-28', '2026-09-03'), '7d');
  // Произвольный период, набранный в календаре, не совпадает ни с одним.
  assert.equal(activePreset(presets, '2026-08-27', '2026-09-01'), null);
});

test('сдвиг дня переживает границу месяца', () => {
  assert.equal(shiftDays('2026-09-01', -1), '2026-08-31');
  assert.equal(shiftDays('2026-12-31', 1), '2027-01-01');
});
