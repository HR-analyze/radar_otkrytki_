import assert from 'node:assert/strict';
import test from 'node:test';
import { formatCookTimes, parseCookTimes, parseNormTime, parseShopNorms } from './shop-norms';

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

test('часы выхода поваров: количество отбрасывается', () => {
  assert.deepEqual(parseCookTimes('3 с 6.20'), ['06:20']);
  assert.deepEqual(parseCookTimes('3 в 6:30'), ['06:30']);
  assert.deepEqual(parseCookTimes('4 с 5.30'), ['05:30']);
  // «2 с 7»: голый час опознаётся только после предлога — иначе «3» из «3 с 6:20»
  // само сошло бы за 03:00.
  assert.deepEqual(parseCookTimes('2 с 7'), ['07:00']);
});

test('часы выхода: два часа во всех живых написаниях', () => {
  const expected = ['06:00', '06:30'];
  assert.deepEqual(parseCookTimes('1 с 6.00/2 6:30'), expected);
  assert.deepEqual(parseCookTimes('1 с 6:00/2 с 6:30'), expected);
  assert.deepEqual(parseCookTimes('1 в 6:00/2 в 6:30'), expected);
  assert.deepEqual(parseCookTimes('1 с 6.00 2 с 6:30'), expected);
});

test('часы выхода: человек вводит просто время, без «N с»', () => {
  assert.deepEqual(parseCookTimes('6:20'), ['06:20']);
  assert.deepEqual(parseCookTimes('6:00 / 6:30'), ['06:00', '06:30']);
  assert.deepEqual(parseCookTimes('6.00 6.30'), ['06:00', '06:30']);
});

test('часы выхода: порядок в справочнике не важен, ранний час первый', () => {
  assert.deepEqual(parseCookTimes('2 с 5:30 1 с 6:00'), ['05:30', '06:00']);
});

test('часы выхода: без количества — час всё равно читается', () => {
  assert.deepEqual(parseCookTimes('повар в 5.45'), ['05:45']);
  // Без защиты от захода внутрь числа «6.10» разбиралось бы как 0:00.
  assert.deepEqual(parseCookTimes('повар 6.10'), ['06:10']);
});

test('часы выхода: одинаковый час не дублируется', () => {
  assert.deepEqual(parseCookTimes('1 с 6:00 2 с 6:00'), ['06:00']);
});

test('часы выхода: пусто и мусор — пустой список', () => {
  assert.deepEqual(parseCookTimes(''), []);
  assert.deepEqual(parseCookTimes(null), []);
  assert.deepEqual(parseCookTimes('доверительная приемка'), []);
});

test('часы выхода показываются человеку', () => {
  assert.equal(formatCookTimes(['06:20']), '06:20');
  assert.equal(formatCookTimes(['06:00', '06:30']), '06:00 / 06:30');
  assert.equal(formatCookTimes([]), '—');
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
  assert.deepEqual(m1.cookAt, ['06:20'], 'из «3 с 6.20» в норму идёт только час');
  assert.equal(m1.source, 'reference');

  // Строка, где в справочнике вместо норм стоит телефон: норм нет, но и
  // предупреждения тоже — колонки времени просто пустые.
  assert.equal(m5.driverAt, null);
  assert.deepEqual(m5.cookAt, []);
  assert.deepEqual(m5.warnings, []);

  assert.deepEqual(m12.cookAt, ['06:00', '06:30']);
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
