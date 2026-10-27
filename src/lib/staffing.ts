import { formatClock } from './time';

/**
 * Норма выхода сотрудников: сколько человек каждой должности должно быть на
 * смене в лавке в каждом часовом окне.
 *
 * Источник — лист «Шаблон по часам-пикам» (см. parsers/staffing.ts). У каждой
 * должности свои окна: у кассира 6:30–7:30, 7:30–11, 11–16…, у повара «до 8»,
 * 8–11, 11–16… — поэтому окна хранятся у должности, а не общей сеткой.
 *
 * Модуль без зависимостей от сервера: калькулятор «сколько должно быть сейчас»
 * считает прямо в браузере, без похода за данными на каждую смену времени.
 */

export type StaffRole = 'cashier' | 'cook' | 'barista' | 'cleaner';

/** Порядок — как в шаблоне: так таблицу на сайте легко сверить с Excel. */
export const STAFF_ROLES: readonly StaffRole[] = ['cashier', 'cook', 'barista', 'cleaner'];

export const STAFF_ROLE_TITLE: Record<StaffRole, string> = {
  cook: 'Повар',
  cashier: 'Кассир',
  barista: 'Бариста',
  cleaner: 'Уборщик',
};

/** Склонение для ответа калькулятора: «2 повара», «5 кассиров». */
export const STAFF_ROLE_FORMS: Record<StaffRole, [string, string, string]> = {
  cook: ['повар', 'повара', 'поваров'],
  cashier: ['кассир', 'кассира', 'кассиров'],
  barista: ['бариста', 'бариста', 'бариста'],
  cleaner: ['уборщик', 'уборщика', 'уборщиков'],
};

/** Часовое окно и сколько человек в нём должно быть. */
export interface StaffSlot {
  /**
   * Начало окна, минуты от полуночи. null — «до 8»: окно открывается с начала
   * смены, сколько бы рано она ни начиналась.
   */
  from: number | null;
  /** Конец окна, минуты от полуночи, не включительно: в 11:00 уже окно «11–16». */
  to: number;
  count: number;
}

export interface StaffRoleNorm {
  /** Окна по порядку, как в шаблоне. */
  slots: StaffSlot[];
  /** Штатных единиц (FTE) на должность; null — в шаблоне пусто. */
  fte: number | null;
  /**
   * Человеко-часы за месяц — колонка «ЧЕЛ-КО часы» как есть; null — в шаблоне
   * пусто. На сайте не показывается, вместо неё `monthlyHours`: во всех лавках
   * это число равно сумме «норма окна × норма того же окна у М1» × 31, то есть
   * вместо длины окон шаблон берёт строку М1. Отсюда и 0 у бариста: в М1
   * кофемашины нет.
   */
  hours: number | null;
}

export interface StaffNorm {
  /** Код лавки: «М1». */
  code: string;
  /** Название без кода: «Милютинский». */
  name: string;
  /** Грейд по товарообороту: «10-14 млн». */
  grade: string | null;
  /** Есть ли кофемашина — от неё зависит, нужен ли бариста. */
  coffeeMachine: boolean | null;
  roles: Record<StaffRole, StaffRoleNorm>;
}

/** Ответ калькулятора по одной должности. */
export interface StaffAt {
  role: StaffRole;
  count: number;
  /** Окно, в которое попало время; null — вне окон шаблона (до или после смены). */
  slot: StaffSlot | null;
}

/** Окно, в которое попадает момент `minutes`; начало включительно, конец — нет. */
export function slotAt(slots: readonly StaffSlot[], minutes: number): StaffSlot | null {
  return slots.find((s) => (s.from == null || minutes >= s.from) && minutes < s.to) ?? null;
}

/** Сколько человек каждой должности должно быть на смене в момент `minutes`. */
export function staffAt(norm: StaffNorm, minutes: number): StaffAt[] {
  return STAFF_ROLES.map((role) => {
    const slot = slotAt(norm.roles[role].slots, minutes);
    return { role, count: slot?.count ?? 0, slot };
  });
}

/**
 * То же по всем лавкам сразу: сколько человек должно быть на смене по сети.
 * Окна в шаблоне одни на все лавки, поэтому окно берём у первой лавки — оно
 * нужно только для подписи, а `count` у него не тот, что в ответе.
 */
