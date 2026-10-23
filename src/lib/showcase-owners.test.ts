import assert from 'node:assert/strict';
import test from 'node:test';
import { parseOwners, reportDates, shopWorks, showcaseGaps } from './showcase-owners';

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

test('18:30 спрашивается с 26.10 и за сегодня — только после 18:30', () => {
  const range = ['2026-10-25', '2026-10-26', '2026-10-27'];
  assert.deepEqual(reportDates(range, '2026-10-27', 18 * 60 + 29, 'evening'), {
    dates: ['2026-10-26'],
    todaySkipped: true,
  });
  assert.deepEqual(reportDates(range, '2026-10-27', 18 * 60 + 30, 'evening').dates, [
    '2026-10-26',
    '2026-10-27',
  ]);
  // Утро и 16:00 эта дата не трогает.
  assert.deepEqual(reportDates(range, '2026-10-27', 20 * 60, 'afternoon').dates, range);
});

test('выходной лавки — не пропуск: по выгрузке отметок, а без неё — по прошлым неделям', () => {
  // Октябрь 2026: 3, 10, 17 — субботы, 24 — суббота без выгрузки.
  const dates = ['2026-10-02', '2026-10-03', '2026-10-09', '2026-10-10', '2026-10-16', '2026-10-17'];
  const coverage = {
    criteria: new Set<string>(),
    dates: new Set(dates),
    // М16 выходит только по будням, М14 — каждый день.
    shops: new Set(
      dates.flatMap((d) => (['03', '10', '17'].includes(d.slice(8)) ? [`${d}|М14`] : [`${d}|М14`, `${d}|М16`])),
    ),
  };

  assert.equal(shopWorks(coverage, 'М16', '2026-10-17'), false, 'нет в выгрузке — не работала');
  assert.equal(shopWorks(coverage, 'М16', '2026-10-16'), true);
  assert.equal(shopWorks(coverage, 'М16', '2026-10-24'), false, 'суббота без выгрузки — выходной по графику');
  assert.equal(shopWorks(coverage, 'М14', '2026-10-24'), true);
  assert.equal(shopWorks(coverage, 'М16', '2026-10-23'), true, 'пятница без выгрузки — рабочая');

  const report = showcaseGaps({
    owners: [{ name: 'Крючков Валентин', shops: ['М14', 'М16'] }],
    fills: {},
    dates: [...dates, '2026-10-24'],
    shops: [{ code: 'М14', name: 'М14' }, { code: 'М16', name: 'М16' }],
    isOpen: () => true,
    works: (code, date) => shopWorks(coverage, code, date),
  });
  const owner = report.owners[0];
  assert.equal(owner.daysOff, 4, 'четыре субботы М16');
  assert.ok(owner.missing.every((d) => !(d.shops.includes('М16') && new Date(`${d.date}T12:00:00Z`).getUTCDay() === 6)));
});
