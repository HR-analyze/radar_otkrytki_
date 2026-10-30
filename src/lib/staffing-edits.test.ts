import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStaffingEdits, parseStaffingEdit } from './staffing-edits';
import { readStaffing, readStaffingBook } from './staffing-store';
import { findStaffNorm, postsLabel } from './staffing';

const { norms } = readStaffing();
const m50 = findStaffNorm(norms, 'М50')!;

test('правка с сайта перекрывает числа и посты лавки, остальные лавки — по шаблону', () => {
  const counts = [3, 5, 6, 5, 5, 3];
  const posts = [[{ count: 3, place: 'кулинария' }], [], [], [], [], []];
  const [edited] = applyStaffingEdits([m50], [{ shopCode: 'М50', roles: { cashier: { counts, posts } }, updatedAt: '2026-10-28T12:00:00Z' }]);
  assert.deepEqual(edited.roles.cashier.slots.map((s) => s.count), counts);
  assert.deepEqual(edited.roles.cashier.posts, posts);
  assert.deepEqual(edited.roles.cashier.slots.map((s) => s.from), m50.roles.cashier.slots.map((s) => s.from), 'окна не двигаются');
  assert.equal(edited.roles.cook, m50.roles.cook, 'нетронутая должность — как в шаблоне');
  assert.equal(edited.editedAt, '2026-10-28T12:00:00Z');

  // Окон в правке не столько, сколько в шаблоне, — правка должности не подходит.
  const [stale] = applyStaffingEdits([m50], [{ shopCode: 'М50', roles: { cashier: { counts: [1], posts: [] } }, updatedAt: 'x' }]);
  assert.equal(stale.roles.cashier, m50.roles.cashier);
});

test('правка из запроса: проверка чисел и мест, кондитерка = кулинария', () => {
  const ok = parseStaffingEdit(m50, {
    roles: { cashier: { counts: [2, 5, 5, 5, 5, 3], posts: [[{ count: 1, place: 'кондитерка' }], [], [], [], [], []] } },
  });
  assert.ok(ok.ok);
  assert.deepEqual(ok.ok && ok.roles.cashier!.posts[0], [{ count: 1, place: 'кулинария' }]);

  for (const bad of [
    { cashier: { counts: [1, 2], posts: [] } },
    { cashier: { counts: [2, 5, 5, 5, 5, -1], posts: [] } },
    { cashier: { counts: [2, 5, 5, 5, 5, 1.5], posts: [] } },
    { cashier: { counts: [2, 5, 5, 5, 5, 3], posts: [[{ count: 1, place: 'х'.repeat(81) }]] } },
  ]) {
    assert.equal(parseStaffingEdit(m50, { roles: bad }).ok, false, JSON.stringify(bad).slice(0, 60));
  }
  assert.equal(parseStaffingEdit(m50, {}).ok, false);
});

test('правка времени окон: окно сдвигается, наезды и перевёрнутые окна — ошибка', () => {
  const counts = m50.roles.cashier.slots.map((s) => s.count);
  const times = [['06:30', '07:30'], ['07:30', '11:30'], ['11:30', '16:00'], ['16:00', '17:30'], ['17:30', '21:00'], ['21:00', '23:00']];
  const ok = parseStaffingEdit(m50, { roles: { cashier: { counts, posts: [], times } } });
  assert.ok(ok.ok);
  const [edited] = applyStaffingEdits([m50], [{ shopCode: 'М50', roles: ok.ok ? ok.roles : {}, updatedAt: 'x' }]);
  assert.deepEqual(edited.roles.cashier.slots[1], { from: 450, to: 690, count: counts[1] }, '7:30–11:30');
  assert.equal(edited.roles.cashier.slots[2].from, 690);

  const bad = (t: string[][]) => parseStaffingEdit(m50, { roles: { cashier: { counts, posts: [], times: t } } }).ok;
  assert.equal(bad([['06:30', '07:30'], ['07:00', '11:00'], ...times.slice(2)]), false, 'наезд 7:00 < 7:30');
  assert.equal(bad([['07:30', '06:30'], ...times.slice(1)]), false, 'начало позже конца');
  assert.equal(bad(times.slice(1)), false, 'окон меньше, чем в шаблоне');
  assert.equal(bad([['6:3', '07:30'], ...times.slice(1)]), false, 'не время');

  // Старые правки без времени — окна как в шаблоне.
  const [old] = applyStaffingEdits([m50], [{ shopCode: 'М50', roles: { cashier: { counts, posts: [] } }, updatedAt: 'x' }]);
  assert.deepEqual(old.roles.cashier.slots.map((s) => [s.from, s.to]), m50.roles.cashier.slots.map((s) => [s.from, s.to]));
});

