import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';
import {
  analyzeDepartures,
  analyzeViolations,
  kindsOf,
  type ShopDay,
} from './violations';
import type { AttendanceRow, CriterionKey, ShopNorms } from './types';
import type { DepartureRow } from './parsers/departure';

const config = loadConfig();

/** М24: водитель к 6:00, повара — к 6:00 и 6:30. */
const NORMS: Record<string, ShopNorms> = {
  М24: {
    code: 'М24',
    name: 'Стремянный',
    driverAt: '06:00',
    cookAt: ['06:00', '06:30'],
    rawDriver: '6:00',
    rawCook: '2 с 6:00 1 с 6:30',
    source: 'reference',
    warnings: [],
  },
};

function mark(
  shopCode: string,
  criterion: CriterionKey | null,
  role: string,
  name: string,
  time: string,
  date = '2026-09-01',
): AttendanceRow {
  const [h, m, sec] = time.split(':').map(Number);
  return {
    date,
    shopCode,
    shopName: `${shopCode} Стремянный`,
    employeeName: name,
    role,
    criterion,
    trainee: false,
    homeShopCode: null,
    arrivalMinutes: h * 60 + m,
    arrivalSource: 'mark',
    rawArrival: `${date.slice(8)}.${date.slice(5, 7)}.${date.slice(0, 4)} ${h}:${String(m).padStart(2, '0')}:${String(sec ?? 0).padStart(2, '0')}`,
    rawDeparture: null,
    status: 'green',
    note: null,
  };
}

function run(rows: AttendanceRow[], from = '2026-09-01', to = '2026-09-15'): ShopDay[] {
  return analyzeViolations(rows, NORMS, config, from, to).days;
}

test('2. водитель вовремя, а отметка сотрудника легла на его собственную', () => {
  const [day] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '5:58:10'),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '5:58:22'),
  ]);

  assert.equal(day.staffMissing, true);
  assert.equal(day.staffGapSeconds, 12);
  assert.equal(day.driverLateBy, -2, 'водитель приехал за две минуты до нормы');
  assert.deepEqual(kindsOf(day), ['driver_on_time_no_staff']);
});

test('минута — граница: ровно 60 секунд это уже «сотрудник был»', () => {
  const [ok] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '5:58:00'),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '5:59:00'),
  ]);
  assert.equal(ok.staffMissing, false, '60 секунд — это уже разрыв в минуту');

  const [gone] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '5:58:00'),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '5:58:59'),
  ]);
  assert.equal(gone.staffMissing, true);
});

test('3. сотрудник был, водитель опоздал — считаем минуты от нормы лавки', () => {
  const [day] = run([
    mark('М24', 'cook', 'Повар', 'Повар Первый', '5:50:00'),
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '6:17:00'),
  ]);

  assert.equal(day.staffMissing, false);
  assert.equal(day.driverNorm, '06:00');
  assert.equal(day.driverNormFromShop, true);
  assert.equal(day.driverLateBy, 17);
  assert.deepEqual(kindsOf(day), ['driver_late']);
});

test('опоздал и сотрудника не было — это отдельный случай, а не два', () => {
  const [day] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '6:20:00'),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '6:20:15'),
  ]);

  assert.equal(day.staffMissing, true);
  assert.equal(day.driverLateBy, 20);
  // Иначе один и тот же день попал бы и во вторую категорию, и в третью,
  // а сумма по категориям перестала бы сходиться с числом дней.
  assert.deepEqual(kindsOf(day), ['no_staff_driver_late', 'cook_late']);
});

test('4. повара сравниваются каждый со своей нормой, а не все с первой', () => {
  const [day] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '5:50:00'),
    // Первый повар по норме 6:00 — успел. Второй по норме 6:30 — опоздал на 12.
    mark('М24', 'cook', 'Повар', 'Повар Ранний', '5:57:00'),
    mark('М24', 'cook', 'Повар', 'Повар Поздний', '6:42:00'),
  ]);

  assert.deepEqual(kindsOf(day), ['cook_late']);
  assert.equal(day.lateCooks.length, 1);
  assert.equal(day.lateCooks[0].name, 'Повар Поздний');
  assert.equal(day.lateCooks[0].norm, '06:30');
  assert.equal(day.lateCooks[0].lateBy, 12);
  assert.equal(day.lateCooks[0].status, 'yellow');
});

