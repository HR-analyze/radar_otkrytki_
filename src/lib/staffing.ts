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

export type TemplateRole = 'cashier' | 'cook' | 'barista' | 'cleaner';
export type ExtraRole = 'barDeputy' | 'hallDeputy' | 'sousChef' | 'picker';
export type StaffRole = TemplateRole | ExtraRole;

/** Должности из шаблона: у каждой свои окна. Порядок — как в шаблоне. */
export const TEMPLATE_ROLES: readonly TemplateRole[] = ['cashier', 'cook', 'barista', 'cleaner'];

/**
 * Должности, которых в шаблоне нет: у каждой одно окно на весь день.
 *
 *   зам по бару — по одному в лавке с кофемашиной, 6:30–18:00 (без неё —
 *                 никого, см. staffing-rules.ts);
 *   зам по залу — всегда по одному в каждой лавке, 6:30–23:00 (до закрытия);
 *   су-шеф                 — где он есть в «ШР по лавкам», 6:30–23:00; бывает
 *                            и 0,5 (М35, М68 в ШР 30.10.2026) — так и считаем;
 *   сборщик заказов        — где он есть в «ШР по лавкам», 7:00–16:00.
 */
export const EXTRA_ROLES: readonly ExtraRole[] = ['barDeputy', 'hallDeputy', 'sousChef', 'picker'];

/**
 * Порядок должностей в расстановке — на вкладке, в правке и в PDF: замы
 * сверху, су-шеф под поварами (он на кухне), сборщик внизу.
 */
export const LAYOUT_ROLES: readonly StaffRole[] = [
  'barDeputy',
  'hallDeputy',
  'cashier',
  'cook',
  'sousChef',
  'barista',
  'cleaner',
  'picker',
];

export const STAFF_ROLES: readonly StaffRole[] = [...TEMPLATE_ROLES, ...EXTRA_ROLES];

export function isExtraRole(role: StaffRole): role is ExtraRole {
  return (EXTRA_ROLES as readonly StaffRole[]).includes(role);
}

/** Окно дополнительной должности; count — сколько, если не берётся из ШР. */
export const EXTRA_ROLE_SLOT: Record<ExtraRole, StaffSlot> = {
  barDeputy: { from: 6 * 60 + 30, to: 18 * 60, count: 1 },
  hallDeputy: { from: 6 * 60 + 30, to: 23 * 60, count: 1 },
  sousChef: { from: 6 * 60 + 30, to: 23 * 60, count: 0 },
  picker: { from: 7 * 60, to: 16 * 60, count: 0 },
};

export const STAFF_ROLE_TITLE: Record<StaffRole, string> = {
  cook: 'Повар',
  cashier: 'Кассир',
  barista: 'Бариста',
  cleaner: 'Уборщик',
  barDeputy: 'ЗД по бару',
  hallDeputy: 'ЗД по залу',
  sousChef: 'Су-шеф',
  picker: 'Сборщик заказов',
};

/** Короткое название — для шапки таблицы, где на колонку пара сантиметров. */
export const STAFF_ROLE_SHORT: Record<StaffRole, string> = {
  cook: 'Повар',
  cashier: 'Кассир',
  barista: 'Бариста',
  cleaner: 'Уборщик',
  barDeputy: 'ЗД бар',
  hallDeputy: 'ЗД зал',
  sousChef: 'Су-шеф',
  picker: 'Сборщик',
};

/** Склонение для ответа калькулятора: «2 повара», «5 кассиров». */
export const STAFF_ROLE_FORMS: Record<StaffRole, [string, string, string]> = {
  cook: ['повар', 'повара', 'поваров'],
  cashier: ['кассир', 'кассира', 'кассиров'],
  barista: ['бариста', 'бариста', 'бариста'],
  cleaner: ['уборщик', 'уборщика', 'уборщиков'],
  barDeputy: ['зам по бару', 'зама по бару', 'замов по бару'],
  hallDeputy: ['зам по залу', 'зама по залу', 'замов по залу'],
  sousChef: ['су-шеф', 'су-шефа', 'су-шефов'],
  picker: ['сборщик', 'сборщика', 'сборщиков'],
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
  /**
   * Число по шаблону, если правка с сайта его поменяла (см. applyStaffingEdits).
   * Форма правки сравнивает с ним: совпало — окно не правили, null в правку.
   */
  template?: number;
}

