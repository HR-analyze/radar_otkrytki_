import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadConfig } from '../config';
import { parseAttendanceBuffer } from './attendance';
import { parseLegacyVitriny } from './legacy-vitriny';
import { parseDeliveryTimes } from './delivery';
import { parseRoster, personName } from './roster';
import { mergeDeliveryTimes } from '../delivery-merge';
import type { AttendanceRow } from '../types';
import { gridToFills } from '../connectors/google-sheets';

const config = loadConfig();
const fx = (name: string) => fs.readFileSync(path.join(process.cwd(), 'fixtures', name));

test('парсер выгрузки сотрудников: строка «Итого» не становится лавкой', () => {
  const r = parseAttendanceBuffer(fx('2026-08-25_vyhody.xls'), config);
  assert.equal(r.rows.length, 336, 'все строки кроме «Итого»');
  assert.deepEqual(r.dates, ['2026-08-25']);
  assert.ok(!r.rows.some((x) => /итого/i.test(x.shopCode) || /итого/i.test(x.shopName)));
});

test('парсер выгрузки: все должности распознаны, лишних предупреждений нет', () => {
  const r = parseAttendanceBuffer(fx('2026-08-25_vyhody.xls'), config);
  const unknown = r.warnings.filter((w) => w.kind === 'unknown_role');
  assert.equal(unknown.length, 0, unknown.map((w) => w.message).join('\n'));
  assert.ok(r.rows.every((x) => x.criterion !== null));
});

test('парсер выгрузки: расхождение подразделений попадает в предупреждения', () => {
  const r = parseAttendanceBuffer(fx('2026-08-25_vyhody.xls'), config);
  const mismatch = r.warnings.filter((w) => w.kind === 'shop_mismatch');
  assert.equal(mismatch.length, 29);
  // Сотрудник числится в одной лавке, отметился в другой — обе видны в строке.
  const row = r.rows.find((x) => x.homeShopCode && x.homeShopCode !== x.shopCode);
  assert.ok(row, 'должна быть хотя бы одна такая строка');
});

test('парсер выгрузки водителей: «Уход» заполнен, досчёт срабатывает', () => {
  const r = parseAttendanceBuffer(fx('2026-08-25_voditeli.xls'), config);
  assert.equal(r.rows.length, 63);
  assert.ok(r.rows.every((x) => x.criterion === 'driver'));

  const derived = r.rows.filter((x) => x.arrivalSource === 'derived_minus30');
  assert.equal(derived.length, 5, 'пять водителей без «Прихода», но с «Уходом»');
  for (const d of derived) assert.ok(d.arrivalMinutes != null);
});

test('новый формат 1С: две строки на человека разбираются как отметки', () => {
  // С 29.08.2026 выгрузка приходит с группировкой: шапка в две строки, строка
  // сотрудника и отдельные строки отметок под ней.
  const r = parseAttendanceBuffer(fx('2026-08-29_vyhody.xls'), config);

  assert.equal(r.layout, 'paired');
  assert.equal(r.rows.length, 1004);
  assert.deepEqual(r.dates, ['2026-08-29', '2026-08-30']); // две отметки ночной смены
  assert.ok(!r.rows.some((x) => /итого/i.test(x.shopCode) || /итого/i.test(x.shopName)));
  assert.ok(r.rows.every((x) => x.employeeName !== ''), 'ФИО берётся из строки сотрудника');
});

test('старый формат по-прежнему читается и отличается от нового', () => {
  assert.equal(parseAttendanceBuffer(fx('2026-08-28_vyhody.xls'), config).layout, 'flat');
  assert.equal(parseAttendanceBuffer(fx('2026-08-30_vyhody.xlsx'), config).layout, 'paired');
});

test('новый формат: у водителя несколько лавок за смену — это разные отметки', () => {
  // В плоском формате каждая лавка была отдельной строкой; в парном строки
  // отметок идут списком под одним водителем, и терять их нельзя.
  const r = parseAttendanceBuffer(fx('2026-08-30_voditeli.xls'), config);
  assert.ok(r.rows.every((x) => x.criterion === 'driver'));

  const shopsByDriver = new Map<string, Set<string>>();
  for (const row of r.rows) {
    const set = shopsByDriver.get(row.employeeName) ?? new Set<string>();
    set.add(row.shopCode);
    shopsByDriver.set(row.employeeName, set);
  }
  const multi = [...shopsByDriver.values()].filter((s) => s.size > 1);
  assert.ok(multi.length >= 15, `водители с несколькими лавками: ${multi.length}`);
});

