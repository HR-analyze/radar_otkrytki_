import test from 'node:test';
import assert from 'node:assert/strict';
import { loadConfig } from './config';
import {
  aggregateStatuses,
  averageScore,
  mapRole,
  resolveArrival,
  statusForFill,
  statusForTime,
  statusFromScore,
  worstStatus,
  normalizeFill,
} from './status';
import { dedupeAttendance, rollUpAttendance } from './rollup';
import type { AttendanceRow, Status } from './types';
import { parseShop, normalizeCode } from './shops';
import { CRITERION_ORDER } from './types';
import { parseClock, parseStamp, formatClock, dateRange } from './time';

const config = loadConfig();
const at = (h: number, m: number) => h * 60 + m;

test('пороги повара по листу: 🟢 до 6:00, 🟡 6:01–6:10, 🔴 6:11+', () => {
  assert.equal(statusForTime(at(5, 30), 'cook', config), 'green');
  assert.equal(statusForTime(at(6, 0), 'cook', config), 'green');
  assert.equal(statusForTime(at(6, 1), 'cook', config), 'yellow');
  assert.equal(statusForTime(at(6, 10), 'cook', config), 'yellow');
  assert.equal(statusForTime(at(6, 11), 'cook', config), 'red');
});

test('пороги кассира и бариста совпадают: 🟢 до 7:00, 🟡 7:01–7:10', () => {
  for (const c of ['cashier', 'barista'] as const) {
    assert.equal(statusForTime(at(7, 0), c, config), 'green');
    assert.equal(statusForTime(at(7, 1), c, config), 'yellow');
    assert.equal(statusForTime(at(7, 10), c, config), 'yellow');
    assert.equal(statusForTime(at(7, 11), c, config), 'red');
  }
});

test('водитель: 🟢 до 6:09, 🟡 6:10–6:30, 🔴 с 6:31', () => {
  assert.equal(statusForTime(at(5, 30), 'driver', config), 'green');
  assert.equal(statusForTime(at(6, 9), 'driver', config), 'green');
  assert.equal(statusForTime(at(6, 10), 'driver', config), 'yellow');
  assert.equal(statusForTime(at(6, 30), 'driver', config), 'yellow');
  // 6:31 в формулировке заказчика попадал и в жёлтую, и в красную — красная выигрывает.
  assert.equal(statusForTime(at(6, 31), 'driver', config), 'red');
});

test('зоны не пересекаются и не оставляют разрывов ни у одного критерия', () => {
  for (const key of ['driver', 'cook', 'cashier', 'barista', 'hallDeputy'] as const) {
    const cfg = config.criteria[key];
    assert.equal(cfg.kind, 'time');
    if (cfg.kind !== 'time') continue;

    const green = parseClock(cfg.greenUntil);
    const yellow = parseClock(cfg.yellowUntil);
    assert.ok(green < yellow, `${key}: граница 🟢 должна быть раньше границы 🟡`);

    // Каждая минута до порога «другого графика» получает ровно один статус.
    assert.equal(statusForTime(green, key, config), 'green');
    assert.equal(statusForTime(green + 1, key, config), 'yellow');
    assert.equal(statusForTime(yellow, key, config), 'yellow');
    assert.equal(statusForTime(yellow + 1, key, config), 'red');
  }
});

test('все пороги критериев подтверждены заказчиком', () => {
  for (const key of CRITERION_ORDER) {
    assert.equal(config.criteria[key].confirmed, true, `${key}: пороги не подтверждены`);
  }
});

test('нет отметки → красный, без исключений (п.5.1 ТЗ)', () => {
  assert.equal(statusForTime(null, 'cook', config), 'red');
  assert.equal(statusForTime(null, 'driver', config), 'red');
});

