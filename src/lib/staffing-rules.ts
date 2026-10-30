import type { StaffNorm, StaffPost, StaffRole, StaffSlot } from './staffing';

/**
 * Расстановка по правилам руководства (28.10.2026, лист от руки и голосовое).
 *
 * В окнах, где правило есть, оно главнее того, что ТД вписали в книги: схема
 * одна на всю сеть, а книги расписаны кто во что горазд. Правка на сайте под
 * паролем (staffing-edits.ts) ложится поверх и главнее правила. В остальных
 * окнах — как в книгах.
 *
 *   кассиры   6:30–7:30   все — подготовка витрин, сколько бы их ни было;
 *             7:30–11,    все — официанты, один из них «официант + доставка»;
 *             16–17:30    пока на смене сборщик заказов (7–16), доставка на нём,
 *                         и кассиры — все официанты;
 *   повара    6:30–8      все — подготовка витрин;
 *             8–11        1 завтраки, 1 витрина, 1 разогрев; двое — завтраки и
 *                         «витрина + разогрев»; один — всё на нём; четверо и
 *                         больше — лишние на разогрев;
 *   уборщики  7–8         подготовка зала: один — уборка зала + посуда; двое —
 *                         1 зал, 1 посуда; трое — 1 зал, 2 посуда;
 *   сборщик               если есть — сборка заказов и доставка;
 *   ЗД по бару            нет кофемашины — нет бара и зама по бару (30.10.2026).
 *
 * Окно правила узнаём по точному началу и концу: сдвинет новый шаблон окно —
 * правило к нему не приложится, и останется расстановка из книги.
 */

const at = (h: number, m = 0) => h * 60 + m;

type Rule = (count: number, ctx: { picker: StaffSlot | null; slot: StaffSlot }) => StaffPost[];

const post = (count: number, place: string): StaffPost => ({ count, place });

const RULES: { role: StaffRole; from: number; to: number; rule: Rule }[] = [
  { role: 'cashier', from: at(6, 30), to: at(7, 30), rule: (n) => [post(n, 'подготовка витрин')] },
  { role: 'cashier', from: at(7, 30), to: at(11), rule: waiters },
  { role: 'cashier', from: at(16), to: at(17, 30), rule: waiters },
  { role: 'cook', from: at(6, 30), to: at(8), rule: (n) => [post(n, 'подготовка витрин')] },
  {
    role: 'cook',
    from: at(8),
    to: at(11),
    rule: (n) =>
      n === 1
        ? [post(1, 'завтраки + витрина + разогрев')]
        : n === 2
          ? [post(1, 'завтраки'), post(1, 'витрина + разогрев')]
          : [post(1, 'завтраки'), post(1, 'витрина'), post(n - 2, 'разогрев')],
  },
  {
    role: 'cleaner',
    from: at(7),
    to: at(8),
    rule: (n) => (n === 1 ? [post(1, 'уборка зала + посуда')] : [post(1, 'зал'), post(n - 1, 'посуда')]),
  },
];

/** Официанты, один из них с доставкой — если доставку не забрал сборщик. */
function waiters(n: number, { picker, slot }: { picker: StaffSlot | null; slot: StaffSlot }): StaffPost[] {
  const pickerOnShift =
    picker != null && picker.count > 0 && picker.from != null && slot.from != null && picker.from <= slot.from && slot.to <= picker.to;
  if (pickerOnShift) return [post(n, 'официант')];
  return n === 1 ? [post(1, 'официант + доставка')] : [post(n - 1, 'официант'), post(1, 'официант + доставка')];
}

/** Сборщик, если он есть: на нём сборка заказов и вся доставка, пока он на смене. */
const PICKER_POSTS = (n: number): StaffPost[] => [post(n, 'сборка заказов + доставка')];

/** Нормы с расстановкой по правилам в тех окнах, где правило есть. */
export function applyStaffingRules(norms: readonly StaffNorm[]): StaffNorm[] {
  return norms.map((n) => {
    const picker = n.roles.picker.slots[0] ?? null;
    const roles = { ...n.roles };
    for (const { role, from, to, rule } of RULES) {
      const r = roles[role];
      const i = r.slots.findIndex((s) => s.from === from && s.to === to);
      if (i < 0) continue;
      const slot = r.slots[i];
      const posts = r.slots.map((_, k) => r.posts?.[k] ?? []);
      posts[i] = slot.count > 0 ? rule(slot.count, { picker, slot }) : [];
      roles[role] = { ...r, posts };
    }
    if (picker && picker.count > 0) roles.picker = { ...roles.picker, posts: [PICKER_POSTS(picker.count)] };
    return { ...n, roles };
  }).map(withoutBarDeputy);
}

/**
 * Нет кофемашины — нет бара, и зам по бару там не нужен: норма 0, постов нет.
 * Кофемашина «не указано» (null) зама не убирает. Вызывается и после правок
 * сайта (staffing-edits.ts): до 30.10.2026 форма сохраняла зама по бару
 * каждой лавке, и старая правка вернула бы его.
 */
export function withoutBarDeputy(n: StaffNorm): StaffNorm {
  if (n.coffeeMachine !== false) return n;
  const r = n.roles.barDeputy;
  return {
    ...n,
    roles: { ...n.roles, barDeputy: { ...r, slots: r.slots.map((s) => ({ ...s, count: 0 })), posts: r.slots.map(() => []) } },
  };
}
