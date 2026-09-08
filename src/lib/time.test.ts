import test from 'node:test';
import assert from 'node:assert/strict';
import { excelDay, formatClock, formatDay, formatMoment, todayIso } from './time';

/**
 * Время на сайте — московское.
 *
 * Проверки нарочно идут от момента в UTC: сервер на хостинге живёт в UTC,
 * машина разработчика — в чём угодно, и тест не должен зависеть от TZ.
 */

test('«сегодня» считается по Москве, а не по зоне сервера', () => {
  // 21:30 UTC — это уже 00:30 следующего дня в Москве.
  assert.equal(todayIso(new Date('2026-09-08T21:30:00Z')), '2026-09-09');
  // 23:00 UTC 07-го — в Москве 02:00 08-го: до правки радар открывался на 07-м.
  assert.equal(todayIso(new Date('2026-09-07T23:00:00Z')), '2026-09-08');
  assert.equal(todayIso(new Date('2026-09-08T09:00:00Z')), '2026-09-08');
});

test('метка загрузки показывается по Москве', () => {
  // Утренняя загрузка 06:38 МСК хранится как 03:38 UTC.
  assert.equal(formatMoment('2026-09-08T03:38:00.000Z'), '08.09.2026, 06:38');
});

test('битая метка времени показывается как есть, а не «Invalid Date»', () => {
  assert.equal(formatMoment('не время'), 'не время');
});

test('подпись дня не съезжает на соседний в другой зоне', () => {
  assert.equal(formatDay('2026-09-08', { day: 'numeric', month: 'long' }), '8 сентября');
  assert.equal(formatDay('2026-01-01', { day: 'numeric', month: 'long', year: 'numeric' }), '1 января 2026 г.');
});

test('время из выгрузки не переводится: там уже московские часы', () => {
  assert.equal(formatClock(4 * 60 + 17), '04:17');
});

test('дата из ячейки Excel не съезжает на соседний день', () => {
  // SheetJS собирает дату ячейки в зоне машины и промахивается на 36 секунд:
  // в UTC получается ровно полночь, восточнее — 23:59:24 предыдущего дня.
  const midnight = new Date(2026, 7, 19);
  const almost = new Date(midnight.getTime() - 36_000);

  assert.equal(excelDay(midnight), '2026-08-19');
  assert.equal(excelDay(almost), '2026-08-19', 'иначе 19 августа превращается в 18-е');
});
