import { dateRange, todayIso } from './time';

/**
 * Окно дней для второго способа заполнения витрин — «одна лавка, несколько
 * дней подряд».
 *
 * Обычный редактор устроен наоборот: выбран день, в списке восемьдесят лавок.
 * Это удобно, когда заполняют вечером за сегодня. Но когда лавка неделю не
 * попадала в отчёт и её закрывают задним числом, тот же редактор заставляет
 * переключать дату после каждой цифры — семь переключений ради одной лавки.
 *
 * Здесь наоборот: выбрана лавка, в списке дни. Границы окна считаются в этом
 * файле — без React и без базы, чтобы их можно было проверить тестами.
 */

/**
 * Предел окна. 62 дня — два месяца: столько ещё осмысленно править задним
 * числом, а дальше это уже не «дозаполнить», а переписывать историю. Заодно
 * ограничивает размер ответа: сервер не соберёт случайную выборку за год по
 * ссылке с `from=2020-01-01`.
 */
export const MAX_SHOWCASE_RANGE_DAYS = 62;

/** Сколько дней показывать, если период не выбирали и месяц только начался. */
const MIN_DEFAULT_DAYS = 7;

export interface ShowcaseRange {
  from: string;
  to: string;
}

/**
 * Приводит запрошенное окно к допустимому: границы по порядку, правый край не
 * в будущем, длина не больше предела.
 *
 * Будущее отрезается намеренно: наполнение витрины за завтра заполнять нечем,
 * а пустые строки вперёд на месяц сбивали бы счётчик «заполнено N из M».
 */
export function resolveShowcaseRange(
  from: string,
  to: string,
  today: string = todayIso(),
): ShowcaseRange {
  let start = from;
  let end = to;
  if (start > end) [start, end] = [end, start];

  if (end > today) end = today;
  if (start > end) start = end;

  const days = dateRange(start, end);
  if (days.length > MAX_SHOWCASE_RANGE_DAYS) {
    // Обрезаем слева: интересен всегда свежий край, а не начало запрошенного.
    start = days[days.length - MAX_SHOWCASE_RANGE_DAYS];
  }

  return { from: start, to: end };
}

/**
 * Окно по умолчанию — текущий месяц до сегодняшнего дня включительно: в
 * месяцах считается всё остальное в радаре, и «дозаполнить пропуски» почти
 * всегда значит «за этот месяц».
 *
 * Первого числа такой месяц состоит из одного дня, и режим «несколько дней»
 * выглядел бы сломанным, — поэтому окно тянется назад минимум на неделю,
 * захватывая хвост предыдущего месяца.
 */
export function defaultShowcaseRange(today: string = todayIso()): ShowcaseRange {
  const monthStart = `${today.slice(0, 7)}-01`;
  const week = shiftDate(today, -(MIN_DEFAULT_DAYS - 1));
  return { from: monthStart < week ? monthStart : week, to: today };
}

/**
 * Сдвиг окна на его собственную длину: «←» показывает предыдущие столько же
 * дней, «→» — следующие. Шагать календарными месяцами нельзя — окно бывает
 * недельным, а шагать одним днём бессмысленно.
 *
 * У свежего края окно не схлопывается: упёршись в сегодняшний день, оно
 * сохраняет длину и просто перестаёт двигаться. Иначе «→» на последней неделе
 * оставлял бы на экране одну строку — и выглядело бы это как поломка.
 */
export function shiftShowcaseRange(
  range: ShowcaseRange,
  by: number,
  today: string = todayIso(),
): ShowcaseRange {
  const span = dateRange(range.from, range.to).length;
  let end = shiftDate(range.to, span * by);
  if (end > today) end = today;
  return resolveShowcaseRange(shiftDate(end, -(span - 1)), end, today);
}

/** Окно в N последних дней, заканчивающееся сегодняшним. */
export function lastDaysRange(days: number, today: string = todayIso()): ShowcaseRange {
  return resolveShowcaseRange(shiftDate(today, -(days - 1)), today, today);
}

/** Календарный месяц даты, справа обрезанный сегодняшним днём. */
export function monthRange(month: string, today: string = todayIso()): ShowcaseRange {
  const [year, m] = month.split('-').map(Number);
  const last = new Date(year, m, 0).getDate();
  return resolveShowcaseRange(`${month}-01`, `${month}-${String(last).padStart(2, '0')}`, today);
}

/** «2026-09-30» + N дней. Через Date, чтобы не считать длину месяцев руками. */
export function shiftDate(date: string, days: number): string {
  const d = new Date(`${date}T00:00:00`);
  d.setDate(d.getDate() + days);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
