import test, { before } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** Своя база во временной папке: переменные — до первого импорта модуля. */
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-owners-'));
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');
process.env.RADAR_OWNERS_PATH = path.join(dir, 'owners.json');
fs.writeFileSync(
  process.env.RADAR_OWNERS_PATH,
  JSON.stringify({
    updatedAt: '2026-10-19T00:00:00.000Z',
    owners: [{ name: 'Оператор СБ 1', shops: ['M01', 'М02'] }],
  }),
);

let store: typeof import('./showcase-owners-store');
let pure: typeof import('./showcase-owners');
before(async () => {
  store = await import('./showcase-owners-store');
  pure = await import('./showcase-owners');
});

test('база наполняется из сида один раз, коды приведены к виду базы', async () => {
  const read = await store.readOwners();
  assert.equal(read.source, 'db');
  assert.deepEqual(read.owners, [{ name: 'Оператор СБ 1', shops: ['М1', 'М2'] }]);
  assert.equal(read.updatedAt, '2026-10-19T00:00:00.000Z');
});

test('сохранение заменяет список целиком, а убранный не возвращается из сида', async () => {
  const saved = await store.saveOwners([{ name: 'Гринь Анна', shops: ['М55'] }], {
    expectedUpdatedAt: '2026-10-19T00:00:00.000Z',
    now: '2026-10-19T10:00:00.000Z',
  });
  assert.deepEqual(saved.owners, [{ name: 'Гринь Анна', shops: ['М55'] }]);
  assert.equal(saved.updatedAt, '2026-10-19T10:00:00.000Z');
  assert.deepEqual((await store.readOwners()).owners, saved.owners);
});

test('сохранение поверх чужой правки отклоняется', async () => {
  await assert.rejects(
    store.saveOwners([], { expectedUpdatedAt: '2026-10-19T00:00:00.000Z' }),
    pure.OwnersConflictError,
  );
  assert.equal((await store.readOwners()).owners.length, 1, 'список не тронут');
});
