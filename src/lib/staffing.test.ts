import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaffing } from './staffing-store';
import { STAFF_ROLES, findStaffNorm, staffAt, staffAtAll } from './staffing';

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

test('«все лавки»: по каждой должности сумма норм всех лавок в этот момент', () => {
  const { norms } = readStaffing();
  for (const minutes of [7 * 60, 14 * 60, 23 * 60 + 30]) {
    const all = staffAtAll(norms, minutes);
    for (const [i, role] of STAFF_ROLES.entries()) {
      const sum = norms.reduce((s, n) => s + staffAt(n, minutes)[i].count, 0);
      assert.equal(all[i].role, role);
      assert.equal(all[i].count, sum, `${role} в ${minutes}`);
    }
  }
  assert.ok(staffAtAll(norms, 23 * 60 + 30).every((a) => a.count === 0 && a.slot == null), 'после 23:00 смены нет');
});
