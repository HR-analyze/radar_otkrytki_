import type { Status } from './types';

/**
 * Конкурс по наполнению витрин.
 *
 * Правило заказчика: лавка набирает баллы за цвет дня по витрине —
 * 🟢 +1, 🟡 0, 🔴 −1. Пример из постановки: за 5 дней три жёлтых, одна красная
 * и одна зелёная → 0.
 *
 * Здесь именно баллы, а не число красных, как в радаре: в конкурсе зелёный
 * день компенсирует красный, поэтому «−3» и «0» различаются, даже если
 * красных в обоих случаях поровну.
 *
 * Нейтральные дни (нет данных, другой график) балла не имеют и в знаменатель
 * не входят — иначе лавка, которую просто не заполняли, выглядела бы ровной
 * серединой.
 */
export const CONTEST_POINTS: Record<Status, number | null> = {
  green: 1,
  yellow: 0,
  red: -1,
  other_schedule: null,
  no_data: null,
};

export interface ContestScore {
  green: number;
  yellow: number;
  red: number;
  /** Дней с оценкой — знаменатель для баллов. */
  rated: number;
  /** Сумма баллов: 🟢 +1, 🟡 0, 🔴 −1. */
  points: number;
}

export function emptyScore(): ContestScore {
  return { green: 0, yellow: 0, red: 0, rated: 0, points: 0 };
}

/** Балл одного дня; null — день без оценки. */
export function pointsOf(status: Status): number | null {
  return CONTEST_POINTS[status];
}

/** Баллы по списку дней одной лавки. */
export function scoreOf(statuses: readonly Status[]): ContestScore {
  const score = emptyScore();
  for (const s of statuses) addStatus(score, s);
  return score;
}

/** Досчитать день в накопитель — чтобы не собирать промежуточные массивы. */
export function addStatus(score: ContestScore, status: Status): ContestScore {
  const points = CONTEST_POINTS[status];
  if (points == null) return score;

  if (status === 'green') score.green++;
  else if (status === 'yellow') score.yellow++;
  else if (status === 'red') score.red++;

  score.rated++;
  score.points += points;
  return score;
}

/** Сложить баллы лавок в баллы региона (или всей сети). */
export function sumScores(scores: readonly ContestScore[]): ContestScore {
  const total = emptyScore();
  for (const s of scores) {
    total.green += s.green;
    total.yellow += s.yellow;
    total.red += s.red;
    total.rated += s.rated;
    total.points += s.points;
  }
  return total;
}

/**
 * Средний балл за оценённый день. Регионы сравнивать по сумме нельзя: у РМ с
 * двенадцатью лавками сумма больше просто потому, что лавок больше.
 * null — оценённых дней нет.
 */
export function averagePoints(score: ContestScore): number | null {
  return score.rated === 0 ? null : Math.round((score.points / score.rated) * 100) / 100;
}

/** Баллы со знаком: «+3», «0», «−2» — знак важнее, чем экономия символа. */
export function formatPoints(points: number): string {
  if (points > 0) return `+${points}`;
  if (points < 0) return `−${Math.abs(points)}`;
  return '0';
}
