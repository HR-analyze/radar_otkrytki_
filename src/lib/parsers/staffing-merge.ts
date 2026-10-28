import {
  STAFF_ROLES,
  STAFF_ROLE_TITLE,
  postsHeadcount,
  slotShortLabel,
  type StaffNorm,
  type StaffPost,
  type StaffRoleNorm,
} from '../staffing';

/**
 * Слияние нескольких книг «Шаблон по часам-пикам» в одни нормы.
 *
 * Книги приходят от разных людей: каждый берёт общий шаблон, расписывает
 * дислокации своих лавок и кое-где правит нормы («у М50 кассиров не 4, а 5»).
 * Остальные клетки у всех одинаковые. Отсюда правило для числа в клетке:
 *
 *   все книги согласны       → это число;
 *   одна книга отличается    → её правка (большинство — просто нетронутый
 *                              шаблон, а не голос против);
 *   отличаются по-разному    → спор: оставляем большинство и сообщаем;
 *   поровну (две книги)      → правка той, что указана позже.
 *
 * Дислокации не голосуют: у лавки они обычно в одной книге. Если в двух —
 * берём из книги, указанной позже, и сообщаем, если тексты разные. Берём
 * должность целиком из одной книги, а не окно за окном: иначе у кассиров
 * утро было бы расписано одним человеком, а вечер — другим.
 */

export interface StaffingBook {
  /** Как книгу называть в отчёте — обычно имя файла. */
  name: string;
  norms: StaffNorm[];
}

export interface StaffingMergeResult {
  norms: StaffNorm[];
  /** Принятые правки норм: «М50 Кассир 7:30–11: 4 → 5 (книга)». */
  edits: string[];
  /** Споры и пересечения: что взяли и почему. */
  conflicts: string[];
}

interface Vote<T> {
  book: string;
  value: T;
}

/** Итог голосования по одной клетке. */
function decide<T>(votes: Vote<T>[]): { value: T; edit?: { from: T; book: string }; conflict?: string } {
  const groups = new Map<string, { value: T; books: string[] }>();
  for (const v of votes) {
    const key = JSON.stringify(v.value);
    const g = groups.get(key) ?? { value: v.value, books: [] };
    g.books.push(v.book);
    groups.set(key, g);
  }
  if (groups.size === 1) return { value: votes[0].value };

  const sorted = [...groups.values()].sort((a, b) => b.books.length - a.books.length);
  const [top, second] = sorted;
  if (top.books.length === second.books.length) {
    // Поровну: правка той книги, что указана позже.
    const last = votes[votes.length - 1];
    const other = sorted.find((g) => JSON.stringify(g.value) !== JSON.stringify(last.value))!;
    return { value: last.value, edit: { from: other.value, book: last.book } };
  }
  const deviants = sorted.slice(1);
  if (deviants.length === 1) {
    return { value: deviants[0].value, edit: { from: top.value, book: deviants[0].books.join(', ') } };
  }
  return {
    value: top.value,
    conflict: `правки расходятся (${deviants.map((d) => `${fmt(d.value)} — ${d.books.join(', ')}`).join('; ')}), оставлено ${fmt(top.value)}`,
  };
}

const fmt = (v: unknown): string => (v == null ? 'пусто' : String(v));

