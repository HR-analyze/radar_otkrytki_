import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOwners, reportDates, showcaseGaps } from './showcase-owners';

test('лавки строкой из таблицы: латинская M и ведущий ноль приводятся к виду базы', () => {
  const r = parseOwners([{ name: '  Оператор  СБ 1 ', shops: 'M01, М02;м3  M04 М02' }]);
  assert.ok(r.ok);
  assert.deepEqual(r.value, [{ name: 'Оператор СБ 1', shops: ['М1', 'М2', 'М3', 'М4'] }]);
});

test('одна лавка у двоих — ошибка: иначе за пропуск не отвечает никто', () => {
  const r = parseOwners([
    { name: 'Крючков Валентин', shops: ['М14'] },
    { name: 'Денисов Евгений', shops: 'М21, M014' },
  ]);
  assert.equal(r.ok, false);
  assert.match(!r.ok ? r.error : '', /М14 уже у «Крючков Валентин»/);
});

test('пустая строка редактора пропускается, лавки без имени и мусор в коде — ошибка', () => {
  assert.deepEqual(parseOwners([{ name: '', shops: '' }]), { ok: true, value: [] });
  assert.equal(parseOwners([{ name: '', shops: 'М1' }]).ok, false);
  assert.equal(parseOwners([{ name: 'Иванова Ирина', shops: 'М1, привет' }]).ok, false);
  assert.equal(parseOwners([{ name: 'А', shops: '' }, { name: 'а', shops: '' }]).ok, false, 'имя дважды');
});

const shops = ['М1', 'М2', 'М3', 'М15'].map((code) => ({ code, name: code }));

test('пустой замер — нет значения; 0% — заполнено; закрытая лавка не спрашивается', () => {
  const report = showcaseGaps({
    owners: [
      { name: 'Иванова Ирина', shops: ['М1', 'М15'] },
      { name: 'Гринь Анна', shops: ['М2', 'М84'] },
    ],
    fills: {
      '2026-10-01': { М1: 0, М2: 1 },
      '2026-10-02': { М2: 0.9 },
    },
    dates: ['2026-10-01', '2026-10-02'],
    shops,
    // М15 закрыта со 2-го.
    isOpen: (code, date) => !(code === 'М15' && date >= '2026-10-02'),
  });

  const ira = report.owners.find((o) => o.name === 'Иванова Ирина')!;
  assert.equal(ira.expected, 3, 'М1 × 2 дня + М15 только 1-го');
  assert.equal(ira.missingCount, 2);
  assert.deepEqual(ira.missing, [
    { date: '2026-10-01', shops: ['М15'] },
    { date: '2026-10-02', shops: ['М1'] },
  ]);

  const anna = report.owners.find((o) => o.name === 'Гринь Анна')!;
  assert.equal(anna.missingCount, 0);
  assert.deepEqual(anna.unknown, ['М84'], 'лавки нет в справочнике — в пропуски не идёт');

  assert.equal(report.owners[0].name, 'Иванова Ирина', 'сначала те, у кого больше пропусков');
  assert.deepEqual(report.unassigned.map((s) => s.code), ['М3']);
});

test('сегодня в отчёт идёт, только когда час замера прошёл', () => {
  const range = ['2026-10-18', '2026-10-19'];
  assert.deepEqual(reportDates(range, '2026-10-19', 15 * 60 + 59, 'afternoon'), {
    dates: ['2026-10-18'],
    todaySkipped: true,
  });
  assert.deepEqual(reportDates(range, '2026-10-19', 16 * 60, 'afternoon').dates, range);
  assert.deepEqual(reportDates(range, '2026-10-19', 9 * 60, 'morning').dates, range);
});