export function staffAtAll(norms: readonly StaffNorm[], minutes: number): StaffAt[] {
  const each = norms.map((n) => staffAt(n, minutes));
  return STAFF_ROLES.map((role, i) => ({
    role,
    count: each.reduce((sum, at) => sum + at[i].count, 0),
    slot: each[0]?.[i].slot ?? null,
  }));
}

/**
 * Человеко-часы за день по окнам: сколько человек в окне × длина окна в часах,
 * сложено за смену. У М50 кассиры 2·1 + 4·3,5 + 4·5 + 4·1,5 + 4·3,5 + 3·2 = 62.
 *
 * null — есть окно «до N» без начала, а люди в нём есть: длину такого окна не
 * знаем, и сумма вышла бы заниженной. Пустое окно без начала ничего не меняет.
 * Считаем в минутах и делим один раз — до десятых часа.
 */
export function dailyHours(slots: readonly StaffSlot[]): number | null {
  let minutes = 0;
  for (const s of slots) {
    if (s.count === 0) continue;
    if (s.from == null) return null;
    minutes += s.count * (s.to - s.from);
  }
  return Math.round(minutes / 6) / 10;
}

/** Дней в месяце для человеко-часов — как в шаблоне, он умножает на 31. */
export const MONTH_DAYS = 31;

/**
 * Человеко-часы за месяц: день × 31. Колонку шаблона не берём — она посчитана
 * не от длины окон (см. StaffRoleNorm.hours), и с днём не сходилась бы.
 */
export function monthlyHours(slots: readonly StaffSlot[]): number | null {
  const day = dailyHours(slots);
  return day == null ? null : Math.round(day * MONTH_DAYS * 10) / 10;
}

/**
 * Ставка в час, ₽. Сейчас у всех четырёх должностей одна — 310 ₽, но держим
 * по должности: поменяется у кого-то одного — правится одна строка.
 */
export const STAFF_HOURLY_RATE: Record<StaffRole, number> = {
  cashier: 310,
  cook: 310,
  barista: 310,
  cleaner: 310,
};

/** Человеко-часы окна: человек × длина окна. null — окно «до N» без начала, а люди в нём есть. */
export function slotPersonHours(slot: StaffSlot): number | null {
  if (slot.count === 0) return 0;
  return slot.from == null ? null : (slot.count * (slot.to - slot.from)) / 60;
}

/** Сколько заработают за эти человеко-часы по ставке, ₽, до рубля. */
export function pay(personHours: number | null, rate: number): number | null {
  return personHours == null ? null : Math.round(personHours * rate);
}

/** «11:00–16:00», «до 08:00». */
export function slotLabel(slot: StaffSlot): string {
  return slot.from == null ? `до ${formatClock(slot.to)}` : `${formatClock(slot.from)}–${formatClock(slot.to)}`;
}

/** Короткая подпись для шапки таблицы: «6:30–7:30», «11–16», «до 8». */
export function slotShortLabel(slot: StaffSlot): string {
  const short = (m: number) => (m % 60 === 0 ? String(m / 60) : `${Math.floor(m / 60)}:${String(m % 60).padStart(2, '0')}`);
  return slot.from == null ? `до ${short(slot.to)}` : `${short(slot.from)}–${short(slot.to)}`;
}

/** «06:30» → 390; всё, что не время суток, — null. */
export function parseTimeOfDay(value: string | undefined | null): number | null {
  const m = /^(\d{1,2}):(\d{2})$/.exec(String(value ?? '').trim());
  if (!m) return null;
  const h = Number(m[1]);
  const min = Number(m[2]);
  return h < 24 && min < 60 ? h * 60 + min : null;
}

/**
 * Лавка по запросу из адреса: точный код («М1», «м01»), иначе первая, чьё
 * название содержит запрос. Со сводки и радара в ссылку едет их поиск по
 * лавке — он бывает и кодом, и куском названия.
 */
export function findStaffNorm(norms: readonly StaffNorm[], query: string | undefined | null): StaffNorm | null {
  const q = String(query ?? '').trim().toLowerCase();
  if (!q) return null;
  const code = q.replace(/\s+/g, '').replace(/^m/, 'м').replace(/^([а-яa-z]+)0+(\d)/, '$1$2');
  return (
    norms.find((n) => n.code.toLowerCase() === code) ??
    norms.find((n) => `${n.code} ${n.name}`.toLowerCase().includes(q)) ??
    null
  );
}
