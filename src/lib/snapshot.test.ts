import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fixturesFingerprint } from './fixtures';
import { configFingerprint, type Snapshot } from './snapshot';
import { exportCoverage, isLegacyStale } from './rollup';
import { parseRoster } from './parsers/roster';
import { readSeed } from './showcase-store';
import { CRITERION_ORDER } from './types';

const SNAPSHOT_PATH = path.join(process.cwd(), 'src', 'generated', 'snapshot.json');

function readSnapshot(): Snapshot {
  return JSON.parse(fs.readFileSync(SNAPSHOT_PATH, 'utf8')) as Snapshot;
}

test('снимок закоммичен: без него не соберётся serverless-сборка', () => {
  assert.ok(fs.existsSync(SNAPSHOT_PATH), `нет файла ${SNAPSHOT_PATH} — запусти npm run snapshot`);
});

test('снимок собран на действующих порогах', () => {
  const s = readSnapshot();
  assert.equal(
    s.configFingerprint,
    configFingerprint(),
    'пороги правили после сборки снимка — пересобери: npm run snapshot',
  );
});

test('снимок собран из тех выгрузок, что лежат в fixtures сейчас', () => {
  const s = readSnapshot();
  assert.equal(
    s.fixturesFingerprint,
    fixturesFingerprint(path.join(process.cwd(), 'fixtures')),
    'файлы в fixtures/ изменились после сборки снимка — пересобери: npm run snapshot',
  );
});

test('снимок содержит все данные, которые рисует дашборд', () => {
  const s = readSnapshot();
  assert.equal(s.shops.length, 80);
  assert.ok(s.attendance.length > 300, 'отметки за 25.08');
  assert.ok(s.criteria.length > 1000, 'статусы критериев');

  // Витрины в снимок не пекутся: их правят на сайте, они живут в базе ручных
  // данных и подмешиваются при чтении снимка (см. showcase-store.ts).
  assert.deepEqual(s.showcase, [], 'витрины в снимке не хранятся');
  const seed = readSeed();
  const values = Object.values(seed.days).reduce(
    (n: number, d: Record<string, number>) => n + Object.keys(d).length,
    0,
  );
  assert.ok(values > 100, `наполнение витрин в сиде: ${values}`);
  // Легаси остаётся только там, где выгрузка день не закрыла: сейчас это
  // водитель за 19–24.08 (в табеле водителей нет).
  assert.ok(s.legacyPeople.length > 0, 'легаси-статусы людей');
  assert.ok(s.shops.every((x) => x.region), 'у каждой лавки есть РМ');
});

test('даты в снимке — корректные и непрерывные', () => {
  const s = readSnapshot();
  const snapshotDates = [...new Set(s.criteria.map((c) => c.date))].sort();
  assert.ok(snapshotDates.length >= 7, `дней в снимке всего ${snapshotDates.length}`);

  for (const d of snapshotDates) {
    assert.match(d, /^\d{4}-\d{2}-\d{2}$/, `некорректная дата ${d}`);
  }

  // День, у которого есть только наполнение витрин, в снимок не попадает:
  // витрины живут в базе ручных данных и подмешиваются при чтении. Поэтому
  // непрерывность проверяем по объединению — так же, как её видит дашборд.
  const dates = [...new Set([...snapshotDates, ...Object.keys(readSeed().days)])].sort();

  // Пропуск дня внутри периода — признак того, что выгрузку забыли положить.
  const first = new Date(`${dates[0]}T00:00:00`);
  const last = new Date(`${dates[dates.length - 1]}T00:00:00`);
  const span = Math.round((last.getTime() - first.getTime()) / 86_400_000) + 1;
  assert.equal(dates.length, span, `в периоде ${dates[0]}—${dates[dates.length - 1]} пропущены дни`);
});

test('где есть отметки, статус посчитан, а не взят из легаси-книги', () => {
  const s = readSnapshot();
  const computedDays = [
    ...new Set(s.attendance.filter((a) => a.arrivalSource !== 'delivery').map((a) => a.date)),
  ].sort();
  assert.ok(computedDays.length >= 1, 'в снимке нет ни одного дня с сырыми отметками');

  // День теперь бывает смешанным: за 22–24.08 сотрудники посчитаны по табелю,
  // а водителя нет ни в табеле, ни в журнале отгрузок — он остаётся легаси.
  // Инвариант формулируется по критерию, а не по дню: есть отметка — есть расчёт.
  const withMarks = new Set(
    s.attendance.filter((a) => a.criterion).map((a) => `${a.date}|${a.shopCode}|${a.criterion}`),
  );
  const byKey = new Map(s.criteria.map((c) => [`${c.date}|${c.shopCode}|${c.criterion}`, c]));
  assert.equal(byKey.size, s.criteria.length, 'один критерий лавки за день должен быть один раз');

  for (const key of withMarks) {
    const row = byKey.get(key);
    assert.ok(row, `${key}: есть отметки, но нет статуса критерия`);
    assert.equal(row.origin, 'computed', `${key}: есть отметки, а статус взят из легаси-книги`);
  }

  for (const date of computedDays) {
    const computed = s.criteria.filter((c) => c.date === date && c.origin === 'computed');
    assert.ok(computed.length > 0, `${date}: за день с выгрузкой нет ни одного расчёта`);
  }
});

