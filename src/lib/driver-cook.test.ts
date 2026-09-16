import test from 'node:test';
import assert from 'node:assert/strict';
import { analyzeDriverCook, isSuspicious, markSeconds } from './driver-cook';
import type { AttendanceRow, CriterionKey } from './types';

function mark(
  date: string,
  shopCode: string,
  criterion: CriterionKey,
  role: string,
  name: string,
  time: string,
  extra: Partial<AttendanceRow> = {},
): AttendanceRow {
  const [h, m] = time.split(':').map(Number);
  const [dd, mm, yyyy] = [date.slice(8), date.slice(5, 7), date.slice(0, 4)];
  return {
    date,
    shopCode,
    shopName: `${shopCode} Тестовая`,
    employeeName: name,
    role,
    criterion,
    trainee: false,
    homeShopCode: null,
    arrivalMinutes: h * 60 + m,
    arrivalSource: 'mark',
    rawArrival: `${dd}.${mm}.${yyyy} ${time}`,
    rawDeparture: null,
    status: 'green',
    note: null,
    ...extra,
  };
}

test('водитель раньше первого повара — своя категория', () => {
  const r = analyzeDriverCook(
    [
      mark('2026-09-01', 'М1', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:00:00'),
      mark('2026-09-01', 'М1', 'cook', 'Повар', 'Повар Б', '6:20:00'),
    ],
    '2026-09-01',
    '2026-09-16',
  );

  assert.equal(r.pairs.length, 1);
  assert.equal(r.pairs[0].bucket, 'driver_before');
  assert.equal(r.pairs[0].deltaMinutes, 20);
  assert.equal(r.pairs[0].driverFirst, true);
  assert.equal(r.summary.byBucket.driver_before, 1);
});

test('разница меньше минуты — «одновременно», в любую сторону', () => {
  const r = analyzeDriverCook(
    [
      mark('2026-09-02', 'М2', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:02:43'),
      mark('2026-09-02', 'М2', 'cook', 'Повар', 'Повар Б', '6:02:25'),
    ],
    '2026-09-01',
    '2026-09-16',
  );

  assert.equal(r.pairs[0].bucket, 'simultaneous');
  // Секунды не теряются: −18 секунд, а не «ровно одно время».
  assert.equal(r.pairs[0].deltaMinutes, -0.3);
  assert.equal(isSuspicious(r.pairs[0]), true);
});

test('разрыв до пяти минут подозрителен, только если лавка была пустой', () => {
  const rows = [
    mark('2026-09-03', 'М3', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:00:00'),
    mark('2026-09-03', 'М3', 'cook', 'Повар', 'Повар Б', '5:57:00'),
  ];

  const alone = analyzeDriverCook(rows, '2026-09-01', '2026-09-16');
  assert.equal(alone.pairs[0].bucket, 'cook_before_close');
  assert.equal(alone.pairs[0].aloneAtOpen, true);
  assert.equal(isSuspicious(alone.pairs[0]), true);

  const withCashier = analyzeDriverCook(
    [...rows, mark('2026-09-03', 'М3', 'cashier', 'Кассир', 'Кассир В', '5:40:00')],
    '2026-09-01',
    '2026-09-16',
  );
  assert.equal(withCashier.pairs[0].aloneAtOpen, false);
  assert.equal(withCashier.pairs[0].precedingMark, 'Кассир 05:40:00');
  assert.equal(isSuspicious(withCashier.pairs[0]), false);
});

test('до пары считается кто угодно, даже уборщик без критерия', () => {
  const r = analyzeDriverCook(
    [
      mark('2026-09-04', 'М4', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:00:00'),
      mark('2026-09-04', 'М4', 'cook', 'Повар', 'Повар Б', '6:00:20'),
      { ...mark('2026-09-04', 'М4', 'cook', 'Уборщик', 'Уборщик Г', '5:30:00'), criterion: null },
    ],
    '2026-09-01',
    '2026-09-16',
  );

  assert.equal(r.pairs[0].bucket, 'simultaneous');
  assert.equal(r.pairs[0].aloneAtOpen, false);
  assert.equal(r.pairs[0].precedingMark, 'Уборщик 05:30:00');
});

test('время из журнала отгрузок и досчёт «−30 минут» в сверку не идут', () => {
  const r = analyzeDriverCook(
    [
      {
        ...mark('2026-09-05', 'М5', 'driver', 'Водитель', 'Отгрузка по маршруту', '8:36:00'),
        arrivalSource: 'delivery',
        rawArrival: '8:36',
      },
      mark('2026-09-05', 'М5', 'cook', 'Повар', 'Повар Б', '8:36:00'),
      {
        ...mark('2026-09-05', 'М6', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:00:00'),
        arrivalSource: 'derived_minus30',
      },
      mark('2026-09-05', 'М6', 'cook', 'Повар', 'Повар Б', '6:00:10'),
    ],
    '2026-09-01',
    '2026-09-16',
  );

  assert.equal(r.pairs.length, 0);
  assert.equal(r.summary.skipped, 2);
});

test('берётся первый повар и первый водитель за день, а не любые', () => {
  const r = analyzeDriverCook(
    [
      mark('2026-09-06', 'М7', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:10:00'),
      mark('2026-09-06', 'М7', 'cook', 'Повар', 'Повар Ранний', '6:09:30'),
      mark('2026-09-06', 'М7', 'cook', 'Повар', 'Повар Поздний', '9:00:00'),
    ],
    '2026-09-01',
    '2026-09-16',
  );

  assert.equal(r.pairs[0].cookName, 'Повар Ранний');
  assert.equal(r.pairs[0].bucket, 'simultaneous');
});

test('период отсекается по краям включительно', () => {
  const rows = ['2026-08-31', '2026-09-01', '2026-09-16', '2026-09-17'].flatMap((d) => [
    mark(d, 'М8', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:00:00'),
    mark(d, 'М8', 'cook', 'Повар', 'Повар Б', '6:00:30'),
  ]);

  const r = analyzeDriverCook(rows, '2026-09-01', '2026-09-16');
  assert.deepEqual(
    r.pairs.map((p) => p.date),
    ['2026-09-01', '2026-09-16'],
  );
});

test('сводка по лавкам и водителям считает подозрительные пары', () => {
  const rows = ['2026-09-01', '2026-09-02', '2026-09-03'].flatMap((d) => [
    mark(d, 'М24', 'driver', 'Водитель-экспедитор', 'Фокин А. А.', '6:03:00'),
    mark(d, 'М24', 'cook', 'Повар', 'Повар Б', '6:02:40'),
  ]);

  const r = analyzeDriverCook(rows, '2026-09-01', '2026-09-16');
  assert.equal(r.byShop[0].key, 'М24');
  assert.equal(r.byShop[0].simultaneous, 3);
  assert.equal(r.byShop[0].alone, 3);
  assert.equal(r.byDriver[0].key, 'Фокин А. А.');
  assert.equal(r.byDriver[0].alone, 3);
  assert.equal(r.byDate.length, 3);
});

test('секунды берутся из сырой отметки, а не из округлённых минут', () => {
  const row = mark('2026-09-07', 'М9', 'cook', 'Повар', 'Повар Б', '6:02:25');
  assert.equal(markSeconds(row), 6 * 3600 + 2 * 60 + 25);
  assert.equal(markSeconds({ ...row, rawArrival: '07.09.2026 6:02' }), 6 * 3600 + 2 * 60);
  assert.equal(markSeconds({ ...row, rawArrival: null }), null);
});

test('незаданные параметры не затирают пороги по умолчанию', () => {
  const r = analyzeDriverCook(
    [
      mark('2026-09-08', 'М10', 'driver', 'Водитель-экспедитор', 'Водитель А', '6:00:00'),
      mark('2026-09-08', 'М10', 'cook', 'Повар', 'Повар Б', '6:00:30'),
    ],
    '2026-09-01',
    '2026-09-16',
    { simultaneousSeconds: undefined, closeMinutes: undefined },
  );

  assert.equal(r.options.simultaneousSeconds, 60);
  assert.equal(r.options.closeMinutes, 5);
  assert.equal(r.pairs[0].bucket, 'simultaneous');
});
