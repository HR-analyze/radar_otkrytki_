import test from 'node:test';
import assert from 'node:assert/strict';
import * as XLSX from 'xlsx';
import { parseStaffing, parseWindow } from './staffing';
import { findStaffNorm, slotLabel, slotShortLabel, staffAt, parseTimeOfDay } from '../staffing';

const HEADER = [
  'Лавка', 'ТО план', 'Грейд', 'Кофемашина',
  'Кассир\r\n6.5-7,5', 'Кассир\r\n7,5-11', 'Кассир\r\n11-16', 'Кассир\r\nFTE', 'ЧЕЛ-КО часы',
  'Повар\r\nдо 8', 'Повар\r\n8-11', 'Повар\r\n11-16', 'Повар\r\nFTE', 'ЧЕЛ-КО часы',
  'Бариста\r\nдо 8', 'Бариста\r\n8-11', 'Бариста\r\n11-16', 'Бариста\r\nFTE', 'ЧЕЛ-КО часы',
  'Уборщик\r\nдо 8', 'Уборщик\r\n8-11', 'Уборщик\r\n11-16', 'Уборщик\r\nFTE', 'ЧЕЛ-КО часы',
];

/**
 * «ШР по лавкам» как в жизни: сверху ставки и графики, строка заголовков — с
 * «Регион», дальше лавки. Сборщики — первая колонка «Сборщик заказа», вторая
 * такая же — уже рубли ФОТ, её брать нельзя.
 */
const SHR = [
  [null, null, null, 'Тер. Директор ШР', 'кассир', 'Сборщик заказа'],
  [null, null, null, 120000, 310, 280],
  ['Регион', 'ТО ПЛАН октябрь', 'ШР общая', 'Тер. Директор ШР', 'кассир', 'Сборщик заказа', 'Сборщик заказа'],
  ['М01 Милютинский', 12812500, 13.7, 1, 5.8, 1, 50400],
  ['М73 Зиларт', 13530000, 12, 1, 5.8, 0, 0],
];

/** Шаблон как в жизни: лавки, потом служебная строка с длиной окон в часах. */
function book(rows: unknown[][], { header = HEADER, shr = SHR }: { header?: unknown[]; shr?: unknown[][] | null } = {}): Buffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet([header, ...rows]), 'Шаблон по часам-пикам');
  if (shr) XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(shr), 'ШР по лавкам');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

const M1 = ['М01 Милютинский', 12812500, '10-14 млн', 'Нет', 2, 2, 3, 6, 1054, 2, 3, 3, 3, 806, 0, 0, 0, 0, 0, 1, 2, 2, 3, 651];
const M73 = ['М 73 Зиларт', 13530000, '10-14 млн', null, 2, 2, 3, 6, 1054, 2, 2, 2, 2, 620, 1, 1, 1, 2, 0, 1, 1, 2, 2, 527];
const DURATIONS = [null, null, null, null, 1, 3.5, 5, 9.5, null, 1.5, 3, 5, 9.5, null, 1.5, 3, 5, 9.5, null, 1, 3, 5, 9, null];

test('окна из заголовков: точка и запятая в часах, «до N»', () => {
  assert.deepEqual(parseWindow('6.5-7,5'), { from: 390, to: 450 });
  assert.deepEqual(parseWindow('17,5-21'), { from: 1050, to: 1260 });
  assert.deepEqual(parseWindow('до 8'), { from: null, to: 480 });
  assert.deepEqual(parseWindow('6:30 – 7:30'), { from: 390, to: 450 });
  assert.equal(parseWindow('FTE'), null);
  assert.equal(parseWindow('16-11'), null, 'конец раньше начала — не окно');
});

test('шаблон: лавки, грейд, кофемашина; план товарооборота не берётся', () => {
  const { norms, warnings } = parseStaffing(book([M1, M73, DURATIONS]));

  assert.deepEqual(warnings, []);
  assert.deepEqual(norms.map((n) => [n.code, n.name]), [['М1', 'Милютинский'], ['М73', 'Зиларт']]);
  assert.equal(norms[0].grade, '10-14 млн');
  assert.equal(norms[0].coffeeMachine, false);
  assert.equal(norms[1].coffeeMachine, null, 'пустая клетка — не «нет»');
  assert.ok(!JSON.stringify(norms).includes('12812500'), 'ТО план утёк в нормы');

  const cashier = norms[0].roles.cashier;
  assert.deepEqual(cashier.slots.map((s) => s.count), [2, 2, 3]);
  assert.equal(cashier.fte, 6);
  assert.equal(cashier.hours, 1054, '«ЧЕЛ-КО часы» относятся к должности слева');
});

test('начало окна «до 8» берётся из строки с длиной окон', () => {
  const { norms } = parseStaffing(book([M1, DURATIONS]));
  assert.equal(norms[0].roles.cook.slots[0].from, 390, 'у повара «до 8» — полтора часа, с 06:30');
  assert.equal(norms[0].roles.cleaner.slots[0].from, 420, 'у уборщика — час, с 07:00');

  // Без служебной строки начала не выдумываем.
  const bare = parseStaffing(book([M1]));
  assert.equal(bare.norms[0].roles.cook.slots[0].from, null);
  assert.ok(bare.warnings.some((w) => w.includes('с начала смены')));
});

test('калькулятор: 14:00 в М1 — окно 11–16 у каждой должности', () => {
  const [m1] = parseStaffing(book([M1, DURATIONS])).norms;
  const at = staffAt(m1, parseTimeOfDay('14:00')!);

  assert.deepEqual(
    at.map((a) => [a.role, a.count]),
    [['cashier', 3], ['cook', 3], ['barista', 0], ['cleaner', 2], ['barDeputy', 1], ['hallDeputy', 1], ['picker', 1]],
  );
  assert.equal(slotLabel(at[0].slot!), '11:00–16:00');
  assert.equal(slotShortLabel(m1.roles.cashier.slots[0]), '6:30–7:30');
  assert.equal(slotShortLabel(m1.roles.cashier.slots[2]), '11–16');
});