test('«другой график» срабатывает раньше пороговой таблицы (п.5.0 ТЗ)', () => {
  assert.equal(statusForTime(at(8, 1), 'cook', config), 'other_schedule');
  assert.equal(statusForTime(at(8, 0), 'cook', config), 'red', 'ровно 8:00 — ещё опоздание');
  assert.equal(statusForTime(at(9, 15), 'cashier', config), 'other_schedule');
});

test('расчёт прихода = уход − 30 мин (пример из ТЗ: уход 07:40 → приход 07:10)', () => {
  const r = resolveArrival(null, '25.08.2026 7:40:00', config);
  assert.equal(r.minutes, at(7, 10));
  assert.equal(r.source, 'derived_minus30');
  assert.match(r.note ?? '', /досчитано/);
});

test('реальная отметка приоритетнее расчёта', () => {
  const r = resolveArrival('25.08.2026 6:25:29', '25.08.2026 7:40:00', config);
  assert.equal(r.minutes, at(6, 25));
  assert.equal(r.source, 'mark');
});

test('ночной уход не превращается в приход: окно правдоподобия', () => {
  // Реальный случай из выгрузки: бариста М3 Пресня, уход 00:32.
  const r = resolveArrival(null, '25.08.2026 0:32:11', config);
  assert.equal(r.minutes, null);
  assert.equal(r.source, 'none');
  assert.match(r.note ?? '', /вне окна правдоподобия/);
  assert.equal(statusForTime(r.minutes, 'barista', config), 'red');
});

test('нет ни прихода, ни ухода → source=none без примечания', () => {
  const r = resolveArrival(null, null, config);
  assert.deepEqual(r, { minutes: null, source: 'none', note: null });
});

test('наполнение витрины: 🟢 95–100%, 🟡 85–94%, 🔴 ≤84%', () => {
  assert.equal(statusForFill(1.0, config), 'green');
  assert.equal(statusForFill(0.95, config), 'green');
  assert.equal(statusForFill(0.94, config), 'yellow');
  assert.equal(statusForFill(0.85, config), 'yellow');
  assert.equal(statusForFill(0.84, config), 'red');
  assert.equal(statusForFill(null, config), 'no_data');
});

test('наполнение принимает и проценты, и доли', () => {
  assert.equal(normalizeFill(95), 0.95);
  assert.equal(normalizeFill(0.95), 0.95);
  assert.equal(normalizeFill(1), 1);
  assert.equal(statusForFill(95, config), 'green');
});

test('агрегация: худший статус побеждает, нейтральные не учитываются', () => {
  assert.equal(worstStatus(['green', 'yellow', 'red']), 'red');
  assert.equal(worstStatus(['green', 'yellow']), 'yellow');
  assert.equal(worstStatus(['green', 'green']), 'green');
  assert.equal(worstStatus(['green', 'other_schedule']), 'green');
  assert.equal(worstStatus(['other_schedule', 'no_data']), 'no_data');
  assert.equal(worstStatus([]), 'no_data');
});

test('средний балл: 🟢 3, 🟡 2, 🔴 1, нейтральные не считаются', () => {
  // Пример заказчика от 27.08.2026: 3+3+1 = 7/3 = 2,33.
  assert.equal(averageScore(['green', 'green', 'red'], config), 2.33);
  assert.equal(averageScore(['green', 'green', 'green'], config), 3);
  assert.equal(averageScore(['red', 'red'], config), 1);
  // «Другой график» и «нет данных» не должны тянуть балл ни вверх, ни вниз.
  assert.equal(averageScore(['green', 'green', 'red', 'other_schedule'], config), 2.33);
  assert.equal(averageScore(['other_schedule', 'no_data'], config), null);
  assert.equal(averageScore([], config), null);
});

