import test from 'node:test';
import assert from 'node:assert/strict';
import { applyStaffingRules } from './staffing-rules';
import { readStaffing } from './staffing-store';
import { findStaffNorm, postsLabel, type StaffNorm } from './staffing';
import seed from '../../fixtures/staffing-norms.json';

const raw = (seed as unknown as { norms: StaffNorm[] }).norms;

/** Лавка из сида с нужными числами в окнах и сборщиком или без. */
function shop(cashier: number, cook: number, cleaner: number, picker: number): StaffNorm {
  const n = structuredClone(raw.find((x) => x.code === 'М1')!);
  n.roles.cashier.slots[1].count = cashier;
  n.roles.cashier.slots[3].count = cashier;
  n.roles.cook.slots[1].count = cook;
  n.roles.cleaner.slots[0].count = cleaner;
  n.roles.picker.slots[0].count = picker;
  return n;
}
const label = (n: StaffNorm, role: 'cashier' | 'cook' | 'cleaner' | 'picker', i: number) =>
  postsLabel(applyStaffingRules([n])[0].roles[role].posts?.[i] ?? []);

test('правила: кассиры 6:30–7:30 — все на подготовке витрин', () => {
  assert.equal(label(shop(2, 3, 1, 0), 'cashier', 0), '2 подготовка витрин');
});

test('правила: кассиры 7:30–11 и 16–17:30 — официанты, один с доставкой', () => {
  assert.equal(label(shop(1, 3, 1, 0), 'cashier', 1), '1 официант + доставка');
  assert.equal(label(shop(2, 3, 1, 0), 'cashier', 1), '1 официант · 1 официант + доставка');
  assert.equal(label(shop(3, 3, 1, 0), 'cashier', 1), '2 официант · 1 официант + доставка');
  assert.equal(label(shop(4, 3, 1, 0), 'cashier', 3), '3 официант · 1 официант + доставка');
});

test('правила: есть сборщик (7–16) — доставка на нём, но в 16–17:30 его уже нет', () => {
  const n = shop(3, 3, 1, 1);
  assert.equal(label(n, 'cashier', 1), '3 официант');
  assert.equal(label(n, 'cashier', 3), '2 официант · 1 официант + доставка');
  assert.equal(label(n, 'picker', 0), '1 сборка заказов + доставка');
});

test('правила: повара 6:30–8 — витрины, 8–11 — завтраки, витрина, разогрев', () => {
  assert.equal(label(shop(2, 3, 1, 0), 'cook', 0), '2 подготовка витрин');
  assert.equal(label(shop(2, 1, 1, 0), 'cook', 1), '1 завтраки + витрина + разогрев');
  assert.equal(label(shop(2, 2, 1, 0), 'cook', 1), '1 завтраки · 1 витрина + разогрев');
  assert.equal(label(shop(2, 3, 1, 0), 'cook', 1), '1 завтраки · 1 витрина · 1 разогрев');
  assert.equal(label(shop(2, 4, 1, 0), 'cook', 1), '1 завтраки · 1 витрина · 2 разогрев');
});

test('правила: уборщики 7–8 — подготовка зала', () => {
  assert.equal(label(shop(2, 3, 1, 0), 'cleaner', 0), '1 уборка зала + посуда');
  assert.equal(label(shop(2, 3, 2, 0), 'cleaner', 0), '1 зал · 1 посуда');
  assert.equal(label(shop(2, 3, 3, 0), 'cleaner', 0), '1 зал · 2 посуда');
});

test('правила: в окнах без правила — как в книгах ТД; нормы правило не трогает', () => {
  const m4raw = raw.find((x) => x.code === 'М4')!;
  const m4 = findStaffNorm(readStaffing().norms, 'М4')!;
  assert.deepEqual(m4.roles.cashier.posts![2], m4raw.roles.cashier.posts![2], '11–16 — из книги');
  assert.deepEqual(m4.roles.cashier.slots, m4raw.roles.cashier.slots);
});

test('правила: без кофемашины нет зама по бару, с ней и «не указано» — есть', () => {
  const norms = readStaffing().norms;
  const m1 = findStaffNorm(norms, 'М1')!;
  assert.equal(m1.coffeeMachine, false);
  assert.deepEqual(m1.roles.barDeputy.slots.map((s) => s.count), [0]);
  assert.deepEqual(m1.roles.barDeputy.posts, [[]]);
  assert.equal(findStaffNorm(norms, 'М2')!.roles.barDeputy.slots[0].count, 1);
  const unknown = { ...structuredClone(raw.find((x) => x.code === 'М1')!), coffeeMachine: null };
  assert.equal(applyStaffingRules([unknown])[0].roles.barDeputy.slots[0].count, 1);
});
