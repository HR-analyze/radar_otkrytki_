import assert from 'node:assert/strict';
import test from 'node:test';
import {
  expandCookShifts,
  formatCookShifts,
  parseCookShifts,
  parseNormTime,
  parseShopNorms,
} from './shop-norms';

test('время норматива: точка и двоеточие — один и тот же разделитель', () => {
  assert.equal(parseNormTime('6.30'), '06:30');
  assert.equal(parseNormTime('6:30'), '06:30');
  assert.equal(parseNormTime('06:00:00'), '06:00');
  assert.equal(parseNormTime('5.50'), '05:50');
  assert.equal(parseNormTime('8.00'), '08:00');
});

test('время норматива: голый час — это ровный час', () => {
  assert.equal(parseNormTime('7'), '07:00');
  assert.equal(parseNormTime('2 с 7'.replace('2 с ', '')), '07:00');
});

test('время норматива: мусор и невозможные значения — null', () => {
  assert.equal(parseNormTime(''), null);
  assert.equal(parseNormTime(null), null);
  assert.equal(parseNormTime('нет'), null);
  assert.equal(parseNormTime('8 (968) 636-95-27'), null, 'телефон — не время');
  assert.equal(parseNormTime('25:00'), null);
  assert.equal(parseNormTime('6:75'), null);
});

test('смены поваров: одна смена', () => {
  assert.deepEqual(parseCookShifts('3 с 6.20'), [{ count: 3, at: '06:20' }]);
  assert.deepEqual(parseCookShifts('3 в 6:30'), [{ count: 3, at: '06:30' }]);
  assert.deepEqual(parseCookShifts('2 с 7'), [{ count: 2, at: '07:00' }]);
});

test('смены поваров: две смены во всех живых написаниях', () => {
  const expected = [
    { count: 1, at: '06:00' },
    { count: 2, at: '06:30' },
  ];
  assert.deepEqual(parseCookShifts('1 с 6.00/2 6:30'), expected);
  assert.deepEqual(parseCookShifts('1 с 6:00/2 с 6:30'), expected);
  assert.deepEqual(parseCookShifts('1 в 6:00/2 в 6:30'), expected);
  assert.deepEqual(parseCookShifts('1 с 6.00 2 с 6:30'), expected);
});

test('смены поваров: порядок в справочнике не важен, ранняя смена первая', () => {
  assert.deepEqual(parseCookShifts('2 с 5:30 1 с 6:00'), [
    { count: 2, at: '05:30' },
    { count: 1, at: '06:00' },
  ]);
});

test('смены поваров: без количества — значит повар один', () => {
  assert.deepEqual(parseCookShifts('повар в 5.45'), [{ count: 1, at: '05:45' }]);
  // Без защиты от захода внутрь числа «6.10» разбиралось бы как «1 повар к 0:00».
  assert.deepEqual(parseCookShifts('повар 6.10'), [{ count: 1, at: '06:10' }]);
});

test('смены поваров: одинаковое время складывается в одну смену', () => {
  assert.deepEqual(parseCookShifts('1 с 6:00 2 с 6:00'), [{ count: 3, at: '06:00' }]);
});

test('смены поваров: пусто и мусор — пустой список', () => {
  assert.deepEqual(parseCookShifts(''), []);
  assert.deepEqual(parseCookShifts(null), []);
  assert.deepEqual(parseCookShifts('доверительная приемка'), []);
});

test('смены разворачиваются по одному времени на повара', () => {
  assert.deepEqual(
    expandCookShifts([
      { count: 2, at: '05:30' },
      { count: 1, at: '06:00' },
    ]),
    ['05:30', '05:30', '06:00'],
  );
  assert.deepEqual(expandCookShifts([]), []);
});

test('смены показываются человеку', () => {
  assert.equal(formatCookShifts([{ count: 3, at: '06:20' }]), '3 с 06:20');
  assert.equal(formatCookShifts([]), '—');
});

test('книга справочника разбирается построчно', () => {
  const csv = [
    '№,название,размер витрины общий,время приезда водителя,количество поваров и тайминг,',
    'М01,Милютинский,852см,6.30,3 с 6.20,',
    'М05,Щепкина,8 (968) 636-95-27,,,',
    'М12,Даниловская мануфактура,"9,29 м",6:00,1 с 6.00/2 6:30,',
  ].join('\n');

  const { norms, warnings } = parseShopNorms(Buffer.from(csv, 'utf8'));
  assert.deepEqual(warnings, []);
  assert.equal(norms.length, 3);

  const [m1, m5, m12] = norms;
  assert.equal(m1.code, 'М1', 'ведущий ноль в коде убирается — как в выгрузках 1С');
  assert.equal(m1.driverAt, '06:30');
  assert.deepEqual(m1.cookShifts, [{ count: 3, at: '06:20' }]);
  assert.equal(m1.source, 'reference');

  // Строка, где в справочнике вместо норм стоит телефон: норм нет, но и
  // предупреждения тоже — колонки времени просто пустые.
  assert.equal(m5.driverAt, null);
  assert.deepEqual(m5.cookShifts, []);
  assert.deepEqual(m5.warnings, []);

  assert.deepEqual(m12.cookShifts, [
    { count: 1, at: '06:00' },
    { count: 2, at: '06:30' },
  ]);
  assert.equal(m12.rawCook, '1 с 6.00/2 6:30', 'исходная запись сохраняется для сверки');
});

test('лавка без разбираемого времени получает предупреждение', () => {
  const csv = [
    '№,название,время приезда водителя,количество поваров и тайминг',
    'М01,Милютинский,завтра,как обычно',
  ].join('\n');

  const { norms } = parseShopNorms(Buffer.from(csv, 'utf8'));
  assert.equal(norms[0].driverAt, null);
  assert.equal(norms[0].warnings.length, 2, 'жалоба и на водителя, и на поваров');
});

test('книга без нужных колонок — это ошибка, а не пустой результат', () => {
  const csv = 'что-то,совсем,другое\n1,2,3';
  assert.throws(() => parseShopNorms(Buffer.from(csv, 'utf8')), /не нашлись колонки/);
});