test('зоны по баллу: 0–1,9 🔴, 1,91–2,6 🟡, 2,61–3 🟢', () => {
  assert.equal(statusFromScore(0, config), 'red');
  assert.equal(statusFromScore(1, config), 'red');
  assert.equal(statusFromScore(1.9, config), 'red');
  assert.equal(statusFromScore(1.91, config), 'yellow');
  assert.equal(statusFromScore(2.33, config), 'yellow');
  assert.equal(statusFromScore(2.6, config), 'yellow');
  assert.equal(statusFromScore(2.61, config), 'green');
  assert.equal(statusFromScore(3, config), 'green');
  assert.equal(statusFromScore(null, config), 'no_data');

  // Между зонами не должно быть «дырок»: балл округляется до сотых,
  // и округлённое значение всегда попадает ровно в одну зону.
  assert.equal(statusFromScore(1.905, config), 'yellow');
  assert.equal(statusFromScore(2.605, config), 'green');
});

test('агрегация по среднему: три повара 🟢🟢🔴 дают жёлтый, а не красный', () => {
  const avg = aggregateStatuses(['green', 'green', 'red'], 'average', config);
  assert.deepEqual(avg, { status: 'yellow', score: 2.33 });

  // Старое правило на тех же данных давало красный — ради этого и правка.
  assert.deepEqual(aggregateStatuses(['green', 'green', 'red'], 'worst', config), {
    status: 'red',
    score: null,
  });

  // Один человек — балл равен его статусу, зона не меняется.
  assert.deepEqual(aggregateStatuses(['red'], 'average', config), { status: 'red', score: 1 });
  assert.deepEqual(aggregateStatuses(['yellow'], 'average', config), {
    status: 'yellow',
    score: 2,
  });

  // Считать не из чего — ведём себя как worst, а не выдумываем балл.
  assert.deepEqual(aggregateStatuses(['other_schedule'], 'average', config), {
    status: 'no_data',
    score: null,
  });
  assert.deepEqual(aggregateStatuses([], 'average', config), { status: 'no_data', score: null });
});

test('свёртка отметок берёт правило из конфига и кладёт балл в строку', () => {
  const person = (employeeName: string, status: Status): AttendanceRow => ({
    date: '2026-08-27',
    shopCode: 'М1',
    shopName: 'М1 Милютинский',
    employeeName,
    role: 'Повар',
    criterion: 'cook',
    trainee: false,
    homeShopCode: null,
    arrivalMinutes: 360,
    arrivalSource: 'mark',
    rawArrival: null,
    rawDeparture: null,
    status,
    note: null,
  });

  const rows = [person('А', 'green'), person('Б', 'green'), person('В', 'red')];
  const [cook] = rollUpAttendance('2026-08-27', rows, config);
  const expected = aggregateStatuses(
    ['green', 'green', 'red'],
    config.rules.criterionAggregation.strategy,
    config,
  );
  assert.equal(cook.criterion, 'cook');
  assert.equal(cook.status, expected.status);
  assert.equal(cook.score, expected.score);
});

test('в действующем конфиге внутри критерия считается средний балл', () => {
  // Подтверждено заказчиком 27.08.2026 — если правило вернут к worst,
  // тикет по трём поварам 🟢🟢🔴 снова станет красным.
  assert.equal(config.rules.criterionAggregation.strategy, 'average');
  assert.equal(config.rules.scoreZones.redUntil, 1.9);
  assert.equal(config.rules.scoreZones.yellowUntil, 2.6);
});

test('стажёр маппится на базовую роль с флагом trainee', () => {
  assert.deepEqual(mapRole('Повар', config), { criterion: 'cook', trainee: false });
  assert.deepEqual(mapRole('Повар-стажер', config), { criterion: 'cook', trainee: true });
  assert.deepEqual(mapRole('Кассир - стажер', config), { criterion: 'cashier', trainee: true });
  // Написание в 1С плавает — дефисы, пробелы, «ё» и регистр не должны ломать маппинг.
  assert.deepEqual(mapRole('кассир стажёр', config), { criterion: 'cashier', trainee: true });
  assert.equal(mapRole('Уборщик', config), null);
  assert.equal(mapRole(null, config), null);
});