test('калькулятор: граница окна — уже следующее окно, вне смены — никого', () => {
  const [m1] = parseStaffing(book([M1, DURATIONS])).norms;

  const at11 = staffAt(m1, 11 * 60);
  assert.equal(at11.find((a) => a.role === 'cook')?.slot?.from, 660, 'в 11:00 действует окно 11–16');

  const early = staffAt(m1, 6 * 60);
  assert.ok(early.every((a) => a.count === 0 && a.slot === null), 'в 06:00 по шаблону ещё никого');

  const late = staffAt(m1, 23 * 60);
  assert.ok(late.every((a) => a.count === 0), 'после конца последнего окна — никого');
});

test('время и лавка из адреса', () => {
  assert.equal(parseTimeOfDay('7:05'), 425);
  assert.equal(parseTimeOfDay('24:00'), null);
  assert.equal(parseTimeOfDay('мусор'), null);

  const { norms } = parseStaffing(book([M1, M73, DURATIONS]));
  assert.equal(findStaffNorm(norms, 'м01')?.code, 'М1');
  assert.equal(findStaffNorm(norms, 'M73')?.code, 'М73', 'латинская M из раскладки');
  assert.equal(findStaffNorm(norms, 'зилар')?.code, 'М73');
  assert.equal(findStaffNorm(norms, ''), null);
});

test('замы — по одному всегда, 6:30–18:00; сборщик — по «ШР по лавкам», 7:00–16:00', () => {
  const { norms, warnings } = parseStaffing(book([M1, M73, DURATIONS]));
  assert.deepEqual(warnings, []);
  const [m1, m73] = norms;
  for (const n of norms) {
    assert.deepEqual(n.roles.barDeputy.slots, [{ from: 390, to: 1080, count: 1 }]);
    assert.deepEqual(n.roles.hallDeputy.slots, [{ from: 390, to: 1080, count: 1 }]);
  }
  assert.deepEqual(m1.roles.picker.slots, [{ from: 420, to: 960, count: 1 }]);
  assert.equal(m73.roles.picker.slots[0].count, 0);
  assert.ok(!JSON.stringify(norms).includes('50400'), 'ФОТ сборщика утёк в нормы');

  const bare = parseStaffing(book([M1, DURATIONS], { shr: null }));
  assert.equal(bare.norms[0].roles.picker.slots[0].count, 0);
  assert.ok(bare.warnings.some((w) => w.includes('ШР по лавкам')));
});

test('дислокации: строки под лавкой — посты окон, рабочие места и пометки', () => {
  const blank: unknown[] = HEADER.map(() => null);
  const posts = [...blank];
  posts[0] = '2 кассы/3 прием';
  posts[1] = 'не хватает 1 кассира';
  posts[4] = '1 кондитерка/1 кулинар';
  posts[5] = '1касса/2прием/ 1 повар разогрев';
  posts[9] = '1 прием поставки/1 приготовление продукции';
  const second = [...blank];
  second[6] = '2 прием\\1 касса';

  const { norms } = parseStaffing(book([M1, posts, second, M73, DURATIONS, posts]));
  const [m1, m73] = norms;
  const cashier = m1.roles.cashier.posts!;
  assert.deepEqual(cashier[0], [{ count: 2, place: 'кулинария' }], 'кондитерка = кулинария, места складываются');
  assert.deepEqual(cashier[1].map((p) => p.place), ['касса', 'прием', 'повар разогрев']);
  assert.deepEqual(cashier[2], [{ count: 2, place: 'прием' }, { count: 1, place: 'касса' }], 'вторая строка — то же окно');
  assert.deepEqual(m1.roles.cook.posts![0].map((p) => p.count), [1, 1]);
  assert.deepEqual(m1.layout?.stations, [{ count: 2, place: 'кассы' }, { count: 3, place: 'прием' }]);
  assert.deepEqual(m1.layout?.remarks, ['не хватает 1 кассира']);

  // Под М73 сразу идёт служебная строка, а строка-образец ниже неё — не М73.
  assert.equal(m73.layout, undefined);
  assert.equal(m73.roles.cashier.posts, undefined);
});

test('дислокации: «м81» с маленькой буквы — тоже лавка; колонки замов — только посты', () => {
  const header = [...HEADER.slice(0, 4), 'Зд бар', 'Зд зал', 'сборщик', ...HEADER.slice(4)];
  const row = (r: unknown[]) => [...r.slice(0, 4), 1, 0, 1, ...r.slice(4)];
  const m81 = row(['м81 Крылатское', ...M1.slice(1)]);
  const posts = header.map(() => null) as unknown[];
  posts[4] = '1 касса';
  posts[6] = '1 доставка';
  posts[7] = '1 выпечка';

  const { norms } = parseStaffing(book([m81, posts, row(DURATIONS)], { header }));
  assert.equal(norms[0].code, 'М81');
  assert.deepEqual(norms[0].roles.barDeputy.posts, [[{ count: 1, place: 'касса' }]]);
  assert.deepEqual(norms[0].roles.picker.posts, [[{ count: 1, place: 'доставка' }]]);
  assert.equal(norms[0].roles.hallDeputy.slots[0].count, 1, '0 в колонке «Зд зал» не отменяет константу');
  assert.deepEqual(norms[0].roles.cashier.posts![0], [{ count: 1, place: 'выпечка' }]);
});