export interface StaffRoleNorm {
  /** Окна по порядку, как в шаблоне. */
  slots: StaffSlot[];
  /** Штатных единиц (FTE) на должность; null — в шаблоне пусто. */
  fte: number | null;
  /**
   * Человеко-часы за месяц — колонка «ЧЕЛ-КО часы» как есть; null — в шаблоне
   * пусто. На сайте не показывается, вместо неё `monthlyHours`. В финальной
   * книге 30.10.2026 это и есть день × 31, округлённый до часа; в прежних
   * книгах вместо длины окон бралась строка М1 («норма окна × норма того же
   * окна у М1» × 31), и с днём колонка не сходилась.
   */
  hours: number | null;
  /**
   * Дислокации: кто где стоит в каждом окне, параллельно `slots` —
   * posts[i] относится к slots[i]. Пустой массив — для окна не расписано;
   * поля нет — для лавки не расписано вовсе.
   */
  posts?: StaffPost[][];
}

/**
 * Пост — «2 прием», «1 кулинария, хлебка», «ЗД бар касса». Число людей есть
 * не всегда: «ЗД зал касса» — это зам, его в число кассиров не считаем.
 */
export interface StaffPost {
  count: number | null;
  place: string;
}

/** Расстановка лавки целиком — то, что вписано под ней вне колонок окон. */
export interface StaffLayout {
  /** Рабочие места лавки: «2 кассы / 3 приема / ЗД бар / сборщик». */
  stations: StaffPost[];
  /** Пометки: «завтраки до 14 и 16», «не хватает 1 кассира…». */
  remarks: string[];
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
  /** Расстановка; поля нет — лавку ещё не расписали. */
  layout?: StaffLayout;
  /** Когда лавку правили на сайте (ISO); поля нет — лавка по шаблону. */
  editedAt?: string;
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
  // До сотых: «0,5 су-шефа» на 16,5 часа — 8,25 ч, до десятых было бы 8,3, и
  // рубли за день разошлись бы с суммой окон.
  return Math.round(minutes / 0.6) / 100;
}

/** Дней в месяце для человеко-часов — как в шаблоне, он умножает на 31. */
export const MONTH_DAYS = 31;

/**
 * Человеко-часы за месяц: день × 31. Колонку шаблона не берём: она округлена
 * до часа (1224,5 → 1225), а в прежних книгах была посчитана не от длины окон
 * (см. StaffRoleNorm.hours).
 */
export function monthlyHours(slots: readonly StaffSlot[]): number | null {
  const day = dailyHours(slots);
  return day == null ? null : Math.round(day * MONTH_DAYS * 10) / 10;
}

/**
 * Ставка в час, ₽, по должности: у четырёх должностей шаблона — 310 ₽, у
 * замов и су-шефа — 350 ₽, у сборщика — 280 ₽. Поменяется у кого-то —
 * правится строка.
 */