test('все должности из тестовых выгрузок распознаются', () => {
  const roles = [
    'Повар', 'Повар-стажер', 'Кассир', 'Кассир - стажер',
    'Бариста', 'Бариста - стажер', 'Водитель-экспедитор',
  ];
  for (const r of roles) assert.ok(mapRole(r, config), `не распознана должность «${r}»`);
});

test('лавка определяется по коду, а не по названию', () => {
  assert.deepEqual(parseShop('М12 Даниловская мануфактура '), {
    code: 'М12',
    name: 'М12 Даниловская мануфактура',
  });
  // Одна и та же лавка под разными названиями (переименование в выгрузке).
  assert.equal(parseShop('М32 Кржижановского')?.code, parseShop('М32 Профсоюзная')?.code);
  assert.equal(parseShop('М17 Б.Сухаревский')?.code, parseShop('М17 Б. Сухаревский')?.code);
  assert.equal(parseShop('Итого'), null);
  assert.equal(parseShop(null), null);
  assert.equal(normalizeCode('M12'), 'М12', 'латинская M приводится к кириллице');
});

test('разбор отметки из выгрузки 1С', () => {
  assert.deepEqual(parseStamp('25.08.2026 6:25:29'), { date: '2026-08-25', minutes: 385 });
  assert.deepEqual(parseStamp('01.09.2026 15:04'), { date: '2026-09-01', minutes: 904 });
  assert.equal(parseStamp(''), null);
  assert.equal(parseStamp(null), null);
  assert.equal(parseStamp('какая-то строка'), null);
});

test('форматирование времени и диапазон дат', () => {
  assert.equal(formatClock(385), '06:25');
  assert.equal(formatClock(null), '—');
  assert.deepEqual(dateRange('2026-08-23', '2026-08-25'), [
    '2026-08-23', '2026-08-24', '2026-08-25',
  ]);
});

test('повторные отметки одного человека сворачиваются в самую раннюю', () => {
  const row = (
    employeeName: string,
    arrivalMinutes: number | null,
    status: Status,
    date = '2026-08-19',
    shopCode = 'М16',
  ): AttendanceRow => ({
    date,
    shopCode,
    shopName: shopCode,
    employeeName,
    role: 'Повар',
    criterion: 'cook',
    trainee: false,
    homeShopCode: null,
    arrivalMinutes,
    arrivalSource: arrivalMinutes == null ? 'none' : 'mark',
    rawArrival: null,
    rawDeparture: null,
    status,
    note: null,
  });

  // Реальный случай 19.08: у одного человека строка без времени и строка 5:59.
  // Считать их за двух сотрудников нельзя — «нет отметки» красит лавку зря.
  const a = dedupeAttendance([row('Абдуллаева', null, 'red'), row('Абдуллаева', 359, 'green')]);
  assert.equal(a.rows.length, 1);
  assert.equal(a.removed, 1);
  assert.equal(a.rows[0].arrivalMinutes, 359);

  // Вернулся после перерыва — открытие меряется первой отметкой.
  const b = dedupeAttendance([row('Комур', 391, 'green'), row('Комур', 1027, 'other_schedule')]);
  assert.equal(b.rows[0].arrivalMinutes, 391);
  assert.equal(b.rows[0].status, 'green');

  // Порядок строк в файле роли не играет.
  const c = dedupeAttendance([row('Комур', 1027, 'other_schedule'), row('Комур', 391, 'green')]);
  assert.equal(c.rows[0].arrivalMinutes, 391);

  // Разные люди, разные лавки и разные дни остаются как есть.
  const d = dedupeAttendance([
    row('Иванов', 360, 'green'),
    row('Петров', 360, 'green'),
    row('Иванов', 360, 'green', '2026-08-20'),
    row('Иванов', 360, 'green', '2026-08-19', 'М17'),
  ]);
  assert.equal(d.rows.length, 4);
  assert.equal(d.removed, 0);
});
