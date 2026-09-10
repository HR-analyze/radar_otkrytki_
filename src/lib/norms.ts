import { expandCookShifts } from './parsers/shop-norms';
import { scheduleShift } from './status';
import { parseClock } from './time';
import type { AttendanceRow, ShopNorms, Status, ThresholdConfig } from './types';

/**
 * Пересчёт статусов по нормативам конкретной лавки.
 *
 * Сетевые пороги в `config.criteria` одни на все лавки, а норма у каждой своя:
 * в М73 водитель должен быть в 5:20, в М72 — в 8:00. По общему порогу первая
 * вечно зелёная, вторая вечно красная, и обе цифры ничего не говорят о работе.
 *
 * Поэтому норма лавки заменяет границу зелёной зоны, а жёлтая едет за ней с
 * шагом `rules.shopNorms.yellowStepMinutes` (по умолчанию 15 минут):
 *
 *     🟢 приход ≤ норма
 *     🟡 норма < приход ≤ норма + шаг
 *     🔴 позже, а также «отметки нет» — как и в общем правиле
 *
 * Лавка без нормы в справочнике считается по сетевым порогам, как раньше.
 *
 * Считается это отдельным проходом, а не внутри парсера, из-за поваров:
 * норма у них не одна («1 с 6:00, 2 с 6:30»), и чтобы понять, кого с какой
 * сравнивать, нужны все повара лавки за день сразу — по одной строке это
 * неразрешимо.
 */

/** Шаг жёлтой зоны, если в конфиге его нет. */
const DEFAULT_YELLOW_STEP = 15;

export function normsEnabled(config: ThresholdConfig): boolean {
  return config.rules.shopNorms?.enabled === true;
}

export function yellowStep(config: ThresholdConfig): number {
  return config.rules.shopNorms?.yellowStepMinutes ?? DEFAULT_YELLOW_STEP;
}

/**
 * Статус по норме: минуты прихода против «ЧЧ:ММ» норматива.
 *
 * `shift` — сдвиг для лавки с другим временем открытия. Норма из справочника
 * уже учитывает поздний график (у М72 в справочнике стоит 8:00), поэтому
 * сдвигать её второй раз нельзя — сюда он приходит нулём. Аргумент оставлен
 * явным, чтобы это решение было видно на месте вызова, а не подразумевалось.
 */
export function statusByNorm(
  minutes: number | null,
  normAt: string,
  config: ThresholdConfig,
  shift = 0,
): Status {
  if (minutes == null) return 'red'; // п.5.1 ТЗ: нет отметки → красный, без исключений

  // п.5.0: «другой график» проверяется раньше остальных правил — иначе выход
  // во вторую смену считался бы гигантским опозданием первой.
  const other = config.rules.otherSchedule;
  if (other.enabled && minutes > parseClock(other.after) + shift) return 'other_schedule';

  const norm = parseClock(normAt) + shift;
  if (minutes <= norm) return 'green';
  if (minutes <= norm + yellowStep(config)) return 'yellow';
  return 'red';
}

/**
 * Кто из поваров по какой норме оценивается.
 *
 * Смены — это план на лавку целиком: «1 с 6:00, 2 с 6:30» значит, что к 6:00
 * нужен один повар, а к 6:30 — ещё двое. Кто именно из троих придёт первым,
 * справочник не знает и знать не может, поэтому нормы раздаются по факту:
 * пришедший раньше всех отвечает за самую раннюю смену, следующий — за
 * следующую. Так лавка зелёная, когда план выполнен, а не когда конкретный
 * человек угадал свою строчку в справочнике.
 *
 * Поваров пришло больше, чем смен в плане, — лишние оцениваются по последней
 * смене: раньше неё их никто не ждал.
 *
 * @param arrivals минуты прихода, null — отметки нет.
 * @returns норма («ЧЧ:ММ») для каждого прихода, в том же порядке.
 */
export function assignCookNorms(
  arrivals: readonly (number | null)[],
  shifts: readonly { count: number; at: string }[],
): (string | null)[] {
  const plan = expandCookShifts(shifts);
  if (plan.length === 0) return arrivals.map(() => null);

  // Без отметки сравнивать нечего — такой повар и так красный, а место в
  // очереди занимать не должен: иначе он забрал бы раннюю норму у того, кто
  // на самом деле пришёл первым.
  const order = arrivals
    .map((minutes, index) => ({ minutes, index }))
    .filter((a): a is { minutes: number; index: number } => a.minutes != null)
    .sort((a, b) => a.minutes - b.minutes);

  const out: (string | null)[] = arrivals.map(() => null);
  order.forEach((a, i) => {
    out[a.index] = plan[Math.min(i, plan.length - 1)];
  });
  return out;
}

/**
 * Пересчитывает статусы отметок по нормам лавок.
 *
 * Трогает только «водителя» и «повара» — остальные критерии в справочнике не
 * нормируются и остаются на сетевых порогах. Строки лавок без нормы возвращаются
 * как есть, тем же объектом.
 */
export function applyShopNorms(
  rows: readonly AttendanceRow[],
  byCode: Readonly<Record<string, ShopNorms>>,
  config: ThresholdConfig,
): AttendanceRow[] {
  if (!normsEnabled(config)) return [...rows];

  const out = [...rows];

  // Норма из справочника уже записана в местном времени лавки, поэтому сдвиг
  // за поздний график к ней не применяется — см. statusByNorm.
  const shiftFor = (code: string): number => (byCode[code] ? 0 : scheduleShift(config, code));

  out.forEach((row, i) => {
    if (row.criterion !== 'driver') return;
    const normAt = byCode[row.shopCode]?.driverAt;
    if (!normAt) return;
    out[i] = { ...row, status: statusByNorm(row.arrivalMinutes, normAt, config, shiftFor(row.shopCode)) };
  });

  for (const [, group] of groupCooks(out)) {
    const shifts = byCode[out[group[0]].shopCode]?.cookShifts ?? [];
    if (shifts.length === 0) continue;

    const norms = assignCookNorms(
      group.map((i) => out[i].arrivalMinutes),
      shifts,
    );
    group.forEach((rowIndex, i) => {
      const normAt = norms[i];
      if (!normAt) return;
      out[rowIndex] = {
        ...out[rowIndex],
        status: statusByNorm(out[rowIndex].arrivalMinutes, normAt, config, 0),
      };
    });
  }

  return out;
}

/** Индексы строк поваров, сгруппированные по «дата + лавка». */
function groupCooks(rows: readonly AttendanceRow[]): Map<string, number[]> {
  const groups = new Map<string, number[]>();
  rows.forEach((row, i) => {
    if (row.criterion !== 'cook') return;
    const key = `${row.date}|${row.shopCode}`;
    const list = groups.get(key);
    if (list) list.push(i);
    else groups.set(key, [i]);
  });
  return groups;
}
