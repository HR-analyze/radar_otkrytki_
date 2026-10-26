import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaffing } from './staffing-store';
import { STAFF_ROLES, findStaffNorm, staffAt } from './staffing';

test('нормы выхода из репозитория: у каждой лавки все должности и окна по порядку', () => {
  const { norms } = readStaffing();
  assert.ok(norms.length >= 80, `лавок всего ${norms.length}`);
  assert.equal(new Set(norms.map((n) => n.code)).size, norms.length, 'лавка встречается дважды');

  for (const n of norms) {
    for (const role of STAFF_ROLES) {
      const slots = n.roles[role].slots;
      assert.ok(slots.length > 0, `${n.code}: нет окон у «${role}»`);
      for (let i = 1; i < slots.length; i++) {
        assert.equal(slots[i].from, slots[i - 1].to, `${n.code}/${role}: окна идут с дырой или внахлёст`);
      }
    }
  }
});

test('в обед в М1 на смене есть и кассиры, и повара', () => {
  const m1 = findStaffNorm(readStaffing().norms, 'М1');
  assert.ok(m1, 'М1 нет в нормах');
  const at = Object.fromEntries(staffAt(m1, 14 * 60).map((a) => [a.role, a.count]));
  assert.ok(at.cashier > 0 && at.cook > 0, JSON.stringify(at));
});