test('первым сотрудником может быть кассир или директор, а не только повар', () => {
  const [day] = run([
    mark('М24', 'cashier', 'Кассир', 'Кассир Ранний', '5:40:00'),
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '5:55:00'),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '5:58:00'),
  ]);

  assert.equal(day.staff?.name, 'Кассир Ранний');
  assert.equal(day.staff?.role, 'Кассир');
  assert.equal(day.staffMissing, false);
});

test('директор без критерия радара — тоже сотрудник в лавке', () => {
  const [day] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '5:55:00'),
    { ...mark('М24', 'cook', 'Директор', 'Директор Ранний', '5:30:00'), criterion: null },
  ]);

  assert.equal(day.staff?.role, 'Директор');
  assert.equal(day.staffMissing, false);
});

test('лавка без нормы считается по сетевому порогу, а не выпадает из счёта', () => {
  const rows = [
    mark('М99', 'driver', 'Водитель-экспедитор', 'Водитель Б', '6:40:00'),
    mark('М99', 'cook', 'Повар', 'Повар В', '6:00:00'),
  ];
  const [day] = analyzeViolations(rows, NORMS, config, '2026-09-01', '2026-09-15').days;

  assert.equal(day.driverNormFromShop, false);
  assert.equal(day.driverNorm, config.criteria.driver.kind === 'time' ? config.criteria.driver.greenUntil : '');
  assert.ok(day.driverLateBy != null && day.driverLateBy > 0);
  assert.deepEqual(kindsOf(day), ['driver_late']);
});

test('«другой график» — не нарушение: это вторая смена, а не опоздание', () => {
  const [day] = run([
    mark('М24', 'driver', 'Водитель-экспедитор', 'Осипов Сергей', '14:10:00'),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '14:10:20'),
  ]);

  assert.equal(day.skipped, true);
  assert.deepEqual(kindsOf(day), [], 'вечерняя смена не должна считаться опозданием');
});

test('день без отметки водителя в счёт нарушений не идёт, но виден в сводке', () => {
  const r = analyzeViolations(
    [mark('М24', 'cook', 'Повар', 'Повар Первый', '6:40:00')],
    NORMS,
    config,
    '2026-09-01',
    '2026-09-15',
  );

  assert.equal(r.summary.checked, 0);
  assert.equal(r.summary.noDriverMark, 1);
  assert.equal(r.summary.byKind.cook_late, 0, 'день без водителя не проверяется целиком');
});

test('восстановленное время в сверку не идёт', () => {
  const rows: AttendanceRow[] = [
    {
      ...mark('М24', 'driver', 'Водитель', 'Отгрузка по маршруту', '8:36:00'),
      arrivalSource: 'delivery',
      rawArrival: '8:36',
    },
    mark('М24', 'cook', 'Повар', 'Повар Первый', '8:36:00'),
  ];
  const [day] = analyzeViolations(rows, NORMS, config, '2026-09-01', '2026-09-15').days;

  assert.equal(day.driver, null, 'время из журнала отгрузок не отметка');
});

