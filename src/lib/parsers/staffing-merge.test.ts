import test from 'node:test';
import assert from 'node:assert/strict';
import { mergeStaffing } from './staffing-merge';
import { EXTRA_ROLES, EXTRA_ROLE_SLOT, TEMPLATE_ROLES, type StaffNorm, type StaffPost } from '../staffing';

function norm(code: string, cashier: number[], posts?: StaffPost[][]): StaffNorm {
  const roles = Object.fromEntries([
    ...TEMPLATE_ROLES.map((r) => [r, { slots: [{ from: 390, to: 450, count: 0 }], fte: null, hours: null }]),
    ...EXTRA_ROLES.map((r) => [r, { slots: [{ ...EXTRA_ROLE_SLOT[r] }], fte: null, hours: null }]),
  ]) as StaffNorm['roles'];
  roles.cashier = {
    slots: cashier.map((count, i) => ({ from: 390 + i * 60, to: 450 + i * 60, count })),
    fte: null,
    hours: null,
    ...(posts && { posts }),
  };
  return { code, name: code, grade: null, coffeeMachine: null, roles };
}

const counts = (n: StaffNorm | undefined) => n?.roles.cashier.slots.map((s) => s.count);

test('слияние книг: правка одной книги побеждает нетронутый шаблон остальных', () => {
  const plain = (name: string) => ({ name, norms: [norm('М1', [2, 4]), norm('М2', [2, 2])] });
  const edited = { name: 'тд', norms: [norm('М1', [2, 5]), norm('М2', [2, 2])] };

  const { norms, edits, conflicts } = mergeStaffing([plain('а'), edited, plain('б'), plain('в')]);
  assert.deepEqual(counts(norms[0]), [2, 5]);
  assert.deepEqual(counts(norms[1]), [2, 2]);
  assert.equal(edits.length, 1);
  assert.match(edits[0], /^М1 Кассир 7:30–8:30: 4 → 5 \(тд\)$/);
  assert.deepEqual(conflicts, []);
});

test('слияние книг: разные правки одной клетки — спор, остаётся большинство', () => {
  const books = [
    { name: 'а', norms: [norm('М1', [4])] },
    { name: 'б', norms: [norm('М1', [4])] },
    { name: 'в', norms: [norm('М1', [5])] },
    { name: 'г', norms: [norm('М1', [3])] },
  ];
  const { norms, conflicts } = mergeStaffing(books);
  assert.deepEqual(counts(norms[0]), [4]);
  assert.match(conflicts[0], /правки расходятся/);

  // Поровну — правка той книги, что указана позже.
  const tie = mergeStaffing([books[0], books[2]]);
  assert.deepEqual(counts(tie.norms[0]), [5]);
});

test('слияние книг: расстановка должности — целиком из последней книги, где она есть', () => {
  const early = [[{ count: 1, place: 'касса' }], [{ count: 2, place: 'прием' }]];
  const late = [[{ count: 2, place: 'линия' }], []];
  const { norms, conflicts } = mergeStaffing([
    { name: 'старая', norms: [norm('М1', [1, 2], early)] },
    { name: 'пустая', norms: [norm('М1', [1, 2])] },
    { name: 'новая', norms: [norm('М1', [1, 2], late)] },
  ]);
  // Второе окно не добирается из старой книги — должность целиком из новой.
  assert.deepEqual(norms[0].roles.cashier.posts, late);
  assert.equal(conflicts.length, 1);
  assert.match(conflicts[0], /М1 Кассир: расстановка разная в старая, новая — взята из новая/);
});

test('слияние книг: лавка, которой нет ни в одной книге, не пропадает', () => {
  const { norms, conflicts } = mergeStaffing([{ name: 'а', norms: [norm('М1', [1])] }], [norm('М81', [2])]);
  assert.deepEqual(norms.map((n) => n.code), ['М1', 'М81']);
  assert.match(conflicts[0], /М81: нет ни в одной книге/);
});
