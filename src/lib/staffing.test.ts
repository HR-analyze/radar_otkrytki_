import test from 'node:test';
import assert from 'node:assert/strict';
import { readStaffing } from './staffing-store';
import {
  MONTH_DAYS,
  STAFF_HOURLY_RATE,
  STAFF_ROLES,
  dailyHours,
  findStaffNorm,
  monthlyHours,
  pay,
  rolePeak,
  roleTotals,
  slotPersonHours,
  sumRoleTotals,
  staffAt,
  staffAtAll,
  peopleToPosts,
  postsToPeople,
} from './staffing';

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

test('человеко-часы в день: человек в окне × длина окна, сложено за смену', () => {
  const m50 = findStaffNorm(readStaffing().norms, 'М50');
  assert.ok(m50, 'М50 нет в нормах');
  // 2·1 + 5·3,5 + 5·5 + 5·1,5 + 5·3,5 + 3·2 — у М50 кассиров 5: правка из книги ТД
  assert.equal(dailyHours(m50.roles.cashier.slots), 75.5);
  // 4·1,5 + 4·3 + 4·5 + 3·2 + 1·2 + 0·3
  assert.equal(dailyHours(m50.roles.cook.slots), 46);
  assert.equal(dailyHours([{ from: 390, to: 450, count: 1 }, { from: 450, to: 480, count: 1 }]), 1.5, 'полчаса — 0,5');
});

test('человеко-часы в день: окно «до N» без начала', () => {
  assert.equal(dailyHours([{ from: null, to: 480, count: 2 }, { from: 480, to: 660, count: 1 }]), null, 'длина окна неизвестна');
  assert.equal(dailyHours([{ from: null, to: 480, count: 0 }, { from: 480, to: 660, count: 1 }]), 3, 'пустое окно не мешает');
});

test('человеко-часы в месяц сходятся с днём: день × 31', () => {
  const { norms } = readStaffing();
  const m50 = findStaffNorm(norms, 'М50')!;
  assert.equal(monthlyHours(m50.roles.cashier.slots), 2340.5, '75,5 × 31');
  assert.equal(monthlyHours(m50.roles.cook.slots), 1426, '46 × 31');
  for (const n of norms) {
    for (const role of STAFF_ROLES) {
      const day = dailyHours(n.roles[role].slots);
      assert.equal(monthlyHours(n.roles[role].slots), day == null ? null : Math.round(day * MONTH_DAYS * 10) / 10, `${n.code}/${role}`);
    }
  }
  assert.equal(monthlyHours([{ from: null, to: 480, count: 1 }]), null, 'нет дня — нет и месяца');
});

test('деньги: человек × часы окна × 310 ₽, и окна в сумме дают день', () => {
  const { norms } = readStaffing();
  assert.deepEqual(
    STAFF_ROLES.map((role) => STAFF_HOURLY_RATE[role]),
    [310, 310, 310, 310, 350, 350, 280],
    'шаблон — 310 ₽/ч, замы — 350, сборщик — 280',
  );
  const m50 = findStaffNorm(norms, 'М50')!;
  const cashier = m50.roles.cashier;
  // 7:30–11, 5 кассиров: 5 × 3,5 × 310
  assert.equal(pay(slotPersonHours(cashier.slots[1]), 310), 5425);
  assert.equal(pay(dailyHours(cashier.slots), 310), 23405, '75,5 × 310');
  assert.equal(pay(monthlyHours(cashier.slots), 310), 725555, '2340,5 × 310');

  for (const n of norms) {
    for (const role of STAFF_ROLES) {
      const { slots } = n.roles[role];
      const rate = STAFF_HOURLY_RATE[role];
      const sum = slots.reduce((s, slot) => s + pay(slotPersonHours(slot), rate)!, 0);
      assert.equal(sum, pay(dailyHours(slots), rate), `${n.code}/${role}: окна не сходятся с днём`);
    }
  }
});

test('деньги: пустое окно — 0, окно «до N» без начала с людьми — неизвестно', () => {
  assert.equal(pay(slotPersonHours({ from: null, to: 480, count: 0 }), 310), 0);
  assert.equal(pay(slotPersonHours({ from: null, to: 480, count: 2 }), 310), null);
});

test('«ЧЕЛ-КО часы» из шаблона = (норма окна × норма окна у М1) × 31 — поэтому на сайте их нет', () => {
  // Фиксирует, откуда взялось число в шаблоне. Упадёт — значит, формулу в
  // книге поправили: тогда комментарий у StaffRoleNorm.hours пора переписать.
  const { norms } = readStaffing();
  const m1 = findStaffNorm(norms, 'М1')!;
  for (const n of norms) {
    for (const role of STAFF_ROLES) {
      const r = n.roles[role];
      if (r.hours == null) continue;
      const byM1 = r.slots.reduce((sum, s, i) => sum + s.count * m1.roles[role].slots[i].count, 0);
      assert.equal(r.hours, byM1 * MONTH_DAYS, `${n.code}/${role}`);
    }
  }
});

test('итоги должности: штат, часы и рубли, по сети — сумма, пик — по сумме окон', () => {
  const { norms } = readStaffing();
  const m50 = findStaffNorm(norms, 'М50')!;
  assert.deepEqual(roleTotals(m50.roles.cashier, 'cashier'), { fte: 10, day: 75.5, month: 2340.5, dayPay: 23405, monthPay: 725555 });

  const two = [m50, findStaffNorm(norms, 'М1')!];
  const sum = sumRoleTotals(two.map((n) => roleTotals(n.roles.cashier, 'cashier')));
  assert.deepEqual(sum, { fte: 16, day: 115, month: 3565, dayPay: 35650, monthPay: 1105150 });
  assert.equal(sumRoleTotals([{ fte: null, day: 1, month: 31, dayPay: 310, monthPay: 9610 }]).fte, null, 'без числа — неизвестно');

  // М50: кассиров по 5 с 7:30 до 21 — пик первое такое окно.
  const peak = rolePeak([m50], 'cashier')!;
  assert.equal(peak.count, 5);
  assert.equal(peak.slot.from, 450);
  assert.equal(rolePeak([findStaffNorm(norms, 'М1')!], 'barista'), null, 'в М1 бариста нет');
});

test('правка лавки по человеку: посты ↔ функционал каждого', () => {
  assert.deepEqual(postsToPeople([{ count: 2, place: 'официант' }, { count: 1, place: 'касса' }], 4), [
    'официант',
    'официант',
    'касса',
    '',
  ]);
  // Пост без числа — все оставшиеся люди окна.
  assert.deepEqual(postsToPeople([{ count: null, place: 'бар + касса' }], 2), ['бар + касса', 'бар + касса']);
  assert.deepEqual(postsToPeople([{ count: null, place: 'бар + касса' }], 0), ['бар + касса']);
  // Расписано больше нормы — строк столько, сколько расписано.
  assert.equal(postsToPeople([{ count: 3, place: 'официант' }, { count: 1, place: 'касса' }], 3).length, 4);
  assert.deepEqual(postsToPeople([], 2), ['', '']);

  assert.deepEqual(peopleToPosts(['официант', 'касса', '', 'Официант']), [
    { count: 2, place: 'официант' },
    { count: 1, place: 'касса' },
  ]);
  assert.deepEqual(peopleToPosts(['', '']), []);
});
