import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/**
 * Баллы и время на фабрике по выездам с РЦ.
 *
 * Отдельный файл, потому что путь к снимку читается при первом импорте
 * модуля: выгрузки по РЦ в репозитории нет (её загружают на сайте), поэтому
 * снимок под этот тест пишется синтетический — с ровно теми временами, на
 * которых правило и ломается.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-departure-'));
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_SNAPSHOT_PATH = path.join(dir, 'snapshot.json');
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_SHOWCASE_PATH = path.join(dir, 'showcase.json');

const hhmm = (s: string): number => {
  const [h, m] = s.split(':').map(Number);
  return h * 60 + m;
};

/** Один выезд: приезд на РЦ → уход со склада. */
function row(date: string, name: string, arrival: string | null, departure: string | null) {
  return {
    date,
    employeeName: name,
    unit: 'РЦ Свобода',
    role: 'Водитель-экспедитор',
    arrivalMinutes: arrival ? hhmm(arrival) : null,
    departureMinutes: departure ? hhmm(departure) : null,
    rawDeparture: departure,
  };
}

/** Отметка водителя в лавке — то, с чем связывается выезд с РЦ. */
function mark(date: string, name: string, shopCode: string, arrival: string) {
  return {
    date,
    shopCode,
    shopName: shopCode,
    employeeName: name,
    role: 'Водитель-экспедитор',
    criterion: 'driver',
    trainee: false,
    homeShopCode: shopCode,
    arrivalMinutes: hhmm(arrival),
    arrivalSource: 'mark',
    rawArrival: arrival,
    rawDeparture: null,
    status: 'green',
    note: null,
  };
}

function writeSnapshot(
  departures: ReturnType<typeof row>[],
  attendance: ReturnType<typeof mark>[] = [],
): void {
  fs.writeFileSync(
    process.env.RADAR_SNAPSHOT_PATH!,
    JSON.stringify({
      generatedAt: new Date().toISOString(),
      source: 'json',
      configFingerprint: 'test',
      fixturesFingerprint: `${departures.length}/${attendance.length}`,
      shops: [...new Set(attendance.map((a) => a.shopCode))].map((code) => ({
        code,
        name: code,
        region: null,
      })),
      attendance,
      showcase: [],
      criteria: [],
      legacyPeople: [],
      runs: [],
      regionHistory: [],
      departures,
    }),
  );
}

test('баллы за убытие: до 05:00 — 3, 05:00–05:29 — 2, с 05:30 — 1', async () => {
  writeSnapshot([
    row('2026-09-05', 'Ранний Р.Р.', '04:00', '04:59'),
    row('2026-09-05', 'Ровно Пять П.П.', '04:10', '05:00'),
    row('2026-09-05', 'Впритык В.В.', '04:20', '05:29'),
    // Настоящий случай из выгрузки за 05–07.09: выезд ровно в 05:30.
    // При yellowUntil=05:30 он получил бы 2 балла вместо заказанного одного.
    row('2026-09-05', 'Ровно Полшестого П.П.', '04:30', '05:30'),
  ]);

  const { departureSummary } = await import('./queries');
  const s = (await departureSummary('2026-09-05', '2026-09-05'))!;

  assert.equal(s.green, 1, '04:59 — зелёный');
  assert.equal(s.yellow, 2, '05:00 и 05:29 — жёлтые');
  assert.equal(s.red, 1, '05:30 — уже красный');
  assert.equal(s.score, 2, '(3 + 2 + 2 + 1) / 4');
  assert.equal(s.status, 'yellow', 'балл 2,00 попадает в жёлтую зону');

  assert.deepEqual(
    s.late.map((l) => l.employeeName),
    ['Ровно Полшестого П.П.'],
    'в поимённом списке — только выехавшие с 05:30',
  );
});

test('время на фабрике — уход минус приход, медианой по дню', async () => {
  writeSnapshot([
    row('2026-09-06', 'Первый П.П.', '04:00', '04:30'), // 30 мин
    row('2026-09-06', 'Второй В.В.', '03:30', '05:15'), // 1 ч 45 мин
    row('2026-09-06', 'Третий Т.Т.', '04:00', '05:00'), // 60 мин
    // Без ухода: и в баллы, и во время на фабрике не попадает.
    row('2026-09-06', 'Без Ухода Б.У.', '04:05', null),
  ]);

  const { departureSummary } = await import('./queries');
  const s = (await departureSummary('2026-09-06', '2026-09-06'))!;

  assert.equal(s.medianStay, 60, 'медиана из 30 / 60 / 105');
  assert.equal(s.unknown, 1, 'строка без ухода — отдельно');
  assert.equal(s.green + s.yellow + s.red, 3, 'она же не оценивается');
  assert.equal(s.days[0].medianStay, 60);
  assert.equal(s.days[0].score, s.score, 'за один день дневной балл равен общему');
});

test('время на фабрике не считается, когда уход раньше прихода', async () => {
  // Ночная смена: приехал 23:50, уехал 04:20 следующих суток — в выгрузке это
  // две даты, и вычитать одну из другой нельзя. Лучше прочерк, чем минус.
  writeSnapshot([row('2026-09-07', 'Ночной Н.Н.', '23:50', '04:20')]);

  const { departureSummary } = await import('./queries');
  const s = (await departureSummary('2026-09-07', '2026-09-07'))!;

  assert.equal(s.medianStay, null);
  assert.equal(s.green, 1, 'сам выезд при этом оценивается как обычно');
  assert.equal(s.late.length, 0);
});