test('сводка: сумма по категориям сходится с числом проверенных дней', () => {
  const r = analyzeViolations(
    [
      // вовремя, сотрудник был — нарушений нет
      mark('М24', 'driver', 'Водитель-экспедитор', 'Водитель А', '5:50:00', '2026-09-01'),
      mark('М24', 'cook', 'Повар', 'Повар Первый', '5:40:00', '2026-09-01'),
      // сотрудника не было
      mark('М24', 'driver', 'Водитель-экспедитор', 'Водитель А', '5:50:00', '2026-09-02'),
      mark('М24', 'cook', 'Повар', 'Повар Первый', '5:50:10', '2026-09-02'),
      // водитель опоздал
      mark('М24', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:30:00', '2026-09-03'),
      mark('М24', 'cook', 'Повар', 'Повар Первый', '5:45:00', '2026-09-03'),
    ],
    NORMS,
    config,
    '2026-09-01',
    '2026-09-15',
  );

  assert.equal(r.summary.checked, 3);
  assert.equal(r.summary.byKind.driver_on_time_no_staff, 1);
  assert.equal(r.summary.byKind.driver_late, 1);
  assert.equal(r.byShop[0].key, 'М24');
  assert.equal(r.byShop[0].days, 3);
  assert.equal(r.byDriver[0].key, 'Водитель А');
  assert.equal(r.byDate.length, 3);
});

test('период отсекается по краям включительно', () => {
  const rows = ['2026-08-31', '2026-09-01', '2026-09-15', '2026-09-16'].flatMap((d) => [
    mark('М24', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:30:00', d),
    mark('М24', 'cook', 'Повар', 'Повар Первый', '5:45:00', d),
  ]);

  const r = analyzeViolations(rows, NORMS, config, '2026-09-01', '2026-09-15');
  assert.deepEqual(
    r.days.map((d) => d.date),
    ['2026-09-01', '2026-09-15'],
  );
});

/* ---------------------------- выезд с РЦ ---------------------------------- */

function departure(name: string, time: string | null, date = '2026-09-01'): DepartureRow {
  const minutes = time ? Number(time.split(':')[0]) * 60 + Number(time.split(':')[1]) : null;
  return {
    date,
    employeeName: name,
    unit: 'РЦ Свобода',
    role: 'Водитель-экспедитор',
    departureMinutes: minutes,
    arrivalMinutes: minutes == null ? null : minutes - 90,
    rawDeparture: time,
  };
}

test('1. выезд с РЦ: позже норматива — нарушение, зона по правилу конфига', () => {
  const r = analyzeDepartures(
    [
      departure('Вовремя Иван', '04:40'),
      departure('Граница Пётр', '04:59'),
      departure('Жёлтый Семён', '05:15'),
      departure('Красный Борис', '05:45'),
      departure('Без отметки Глеб', null),
    ],
    config,
    '2026-09-01',
    '2026-09-15',
  );

  assert.equal(r.checked, 4, 'без отметки в знаменатель не идёт');
  assert.equal(r.greenUntil, '04:59');
  assert.equal(r.yellow, 1);
  assert.equal(r.red, 1);
  assert.deepEqual(
    r.late.map((l) => l.employeeName),
    ['Красный Борис', 'Жёлтый Семён'],
    'худшие сверху',
  );
  assert.equal(r.late[0].lateBy, 46);
  assert.equal(r.late[0].time, '05:45');
});

test('выезда за период нет — это видно отдельно от «нарушений нет»', () => {
  const empty = analyzeDepartures([], config, '2026-09-01', '2026-09-15');
  assert.equal(empty.hasData, false);
  assert.equal(empty.late.length, 0);

  const clean = analyzeDepartures([departure('Вовремя Иван', '04:30')], config, '2026-09-01', '2026-09-15');
  assert.equal(clean.hasData, true);
  assert.equal(clean.late.length, 0);
});

test('выезд вне периода в отчёт не попадает', () => {
  const r = analyzeDepartures(
    [departure('Поздний Гость', '06:00', '2026-08-31'), departure('Наш Водитель', '06:00', '2026-09-02')],
    config,
    '2026-09-01',
    '2026-09-15',
  );

  assert.equal(r.checked, 1);
  assert.deepEqual(r.late.map((l) => l.employeeName), ['Наш Водитель']);
});

test('сводка отделяет красную зону от жёлтой: минута и час — разные новости', () => {
  const r = analyzeViolations(
    [
      // +3 минуты к норме 6:00 — жёлтая зона (шаг 15 минут).
      mark('М24', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:03:00', '2026-09-01'),
      mark('М24', 'cook', 'Повар', 'Повар Первый', '5:40:00', '2026-09-01'),
      // +40 минут — красная.
      mark('М24', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:40:00', '2026-09-02'),
      mark('М24', 'cook', 'Повар', 'Повар Первый', '5:40:00', '2026-09-02'),
    ],
    NORMS,
    config,
    '2026-09-01',
    '2026-09-15',
  );

  assert.equal(r.summary.byKind.driver_late, 2);
  assert.equal(r.summary.driverLateRed, 1);
  assert.equal(r.days[0].driverStatus, 'yellow');
  assert.equal(r.days[1].driverStatus, 'red');
});