test('правка не замораживает правила: нетронутые окна и копии книги — по правилу', () => {
  const book = readStaffingBook().norms;
  const ruled = readStaffing().norms;
  const bookM50 = book.find((n) => n.code === 'М50')!;
  const ruledM50 = ruled.find((n) => n.code === 'М50')!;
  const counts = ruledM50.roles.cook.slots.map((s) => s.count);
  const mine = [{ count: 4, place: 'кухня' }];

  // Старая правка сохранила расстановку целиком: 8–11 — копия книги, 11–16 — своё.
  const legacy = ruledM50.roles.cook.slots.map((_, i) => bookM50.roles.cook.posts?.[i] ?? []);
  legacy[2] = mine;
  const [a] = applyStaffingEdits(ruled.filter((n) => n.code === 'М50'), [
    { shopCode: 'М50', roles: { cook: { counts, posts: legacy } }, updatedAt: 'x' },
  ], book);
  assert.deepEqual(a.roles.cook.posts![1], ruledM50.roles.cook.posts![1], '8–11: копия книги уступает правилу');
  assert.match(postsLabel(a.roles.cook.posts![1]), /завтраки/);
  assert.deepEqual(a.roles.cook.posts![2], mine, '11–16: настоящая правка остаётся');

  // Новая правка: нетронутые окна — null.
  const fresh = ruledM50.roles.cook.slots.map(() => null) as (null | typeof mine)[];
  fresh[3] = mine;
  const [b] = applyStaffingEdits(ruled.filter((n) => n.code === 'М50'), [
    { shopCode: 'М50', roles: { cook: { counts, posts: fresh } }, updatedAt: 'x' },
  ], book);
  assert.deepEqual(b.roles.cook.posts![0], ruledM50.roles.cook.posts![0], '6:30–8 — по правилу');
  assert.deepEqual(b.roles.cook.posts![3], mine);

  const parsed = parseStaffingEdit(ruledM50, { roles: { cook: { counts, posts: fresh } } });
  assert.ok(parsed.ok && parsed.roles.cook!.posts[0] === null, 'null из формы доезжает до базы как null');
});

test('старая правка «2-подготовка витрин» без числа читается как 2 человека', () => {
  const m1 = findStaffNorm(norms, 'М1')!;
  const counts = m1.roles.cook.slots.map((s) => s.count);
  const [edited] = applyStaffingEdits(
    [m1],
    [
      {
        shopCode: 'М1',
        updatedAt: '2026-10-28T13:08:29.447Z',
        roles: {
          cook: {
            counts,
            posts: m1.roles.cook.slots.map((_, i) =>
              i === 0
                ? [
                    { count: null, place: '2-подготовка витрин' },
                    { count: null, place: '1 - посуда' },
                    { count: null, place: '11*-16*' },
                  ]
                : null,
            ),
          },
        },
      },
    ],
  );
  assert.deepEqual(edited.roles.cook.posts![0], [
    { count: 2, place: 'подготовка витрин' },
    { count: 1, place: 'посуда' },
    { count: null, place: '11*-16*' },
  ]);
});