export const STAFF_HOURLY_RATE: Record<StaffRole, number> = {
  cashier: 310,
  cook: 310,
  barista: 310,
  cleaner: 310,
  // Замы — 350 ₽/ч по постановке; су-шеф — 350 ₽/ч и сборщик — 280 ₽/ч,
  // как в шапке «ШР по лавкам».
  barDeputy: 350,
  hallDeputy: 350,
  sousChef: 350,
  picker: 280,
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

/**
 * Итоги должности в лавке: штат, человеко-часы и заработок за день и месяц.
 * null — посчитать нельзя (FTE в шаблоне пусто, окно «до N» без начала).
 */
export interface StaffRoleTotals {
  fte: number | null;
  day: number | null;
  month: number | null;
  dayPay: number | null;
  monthPay: number | null;
}

export function roleTotals(norm: StaffRoleNorm, role: StaffRole): StaffRoleTotals {
  const rate = STAFF_HOURLY_RATE[role];
  const day = dailyHours(norm.slots);
  const month = monthlyHours(norm.slots);
  return { fte: norm.fte, day, month, dayPay: pay(day, rate), monthPay: pay(month, rate) };
}

/**
 * Сумма итогов по лавкам — для строки «Итого по сети». Одна лавка без числа
 * делает сумму неизвестной: «итого» без неё было бы заниженным, а не итогом.
 */
export function sumRoleTotals(list: readonly StaffRoleTotals[]): StaffRoleTotals {
  const sum = (key: keyof StaffRoleTotals): number | null => {
    let total = 0;
    for (const t of list) {
      const v = t[key];
      if (v == null) return null;
      total += v;
    }
    // Часы — до десятых: 39,5 + 16,5 + … копят хвосты двоичной дроби.
    return Math.round(total * 10) / 10;
  };
  return { fte: sum('fte'), day: sum('day'), month: sum('month'), dayPay: sum('dayPay'), monthPay: sum('monthPay') };
}

/**
 * Пик должности: окно, где людей больше всего, и сколько их. По нескольким
 * лавкам — по сумме: окна в шаблоне одни на все лавки, поэтому складываем
 * окна по номеру. Ничья — первое по времени окно.
 */
export function rolePeak(norms: readonly StaffNorm[], role: StaffRole): { slot: StaffSlot; count: number } | null {
  const slots = norms[0]?.roles[role].slots ?? [];
  let best: { slot: StaffSlot; count: number } | null = null;
  for (const [i, slot] of slots.entries()) {
    const count = norms.reduce((s, n) => s + (n.roles[role].slots[i]?.count ?? 0), 0);
    if (count > 0 && (best == null || count > best.count)) best = { slot, count };
  }
  return best;
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

/* ------------------------------ дислокации ------------------------------ */

/**
 * Пост из клетки шаблона: «1 касса/2 прием» → [1 касса, 2 прием].
 *
 * Пишут по-разному: через «/» и «\\», с пробелами и без («1касса»), с
 * буквой должности («2к линия, 1ск касса» — 2 кассира, 1 старший кассир).
 * Запятая людей не делит: «1 кулинария, хлебка» — один человек на двух
 * местах. Одинаковые места в одном окне складываются: «1 кондитерка/1
 * кулинария» — это 2 кулинария (см. normalizePlace).
 */
export function parsePosts(text: string | null | undefined): StaffPost[] {
  const posts: StaffPost[] = [];
  // «/» и «\\» делят людей всегда, запятая — только перед числом: «2к линия,
  // 1ск касса» — двое разных, «1 кулинария, хлебка» — один на двух местах.
  for (const raw of String(text ?? '').split(/[\/\\]+|,\s*(?=\d)/)) {
    const seg = raw.replace(/\s+/g, ' ').trim();
    if (!seg) continue;
    // Число со звёздочкой, двоеточием или дефисом — время («11*-16*», «7:00»), не люди.
    const m = /^(\d+)(?![\d*:.\-])\s*(?:(ск|к|п)(?=\s))?\s*(.*)$/i.exec(seg);
    const count = m ? Number(m[1]) : null;
    const rest = m ? m[3] : seg;
    const senior = m?.[2]?.toLowerCase() === 'ск' ? 'ст. кассир: ' : '';
    const place = normalizePlace(senior + rest);
    if (!place) continue;
    const same = posts.find((p) => p.place.toLowerCase() === place.toLowerCase() && p.count != null && count != null);
    if (same) same.count! += count!;
    else posts.push({ count, place });
  }
  return posts;
}

/**
 * Одно место — одно название. Главное правило — «кондитерка = кулинария»:
 * в одних лавках пишут так, в других этак, а место одно. Заодно «ё» → «е»
 * и обрезанное «кулинар» → «кулинария».
 *
 * «Прием» и «линия» (заказы у гостя) называются «официант» — так решили
 * 28.10.2026.
 * Кроме «прием поставки»: это приёмка товара поварами, не официант.
 */
export function normalizePlace(text: string): string {
  return text
    .replace(/ё/g, 'е')
    .replace(/Ё/g, 'Е')
    .replace(/кондитерск[а-я]*|кондитерк[а-я]*/gi, 'кулинария')
    .replace(/кулинар(?![а-я])/gi, 'кулинария')
    .replace(/прием(?:а|ы|ов)?(?![а-я])(?!\s*поставк)/gi, 'официант')
    .replace(/(?<![а-я])линия(?![а-я])/gi, 'официант')
    // «официант+доставка» и «официант + доставка» — одно и то же место.
    .replace(/\s*\+\s*/g, ' + ')
    .replace(/\s+/g, ' ')
    .replace(/^[\s,;.+]+|[\s,;.+]+$/g, '')
    .trim();
}

/** «2 прием · 1 касса · ЗД зал касса». */
export function postsLabel(posts: readonly StaffPost[]): string {
  return posts.map((p) => (p.count == null ? p.place : `${p.count} ${p.place}`)).join(' · ');
}

/**
 * «2-подготовка витрин» без числа → 2 человека на «подготовке витрин». Так
 * писали в старой текстовой правке лавки (М1, М3): цифра прилипала к месту
 * через дефис, и пост шёл без числа — на вкладке отдельным написанием, в
 * счёт людей не попадал. Время («11*-16*») сюда не попадает: после дефиса
 * должна быть буква.
 */
export function splitLeadingCount(post: StaffPost): StaffPost {
  if (post.count != null) return post;
  const m = /^(\d{1,2})\s*-\s*(?=[а-яё])(.+)$/i.exec(post.place.trim());
  return m ? { count: Number(m[1]), place: normalizePlace(m[2]) } : post;
}

/**
 * Посты окна → по человеку на строку, как в правке лавки: «2 официант,
 * 1 касса» при норме 4 — «официант, официант, касса, (не выбрано)». Пост без
 * числа («бар + касса») — это все оставшиеся люди окна, но не меньше одного.
 * Строк — сколько людей по норме, а если расписано больше — сколько расписано.
 */
export function postsToPeople(posts: readonly StaffPost[], count: number): string[] {
  // «0,5 су-шефа» — всё равно один человек в списке.
  const whole = (n: number) => Math.ceil(n);
  const numbered = posts.reduce((s, p) => s + (p.count ?? 0), 0);
  const loose = posts.filter((p) => p.count == null).length;
  const people = posts.flatMap((p) =>
    Array<string>(p.count != null ? whole(p.count) : loose === 1 ? Math.max(1, whole(count - numbered)) : 1).fill(p.place),
  );
  return [...people, ...Array<string>(Math.max(0, whole(count) - people.length)).fill('')];
}

/** Обратно: люди → посты окна; одинаковые складываются, «не выбрано» — не пост. */
export function peopleToPosts(people: readonly string[]): StaffPost[] {
  const posts: StaffPost[] = [];
  for (const place of people) {
    if (!place) continue;
    const same = posts.find((p) => p.place.toLowerCase() === place.toLowerCase());
    if (same) same.count! += 1;
    else posts.push({ count: 1, place });
  }
  return posts;
}

/** Слова, по которым в чужой колонке видно другую должность: «1 повар разогрев». */
const OTHER_ROLE: Record<TemplateRole, RegExp> = {
  cashier: /^(повар|бариста|уборщ|зд|зам|сборщ)/i,
  cook: /^(кассир|бариста|уборщ|зд|зам|сборщ)/i,
  barista: /^(кассир|повар|уборщ|зд|зам|сборщ)/i,
  cleaner: /^(кассир|повар|бариста|зд|зам|сборщ)/i,
};

/**
 * Сколько людей этой должности в расстановке окна — чтобы сверить с нормой.
 * Посты без числа и посты другой должности («1 повар разогрев» в колонке
 * кассира, «ЗД бар касса») не считаем. null — чисел в расстановке нет вовсе.
 */
export function postsHeadcount(posts: readonly StaffPost[], role: StaffRole): number | null {
  const own = posts.filter((p) => p.count != null && !(role in OTHER_ROLE && OTHER_ROLE[role as TemplateRole].test(p.place)));
  return own.length ? own.reduce((s, p) => s + p.count!, 0) : null;
}

/** «расписано 2 из 4» — расписали не всех; «расписано 5, по норме 4» — лишние. */
export function offText(counted: number, norm: number): string {
  return counted < norm ? `расписано ${counted} из ${norm}` : `расписано ${counted}, по норме ${norm}`;
}

/**
 * Расписана ли у лавки хоть одна клетка. Замы не в счёт: их «касса» стоит у
 * всех лавок по постановке, а не потому, что лавку расписали.
 */
export function hasLayout(norm: StaffNorm): boolean {
  return (
    (norm.layout?.stations.length ?? 0) > 0 ||
    (norm.layout?.remarks.length ?? 0) > 0 ||
    [...TEMPLATE_ROLES, 'picker' as const].some((r) => norm.roles[r].posts?.some((p) => p.length > 0))
  );
}

/**
 * Должности, которых в норме нет, — с пустым окном. Новая должность (су-шеф,
 * 30.10.2026) появляется в коде раньше, чем у каждой лавки в JSON: лавка,
 * оставленная из прежних норм (её нет в новых книгах), собрана ещё без неё.
 */
export function withAllRoles(norms: readonly StaffNorm[]): StaffNorm[] {
  return norms.map((n) =>
    EXTRA_ROLES.every((r) => n.roles[r])
      ? n
      : {
          ...n,
          roles: {
            ...n.roles,
            ...Object.fromEntries(
              EXTRA_ROLES.filter((r) => !n.roles[r]).map((r) => [
                r,
                { slots: [{ ...EXTRA_ROLE_SLOT[r] }], fte: null, hours: null },
              ]),
            ),
          },
        },
  );
}