export function mergeStaffing(books: StaffingBook[], base: readonly StaffNorm[] = []): StaffingMergeResult {
  const edits: string[] = [];
  const conflicts: string[] = [];

  const codes: string[] = [];
  for (const b of books) for (const n of b.norms) if (!codes.includes(n.code)) codes.push(n.code);

  const norms: StaffNorm[] = codes.map((code) => {
    const copies = books.flatMap((b) => {
      const n = b.norms.find((x) => x.code === code);
      return n ? [{ book: b.name, norm: n }] : [];
    });
    const pick = <T>(label: string, get: (n: StaffNorm) => T): T => {
      const d = decide(copies.map((c) => ({ book: c.book, value: get(c.norm) })));
      if (d.edit) edits.push(`${code} ${label}: ${fmt(d.edit.from)} → ${fmt(d.value)} (${d.edit.book})`);
      if (d.conflict) conflicts.push(`${code} ${label}: ${d.conflict}`);
      return d.value;
    };

    const first = copies[0].norm;
    const roles = Object.fromEntries(
      STAFF_ROLES.map((role) => {
        const title = STAFF_ROLE_TITLE[role];
        const slots = first.roles[role].slots.map((slot, i) => ({
          ...slot,
          count: pick(`${title} ${slotShortLabel(slot)}`, (n) => n.roles[role].slots[i]?.count ?? 0),
        }));
        const merged: StaffRoleNorm = {
          slots,
          fte: pick(`${title} FTE`, (n) => n.roles[role].fte),
          hours: pick(`${title} ЧЕЛ-КО часы`, (n) => n.roles[role].hours),
        };
        const posts = latest(
          copies.map((c) => ({ book: c.book, value: c.norm.roles[role].posts ?? [] })),
          `${code} ${title}`,
          conflicts,
          // Из разных расстановок — та, что сходится с нормой лавки.
          (p) => p.filter((w, i) => postsHeadcount(w, role) === slots[i]?.count).length,
        );
        // Должности в лавке по норме нет (кассиры у М16), а расстановка есть —
        // это строка, съехавшая из-под соседней лавки. Не берём.
        if (posts.length && slots.every((s) => s.count === 0)) {
          conflicts.push(`${code} ${title}: по норме никого, а расстановка есть — не взята (строка из-под соседней лавки?)`);
        } else if (posts.length) {
          merged.posts = slots.map((_, i) => posts[i] ?? []);
        }
        return [role, merged];
      }),
    ) as StaffNorm['roles'];

    const stations = latest(
      copies.map((c) => ({ book: c.book, value: c.norm.layout?.stations ?? [] })),
      `${code} рабочие места`,
      conflicts,
    );
    const remarks = [...new Set(copies.flatMap((c) => c.norm.layout?.remarks ?? []))];

    return {
      code,
      name: pick('название', (n) => n.name),
      grade: pick('грейд', (n) => n.grade),
      coffeeMachine: pick('кофемашина', (n) => n.coffeeMachine),
      roles,
      ...(stations.length || remarks.length ? { layout: { stations, remarks } } : {}),
    };
  });

  // Лавка, которой нет ни в одной книге, не пропадает молча: берём её из
  // прежних норм и сообщаем.
  for (const n of base) {
    if (codes.includes(n.code)) continue;
    norms.push(n);
    conflicts.push(`${n.code}: нет ни в одной книге — оставлена из прежних норм`);
  }

  return { norms, edits, conflicts };
}

/**
 * Расстановка из нескольких книг. С `score` — та, у которой больше окон
 * сходится с нормой лавки (число людей в постах = норма окна), при равенстве —
 * из книги, указанной позже; без `score` — просто последняя непустая.
 *
 * Зачем счёт: книги расписаны под фильтром Excel, и у книги, где фильтр
 * перед сохранением сняли, строки расстановки стоят под чужими лавками
 * (кассиры «линия/доставка» у М16, где кассиров по норме нет). Последней
 * такая книга быть может, а сходиться с нормой — нет.
 */
function latest<T extends StaffPost[] | StaffPost[][]>(
  values: Vote<T>[],
  label: string,
  conflicts: string[],
  score?: (posts: T) => number,
): T | [] {
  const filled = values.filter((v) => v.value.flat().length > 0);
  if (filled.length === 0) return [];
  let chosen = filled[filled.length - 1];
  if (score) {
    for (const v of filled) if (score(v.value) > score(chosen.value)) chosen = v;
  }
  const differs = filled.filter((v) => JSON.stringify(v.value) !== JSON.stringify(chosen.value));
  if (differs.length) {
    const why = score ? ` (сходится с нормой в ${score(chosen.value)} окн.)` : '';
    conflicts.push(`${label}: расстановка разная в ${[...differs.map((d) => d.book), chosen.book].join(', ')} — взята из ${chosen.book}${why}`);
  }
  return chosen.value;
}
