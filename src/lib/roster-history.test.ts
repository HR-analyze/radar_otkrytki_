import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { deriveRegionHistory, ROSTER_EFFECTIVE_DATE } from './roster-history';

/**
 * История РМ: ушедший менеджер должен остаться в тех месяцах, где он реально
 * отвечал за лавку, — иначе сравнить его показатели с преемником нельзя.
 */

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-roster-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');

let db: typeof import('./roster-history');
before(async () => {
  db = await import('./roster-history');
});

const map = (o: Record<string, string>): Map<string, string> => new Map(Object.entries(o));

test('ушедший РМ остаётся за своими лавками до дня смены', () => {
  const history = deriveRegionHistory(
    map({ М35: 'Сурков', М58: 'Сурков' }),
    map({ М35: 'Малаева Анна', М58: 'Малаева Анна' }),
  );

  const m35 = history.filter((p) => p.shopCode === 'М35');
  assert.equal(m35.length, 2, 'смена РМ — это два периода, а не затирание одного');

  const [was, now] = m35.sort((a, b) => a.from.localeCompare(b.from));
  assert.equal(was.manager, 'Сурков');
  assert.equal(was.to, '2026-08-31', 'прежний РМ закрыт днём до смены');
  assert.equal(now.manager, 'Малаева Анна');
  assert.equal(now.from, ROSTER_EFFECTIVE_DATE);
  assert.equal(now.to, null, 'действующий период не закрыт');
});

test('одна фамилия в книге и полное имя в справочнике — один человек, а не двое', () => {
  // В легаси-книге РМ записан фамилией («Шевкун»), в справочнике — с именем.
  // Без сведения он попадал бы в фильтр дважды и выглядел бы как два разных.
  const history = deriveRegionHistory(map({ М17: 'Шевкун' }), map({ М17: 'Шевкун Виктория' }));

  assert.equal(history.length, 1, 'период не должен рваться из-за формата имени');
  assert.equal(history[0].manager, 'Шевкун Виктория', 'берётся полное имя');
  assert.equal(history[0].to, null);
});

test('лавку, ушедшую к другому РМ, прежний менеджер сохраняет под полным именем', () => {
  // М45 передали от Карабака Шабайкиной. Карабак остаётся действующим РМ по
  // другим лавкам, поэтому и в закрытом периоде он должен быть назван так же.
  const history = deriveRegionHistory(
    map({ М45: 'Карабак', М75: 'Карабак' }),
    map({ М45: 'Шабайкина Екатерина', М75: 'Карабак Денис' }),
  );

  const closed = history.find((p) => p.shopCode === 'М45' && p.to !== null);
  assert.equal(closed?.manager, 'Карабак Денис', 'один человек — одно имя во всей истории');
});

test('лавка без прежнего РМ считается за нынешним с самого начала', () => {
  // Новая лавка: в книге её нет вовсе. Иначе все её прошлые дни остались бы
  // без менеджера — хуже, чем датировать задним числом.
  const history = deriveRegionHistory(map({}), map({ М82: 'Ярцева Олеся' }));

  assert.equal(history.length, 1);
  assert.equal(history[0].to, null);
  assert.ok(history[0].from < '2026-08-19', `период начинается с ${history[0].from}`);
});

test('смена РМ фиксируется в базе: старый период закрывается, новый открывается', async () => {
  const seed = deriveRegionHistory(map({ М1: 'Осин' }), map({ М1: 'Осин Анатолий' }));

  // Первый проход: только посев, менеджер не менялся.
  const first = await db.reconcileRegionHistory(map({ М1: 'Осин Анатолий' }), seed, '2026-09-10');
  assert.equal(first?.length, 1, 'без смены новых периодов не появляется');

  // Второй проход: лавку передали другому — это уже смена.
  const second = await db.reconcileRegionHistory(map({ М1: 'Лясецкая Юлия' }), seed, '2026-09-10');
  const m1 = (second ?? []).filter((p) => p.shopCode === 'М1');
  assert.equal(m1.length, 2);

  const closed = m1.find((p) => p.to !== null);
  const open = m1.find((p) => p.to === null);
  assert.equal(closed?.manager, 'Осин Анатолий');
  assert.equal(closed?.to, '2026-09-09', 'прежний закрыт вчерашним днём');
  assert.equal(open?.manager, 'Лясецкая Юлия');
  assert.equal(open?.from, '2026-09-10');
});

test('повторная сверка ничего не меняет — история не растёт на ровном месте', async () => {
  const before = await db.reconcileRegionHistory(map({ М1: 'Лясецкая Юлия' }), [], '2026-09-11');
  const after = await db.reconcileRegionHistory(map({ М1: 'Лясецкая Юлия' }), [], '2026-09-12');

  assert.deepEqual(after, before, 'сверка без изменений идемпотентна');
});

test('в закоммиченном снимке ушедшие РМ сохранены за прошлыми днями', () => {
  // Ровно то, ради чего всё затевалось: Сурков и Договой нет в справочнике,
  // но за август они должны остаться на своих лавках.
  const snapshot = JSON.parse(
    fs.readFileSync(path.join(process.cwd(), 'src', 'generated', 'snapshot.json'), 'utf8'),
  ) as { regionHistory: { shopCode: string; manager: string; from: string; to: string | null }[] };

  const gone = snapshot.regionHistory.filter((p) => p.manager === 'Сурков' || p.manager === 'Догова');
  assert.ok(gone.length >= 9, `лавок у ушедших РМ ${gone.length}`);
  assert.ok(
    gone.every((p) => p.to === '2026-08-31'),
    'все они закрыты днём до смены справочника',
  );

  const current = new Set(
    snapshot.regionHistory.filter((p) => p.to === null).map((p) => p.manager),
  );
  assert.ok(!current.has('Сурков') && !current.has('Догова'), 'в действующих их быть не должно');
  assert.equal(current.size, 8, 'действующих РМ — восемь, как в справочнике');
});

test.after(() => fs.rmSync(dir, { recursive: true, force: true }));