test('должности вне критериев радара не считаются пробелом в настройке', () => {
  // Уборщик и директор в выгрузке есть, но ни к одному критерию не относятся:
  // предупреждение «должность не найдена» должно означать реальный пробел.
  const r = parseAttendanceBuffer(fx('2026-08-30_vyhody.xlsx'), config);
  const unknown = r.warnings.filter((w) => w.kind === 'unknown_role');
  assert.deepEqual(unknown.map((w) => w.message), []);

  const ignored = r.rows.filter((x) => x.role === 'Уборщик');
  assert.ok(ignored.length > 0, 'строки уборщиков разбираются');
  assert.ok(ignored.every((x) => x.criterion === null), 'но ни на какой критерий не влияют');
});

test('парсер легаси-книги: лавки, даты и дедупликация людей', () => {
  const r = parseLegacyVitriny(fx('vitriny.xlsx'), config);
  assert.equal(r.shops.length, 80);
  // Даты не перечисляем: книгу заливают заново каждые несколько дней, и тест
  // не должен краснеть от того, что данных стало больше.
  assert.equal(r.dates[0], '2026-08-19');
  assert.ok(r.dates.length >= 10, `дней в книге: ${r.dates.length}`);
  assert.deepEqual([...r.dates].sort(), r.dates, 'даты отсортированы');
  // В книге блоки сотрудников местами продублированы (М2 Покровка), а у
  // М23 Добрынинский два блока целиком — дублей на выходе быть не должно.
  const keys = r.people.map((p) => `${p.date}|${p.shopCode}|${p.criterion}|${p.employeeName}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('парсер легаси-книги: конфликт значений не проглатывается молча', () => {
  const r = parseLegacyVitriny(fx('vitriny.xlsx'), config);
  // У М23 Добрынинский за 20.08 в двух блоках стоят 0.85 и 0.9.
  assert.equal(r.warnings.length, 1, r.warnings.join('\n'));
  assert.match(r.warnings[0], /М23.*два разных значения наполнения/);

  // Конфликтующие даты не задваиваются в выдаче.
  const keys = r.showcase.map((s) => `${s.date}|${s.shopCode}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('парсер легаси-книги: наполнение витрины пересчитывается по текущим порогам', () => {
  const r = parseLegacyVitriny(fx('vitriny.xlsx'), config);
  assert.ok(r.showcase.length > 100);
  for (const s of r.showcase) {
    assert.ok(s.fill >= 0 && s.fill <= 1, `доля вне диапазона: ${s.fill}`);
    if (s.fill >= 0.95) assert.equal(s.status, 'green');
    else if (s.fill >= 0.85) assert.equal(s.status, 'yellow');
    else assert.equal(s.status, 'red');
  }
});

test('парсер легаси-книги: у каждой лавки есть РМ', () => {
  const r = parseLegacyVitriny(fx('vitriny.xlsx'), config);
  assert.ok(r.shops.every((s) => s.region), 'РМ должен быть заполнен у всех лавок');
});

test('Google Таблица: сетка разбирается в значения по лавкам и датам', () => {
  const grid = [
    ['Лавка', '25.08.2026', '26.08.2026'],
    ['М1 Милютинский', 0.95, '87%'],
    ['М2 Покровка', '', 100],
    ['', 0.5, 0.5], // строка без лавки игнорируется
  ];
  const fills = gridToFills(grid);
  assert.deepEqual(fills, [
    { shop: 'М1 Милютинский', date: '2026-08-25', value: 0.95 },
    { shop: 'М1 Милютинский', date: '2026-08-26', value: '87%' },
    { shop: 'М2 Покровка', date: '2026-08-26', value: 100 },
  ]);
});

test('Google Таблица: без колонок-дат возвращается пусто, а не мусор', () => {
  assert.deepEqual(gridToFills([['Лавка', 'что-то', 'ещё'], ['М1', 1, 2]]), []);
  assert.deepEqual(gridToFills([]), []);
});

test('Job наполнения витрин терпит ручной ввод: «95», «0,95», «95%»', async () => {
  // Джоба пишет в БД, поэтому уводим её на временный файл: рабочая база и её
  // журнал запусков не должны меняться от прогона тестов.
  const tmpDb = path.join(
    os.tmpdir(),
    `radar-test-${process.pid}-${Date.now()}`,
    'radar.db',
  );
  const prev = process.env.RADAR_DB_PATH;
  process.env.RADAR_DB_PATH = tmpDb;

  try {
    // Импорт после подмены пути: db.ts читает переменную при загрузке модуля.
    const { runShowcaseJob } = await import('../etl/showcase-job');
    const r = runShowcaseJob(
      [
        { shop: 'М1 Милютинский', date: '2099-01-01', value: 95 },
        { shop: 'М2 Покровка', date: '2099-01-01', value: '0,95' },
        { shop: 'М3 Пресня', date: '2099-01-01', value: '87%' },
        { shop: 'М4 Спиридоновка', date: '2099-01-01', value: '' },
        { shop: 'Итого', date: '2099-01-01', value: 90 },
      ],
      'unit-test',
    );
    assert.equal(r.rows, 3);
    assert.equal(r.skipped, 2, 'пустое значение и строка «Итого»');
    assert.ok(fs.existsSync(tmpDb), 'джоба должна была писать во временную БД');
  } finally {
    if (prev === undefined) delete process.env.RADAR_DB_PATH;
    else process.env.RADAR_DB_PATH = prev;
    fs.rmSync(path.dirname(tmpDb), { recursive: true, force: true });
  }
});

test('справочник лавок: объединённые ячейки разворачиваются на весь блок', () => {
  // Один РМ отвечает за 9–11 лавок подряд, и в файле это одна ячейка на блок.
  // Без разворота 9 лавок из 10 остались бы без менеджера.
  const r = parseRoster(fx('spravochnik-lavok.xlsx'));

  assert.equal(r.rows.length, 83);
  assert.equal(r.managers.length, 8);
  assert.ok(r.rows.filter((x) => x.manager).length >= 80, 'РМ проставлен почти у всех лавок');

  const byManager = new Map<string, number>();
  for (const row of r.rows) {
    if (row.manager) byManager.set(row.manager, (byManager.get(row.manager) ?? 0) + 1);
  }
  for (const [manager, count] of byManager) {
    assert.ok(count > 1, `${manager}: ${count} — блок не развернулся`);
  }
});

test('справочник лавок: «М09» и «М9» — одна лавка', () => {
  // В справочнике коды пишут с ведущим нулём, в выгрузках 1С — без него.
  const r = parseRoster(fx('spravochnik-lavok.xlsx'));
  const codes = r.rows.map((x) => x.shopCode);

  assert.ok(codes.includes('М9'), 'код нормализован');
  assert.ok(!codes.some((c) => /^[А-Я]+0\d/.test(c)), 'ведущих нулей не осталось');
});

test('справочник лавок: пометка вместо имени не становится менеджером', () => {
  const r = parseRoster(fx('spravochnik-lavok.xlsx'));

  assert.ok(!r.managers.some((m) => /закрыт/i.test(m)), 'ЛАВКА ЗАКРЫТА — не менеджер');
  assert.match(r.warnings.join('\n'), /не имя/);
});

test('имя РМ вынимается из ячейки с телефоном и почтой', () => {
  assert.equal(personName('Шевкун Виктория 8 (916) 253-08-23 v.shevkun@karavaevi.ru'), 'Шевкун Виктория');
  assert.equal(personName('Малаева Анна 89645372031 <malaeva.a@neftm.ru>'), 'Малаева Анна');
  assert.equal(personName('Ярцева Олеся 8 (977) 832-72-78\nO.yarceva@karavaevi.ru'), 'Ярцева Олеся');
  assert.equal(personName('ЛАВКА ЗАКРЫТА !!!!!'), null);
  assert.equal(personName(''), null);
  assert.equal(personName('Осин'), null, 'одной фамилии мало — это может быть что угодно');
});

test('журнал отгрузок: даты берутся из шапки, сломанные колонки пропускаются', () => {
  const r = parseDeliveryTimes(fx('vremya-postavki.xlsx'));

  assert.ok(r.rows.length > 1000, `строк всего ${r.rows.length}`);
  assert.ok(r.dates.includes('2026-08-19'), 'нет 19.08 — дня, ради которого журнал и нужен');
  for (const d of r.dates) assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `битая дата ${d}`);

  // В файле полсотни колонок с нечитаемой датой (формат времени вместо даты) —
  // они должны быть пропущены, а не превратиться в даты 1899 года.
  assert.ok(
    r.warnings.some((w) => /нечитаемой датой/.test(w)),
    'предупреждение про сломанную шапку потерялось',
  );
  assert.ok(r.dates.every((d) => d >= '2026-01-01'), 'в датах есть мусор из шапки');

  for (const row of r.rows) {
    assert.ok(row.minutes >= 0 && row.minutes < 24 * 60, `время вне суток: ${row.raw}`);
    assert.match(row.shopCode, /^[А-Я]\d+$/, `код лавки не нормализован: ${row.shopCode}`);
  }
});

test('подстановка отгрузок: только там, где нет отметки face id', () => {
  const config = loadConfig();
  const driver = (shopCode: string, arrivalMinutes: number | null): AttendanceRow => ({
    date: '2026-08-19',
    shopCode,
    shopName: shopCode,
    employeeName: `Водитель ${shopCode}`,
    role: 'Водитель-экспедитор',
    criterion: 'driver',
    trainee: false,
    homeShopCode: null,
    arrivalMinutes,
    arrivalSource: arrivalMinutes == null ? 'none' : 'mark',
    rawArrival: null,
    rawDeparture: null,
    status: arrivalMinutes == null ? 'red' : 'green',
    note: null,
  });

  const attendance = [driver('М1', 5 * 60 + 50), driver('М2', null)];
  const delivery = [
    { date: '2026-08-19', shopCode: 'М1', minutes: 7 * 60, raw: '7:00' },
    { date: '2026-08-19', shopCode: 'М2', minutes: 6 * 60 + 20, raw: '6:20' },
    { date: '2026-08-19', shopCode: 'М3', minutes: 6 * 60 + 40, raw: '6:40' },
    { date: '2026-07-01', shopCode: 'М3', minutes: 6 * 60, raw: '6:00' },
  ];

  const merged = mergeDeliveryTimes(
    attendance,
    delivery,
    new Set(['2026-08-19']),
    new Map([['М3', 'М3 Пресня']]),
    config,
  );

  assert.equal(merged.applied, 2, 'подставить нужно М2 (нет времени) и М3 (нет строки вовсе)');
  assert.equal(merged.skippedDates, 1, 'дата вне периода данных должна быть отброшена');

  // У М1 отметка есть — журнал не трогает её.
  const m1 = merged.rows.filter((r) => r.shopCode === 'М1');
  assert.equal(m1.length, 1);
  assert.equal(m1[0].arrivalSource, 'mark');
  assert.equal(m1[0].arrivalMinutes, 5 * 60 + 50);

  // У М2 строка водителя без отметки уходит в «нет данных», статус даёт подстановка.
  const m2 = merged.rows.filter((r) => r.shopCode === 'М2');
  assert.equal(m2.length, 2);
  assert.equal(m2.find((r) => r.arrivalSource === 'none')?.status, 'no_data');
  assert.equal(merged.suppressed, 1);
  const substituted = m2.find((r) => r.arrivalSource === 'delivery');
  assert.equal(substituted?.arrivalMinutes, 6 * 60 + 20);
  assert.equal(substituted?.status, 'yellow', '6:20 у водителя — жёлтая зона (🟢 только до 6:09)');

  // Имя лавки подтягивается из справочника, если оно известно.
  assert.equal(merged.rows.find((r) => r.shopCode === 'М3')?.shopName, 'М3 Пресня');
});