test('время из журнала отгрузок подставлено только там, где нет отметки face id', () => {
  const s = readSnapshot();
  const delivery = s.attendance.filter((a) => a.arrivalSource === 'delivery');
  assert.ok(delivery.length > 0, 'подстановок из журнала отгрузок в снимке нет');

  for (const row of delivery) {
    assert.equal(row.criterion, 'driver', 'журнал отгрузок даёт только водителя');
    assert.ok(row.arrivalMinutes != null, `${row.shopCode} ${row.date}: подставлено пустое время`);

    const faceId = s.attendance.filter(
      (a) =>
        a.date === row.date &&
        a.shopCode === row.shopCode &&
        a.criterion === 'driver' &&
        a.arrivalSource !== 'delivery' &&
        a.arrivalMinutes != null,
    );
    assert.equal(faceId.length, 0, `${row.shopCode} ${row.date}: есть face id, подстановка лишняя`);
  }
});

test('РМ у лавок — только действующие, из справочника', () => {
  // Справочник — источник правды: менеджеров, которых в нём нет, в радаре
  // быть не должно, даже если они остались в легаси-книге.
  const roster = parseRoster(
    fs.readFileSync(path.join(process.cwd(), 'fixtures', 'spravochnik-lavok.xlsx')),
  );
  const current = new Set(roster.managers);
  const snapshot = readSnapshot();

  for (const shop of snapshot.shops) {
    if (shop.region == null) continue;
    assert.ok(current.has(shop.region), `${shop.code}: РМ «${shop.region}» нет в справочнике`);
  }
  assert.ok(snapshot.shops.some((s) => s.region), 'РМ проставлен хотя бы у одной лавки');
});

test('в снимке нет неизвестных критериев и статусов', () => {
  const s = readSnapshot();
  const allowed = new Set(['green', 'yellow', 'red', 'other_schedule', 'no_data']);
  for (const c of s.criteria) {
    assert.ok(CRITERION_ORDER.includes(c.criterion), `неизвестный критерий ${c.criterion}`);
    assert.ok(allowed.has(c.status), `неизвестный статус ${c.status}`);
  }
});

test('снимок не тянет за собой better-sqlite3', () => {
  // На serverless нативный модуль не собирается: если он попадёт в статический
  // граф импортов, страницы упадут в рантайме.
  const src = fs.readFileSync(path.join(process.cwd(), 'src', 'lib', 'snapshot.ts'), 'utf8');
  assert.ok(
    !/^import .*better-sqlite3/m.test(src) && !/^import .*from '\.\/db'/m.test(src),
    'db.ts должен подключаться только динамическим import()',
  );
});

test('раскрашенное вручную не берётся за дни, которые закрыла выгрузка', () => {
  const s = readSnapshot();
  const coverage = exportCoverage(s.attendance);

  const stale = (date: string, shopCode: string, criterion: string): boolean =>
    isLegacyStale(coverage, date, shopCode, criterion);

  for (const p of s.legacyPeople) {
    assert.ok(
      !stale(p.date, p.shopCode, p.criterion),
      `${p.shopCode} ${p.date}: легаси-статус «${p.employeeName}» пережил выгрузку`,
    );
  }
  for (const c of s.criteria) {
    if (c.origin !== 'legacy') continue;
    assert.ok(
      !stale(c.date, c.shopCode, c.criterion),
      `${c.shopCode} ${c.date} ${c.criterion}: легаси-статус пережил выгрузку`,
    );
  }

  // Лавка, которой в выгрузке за день нет вовсе, в этот день не работала.
  // 22.08 — суббота, М16 закрыта: ни отметок, ни статусов быть не должно.
  const closed = (date: string, shopCode: string): number =>
    s.attendance.filter((a) => a.date === date && a.shopCode === shopCode).length +
    s.criteria.filter((c) => c.date === date && c.shopCode === shopCode).length +
    s.legacyPeople.filter((p) => p.date === date && p.shopCode === shopCode).length;
  assert.equal(closed('2026-08-22', 'М16'), 0, 'М16 22.08: лавка не работала, а данные есть');
});
