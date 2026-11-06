import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import guids from '../../config/1c-guids.json';
import { MAX_DAYS, TOKEN_ENV, checkOnecToken, guidOf, onecPeriod, onecValue } from './onec';

// Как в queries.test.ts: снимок из репозитория и пустая база ручных данных.
process.env.RADAR_STORAGE = 'snapshot';
process.env.RADAR_MANUAL_DB_PATH = path.join(
  fs.mkdtempSync(path.join(os.tmpdir(), 'radar-onec-')),
  'manual.db',
);

type Queries = typeof import('./queries');
let q: Queries;

before(async () => {
  q = await import('./queries');
});

test('шкала 1С: красный 0, жёлтый 1, зелёный 2; без оценки — ничего', () => {
  assert.equal(onecValue('red'), 0);
  assert.equal(onecValue('yellow'), 1);
  assert.equal(onecValue('green'), 2);
  // Ноль за «нет данных» был бы красным за день, которого не оценивали.
  assert.equal(onecValue('no_data'), null);
  assert.equal(onecValue('other_schedule'), null);
});

test('GUID ищется по коду лавки без ведущего нуля', () => {
  assert.equal(guidOf('М1'), '15943ec6-01b1-11e8-80d6-0cc47a17852f');
  assert.equal(guidOf('М2'), '647091ef-01b1-11e8-80d6-0cc47a17852f');
  assert.equal(guidOf('М999'), null);
});

test('справочник GUID: все похожи на GUID и не повторяются', () => {
  const list = Object.values(guids.units).map((u) => u.guid);
  assert.ok(list.length > 50, `лавок всего ${list.length}`);
  for (const g of list) assert.match(g, /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/);
  assert.equal(new Set(list).size, list.length);
});

test('период: date, from+to, по умолчанию — вчера по Москве', () => {
  const p = (s: string) => onecPeriod(new URLSearchParams(s), new Date('2026-10-22T07:00:00Z'));
  assert.deepEqual(p('date=2026-10-20'), { ok: true, from: '2026-10-20', to: '2026-10-20' });
  assert.deepEqual(p('from=2026-10-01&to=2026-10-21'), {
    ok: true,
    from: '2026-10-01',
    to: '2026-10-21',
  });
  assert.deepEqual(p(''), { ok: true, from: '2026-10-21', to: '2026-10-21' });

  // 22.10 01:30 по Москве — в UTC ещё 21-е, а «вчера» уже 21-е, не 20-е.
  const night = onecPeriod(new URLSearchParams(), new Date('2026-10-21T22:30:00Z'));
  assert.deepEqual(night, { ok: true, from: '2026-10-21', to: '2026-10-21' });
});

test('период: мусор и слишком длинные запросы отклоняются', () => {
  const bad = (s: string) => onecPeriod(new URLSearchParams(s)).ok;
  assert.equal(bad('from=2026-10-01'), false);
  assert.equal(bad('date=21.10.2026'), false);
  assert.equal(bad('date=2026-02-31'), false);
  assert.equal(bad('from=2026-10-21&to=2026-10-01'), false);
  assert.equal(bad(`from=2026-01-01&to=2026-12-31`), false);
  assert.ok(MAX_DAYS >= 31, 'месяц целиком должен помещаться в один запрос');
  assert.equal(bad('from=2026-09-01&to=2026-09-30'), true);
});

test('токен: не задан — закрыто, чужой — 401, свой — пускает', () => {
  const req = (auth?: string) =>
    new Request('http://x/api/1c/kpi', { headers: auth ? { authorization: auth } : {} });
  // Заголовки HTTP — только латиница: токен на кириллице fetch не отправит вовсе.
  const saved = process.env[TOKEN_ENV];
  try {
    delete process.env[TOKEN_ENV];
    assert.equal(checkOnecToken(req('Bearer anything')).ok, false);
    assert.equal((checkOnecToken(req()) as { status: number }).status, 503);

    process.env[TOKEN_ENV] = 's3cret-1c';
    assert.equal((checkOnecToken(req()) as { status: number }).status, 401);
    assert.equal((checkOnecToken(req('Bearer alien')) as { status: number }).status, 401);
    assert.equal(checkOnecToken(req('s3cret-1c')).ok, false, 'без «Bearer» не пускаем');
    assert.equal(checkOnecToken(req('Bearer s3cret-1c')).ok, true);
  } finally {
    if (saved === undefined) delete process.env[TOKEN_ENV];
    else process.env[TOKEN_ENV] = saved;
  }
});

test('в 1С уходит ровно цвет ячейки радара при критерии «Все»', async () => {
  const dates = await q.listDates();
  const to = dates[dates.length - 1];
  const from = dates[Math.max(0, dates.length - 14)];

  const { rows } = await q.radar({ from, to, criterion: 'all' });
  const days = await q.kpiDays(from, to);

  const cells = rows.reduce((n, r) => n + Object.keys(r.cells).length, 0);
  assert.ok(days.length > 0, 'за последние две недели снимка должны быть оценки');
  assert.equal(days.length, cells);
  for (const d of days) {
    const row = rows.find((r) => r.shop.code === d.shop.code);
    assert.equal(d.status, row?.cells[d.date]?.status, `${d.shop.code} ${d.date}`);
    assert.ok(d.components, 'итог по формуле «Водитель + Сотрудники + Витрина»');
  }
});
