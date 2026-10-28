import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStaffingEdits, parseStaffingEdit } from './staffing-edits';
import { readStaffing } from './staffing-store';
import { findStaffNorm } from './staffing';

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
