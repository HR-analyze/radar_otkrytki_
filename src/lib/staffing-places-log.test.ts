import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// Своя база ручных данных на тест: журнал пишется в SQLite.
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'radar-staffing-places-'));
delete process.env.RADAR_STORAGE;
process.env.RADAR_MANUAL_DB_PATH = path.join(dir, 'manual.db');

test('журнал словаря: кто, когда, что было; «принять как есть» журнал не засоряет', async () => {
  const { savePlaceAliases, deletePlaceAlias, readPlaceAliases, readPlaceLog } = await import('./staffing-edits');

  await savePlaceAliases([{ place: 'Касса', name: 'касса' }], '2026-10-29T07:00:00.000Z', 'Андрей');
  assert.deepEqual(await readPlaceLog(), [], 'название не поменялось — не правка');

  await savePlaceAliases([{ place: 'разог', name: 'разогрев блюд' }], '2026-10-29T07:01:00.000Z', 'Андрей');
  await savePlaceAliases([{ place: 'разог', name: 'разогрев' }], '2026-10-29T07:02:00.000Z', 'Дима');
  await deletePlaceAlias('Разог', '2026-10-29T07:03:00.000Z', 'Дима');

  const log = await readPlaceLog();
  assert.deepEqual(
    log.map((e) => [e.author, e.place, e.oldName, e.newName]),
    [
      ['Дима', 'разог', 'разогрев', null],
      ['Дима', 'разог', 'разогрев блюд', 'разогрев'],
      ['Андрей', 'разог', null, 'разогрев блюд'],
    ],
  );
  assert.deepEqual(
    (await readPlaceAliases()).map((a) => a.place),
    ['касса'],
    'удалённой строки нет, остальные на месте',
  );
});

test('правка лавки — только функционалы из справочника; опечатка сводится к единому названию', async () => {
  const { restrictToCatalog } = await import('./staffing-edits');
  const { placeAliasMap } = await import('./staffing-places');
  const catalog = [
    { name: 'разогрев', roles: ['cook' as const] },
    { name: 'завтраки', roles: ['cook' as const] },
  ];
  const aliases = placeAliasMap([]);
  const ok = restrictToCatalog(
    {
      cook: {
        counts: [3, 1],
        posts: [
          [
            { count: 1, place: 'разог' },
            { count: 1, place: 'Разогрев' },
            { count: 1, place: 'завтраки' },
          ],
          null,
        ],
      },
    },
    catalog,
    aliases,
  );
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.roles.cook!.posts, [
    [
      { count: 2, place: 'разогрев' },
      { count: 1, place: 'завтраки' },
    ],
    null,
  ]);

  const bad = restrictToCatalog({ cook: { counts: [1], posts: [[{ count: 1, place: 'разогрев супа' }]] } }, catalog, aliases);
  assert.equal(bad.ok, false);
  assert.match(!bad.ok ? bad.error : '', /разогрев супа.*Функционалы/);
});