test('детализация: у каждого водителя свой балл, худшие сверху', async () => {
  writeSnapshot([
    row('2026-09-10', 'Поздний П.П.', '05:00', '06:00'), // 1 балл
    row('2026-09-10', 'Ранний Р.Р.', '04:00', '04:30'), // 3 балла
    row('2026-09-11', 'Ранний Р.Р.', '04:00', '04:40'), // 3 балла
    row('2026-09-11', 'Средний С.С.', '04:00', '05:10'), // 2 балла
    row('2026-09-10', 'Средний С.С.', '04:00', '04:20'), // 3 балла → в среднем 2,5
  ]);

  const { departureSummary } = await import('./queries');
  const s = (await departureSummary('2026-09-10', '2026-09-11'))!;

  assert.deepEqual(
    s.drivers.map((d) => [d.employeeName, d.score, d.trips]),
    [
      ['Поздний П.П.', 1, 1],
      ['Средний С.С.', 2.5, 2],
      ['Ранний Р.Р.', 3, 2],
    ],
    'сверху тот, с кем нужно разговаривать',
  );

  const late = s.drivers[0];
  assert.equal(late.red, 1);
  assert.equal(late.status, 'red');
  assert.deepEqual(late.days['2026-09-10'], [
    { unit: 'РЦ Свобода', minutes: 360, stay: 60, status: 'red', score: 1 },
  ]);
  assert.equal(late.days['2026-09-11'], undefined, 'в этот день он не выезжал');
});

test('детализация: два выезда за день не затирают друг друга', async () => {
  // Реальный случай из выгрузки: водитель уехал, вернулся и уехал снова.
  writeSnapshot([
    row('2026-09-12', 'Дважды Д.Д.', null, '04:02'),
    row('2026-09-12', 'Дважды Д.Д.', '04:03', '04:48'),
    // Только приход: балл по такой строке не ставится.
    row('2026-09-12', 'Без Ухода Б.У.', '04:05', null),
  ]);

  const { departureSummary } = await import('./queries');
  const s = (await departureSummary('2026-09-12', '2026-09-12'))!;

  const twice = s.drivers.find((d) => d.employeeName === 'Дважды Д.Д.')!;
  assert.equal(twice.trips, 2, 'оба выезда считаются');
  assert.equal(twice.days['2026-09-12'].length, 2, 'и оба видны в клетке дня');
  assert.deepEqual(
    twice.days['2026-09-12'].map((t) => t.minutes),
    [242, 288],
  );

  const noExit = s.drivers.find((d) => d.employeeName === 'Без Ухода Б.У.')!;
  assert.equal(noExit.trips, 0);
  assert.equal(noExit.unknown, 1);
  assert.equal(noExit.score, null, 'балла нет — уезжал ли он, выгрузка не говорит');
  assert.equal(noExit.status, 'no_data');
  assert.equal(s.drivers[s.drivers.length - 1], noExit, 'и он уходит в конец списка');
});

test('на карточке лавки: выезд с РЦ цепляется к водителю по полному ФИО', async () => {
  writeSnapshot(
    [
      row('2026-09-15', 'Ороспаев Павел Юрьевич', '04:00', '04:20'),
      // Однофамилец: в выгрузках есть разные Егоровы, и путать их нельзя.
      row('2026-09-15', 'Егоров Сергей Александрович', '04:00', '05:40'),
      // Тот же водитель днём позже — не должен попасть в чужой день.
      row('2026-09-16', 'Ороспаев Павел Юрьевич', '04:00', '05:50'),
    ],
    [
      mark('2026-09-15', 'Ороспаев Павел Юрьевич', 'М1', '06:05'),
      mark('2026-09-15', 'Егоров Дмитрий Иванович', 'М1', '06:10'),
    ],
  );

  const { shopHistory } = await import('./queries');
  const [day] = await shopHistory('М1', '2026-09-15', '2026-09-15');

  const orospaev = day.people.find((p) => p.employeeName === 'Ороспаев Павел Юрьевич')!;
  assert.equal(orospaev.departures.length, 1);
  assert.deepEqual(orospaev.departures[0], {
    unit: 'РЦ Свобода',
    minutes: 260,
    stay: 20,
    status: 'green',
    score: 3,
  });

  const egorov = day.people.find((p) => p.employeeName === 'Егоров Дмитрий Иванович')!;
  assert.deepEqual(egorov.departures, [], 'однофамилец — это другой человек');
});

test('на карточке лавки: выезда нет — строка пустая, а не выдуманная', async () => {
  writeSnapshot(
    [row('2026-09-17', 'Ороспаев Павел Юрьевич', '04:00', '04:20')],
    [mark('2026-09-18', 'Ороспаев Павел Юрьевич', 'М1', '06:05')],
  );

  const { shopHistory } = await import('./queries');
  const [day] = await shopHistory('М1', '2026-09-18', '2026-09-18');

  assert.deepEqual(
    day.people[0].departures,
    [],
    'выезд был в другой день — подставлять его в этот нельзя',
  );
});

test('период без выгрузки по РЦ — блока нет', async () => {
  writeSnapshot([row('2026-09-05', 'Ранний Р.Р.', '04:00', '04:30')]);

  const { departureSummary } = await import('./queries');
  assert.equal(await departureSummary('2026-09-20', '2026-09-30'), null);

  fs.rmSync(dir, { recursive: true, force: true });
});
