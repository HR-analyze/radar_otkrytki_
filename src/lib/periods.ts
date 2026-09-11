/**
 * Быстрые периоды: «последний день», «7 дней», «30 дней», «все данные».
 *
 * Живут здесь, а не в календаре, потому что показываются в двух местах: в
 * самом календаре и строкой под фильтрами. Раньше до них можно было добраться
 * только открыв календарь и долистав его до низа — а «последние 7 дней» это
 * то, ради чего радар открывают чаще всего.
 *
 * Отсчёт идёт от последнего дня с данными, а не от сегодняшнего числа:
 * выгрузка приходит раз в день и с задержкой, и «7 дней» от сегодня регулярно
 * означали бы шесть пустых дней и один с данными.
 */

export interface PeriodPreset {
  key: string;
  label: string;
  /** Короткая подпись для узкого экрана. */
  short: string;
  from: string;
  to: string;
}

export function periodPresets(dates: readonly string[]): PeriodPreset[] {
  const last = dates[dates.length - 1];
  const first = dates[0];
  if (!last || !first) return [];

  return [
    { key: 'day', label: 'Последний день', short: '1 день', from: last, to: last },
    { key: '7d', label: '7 дней', short: '7 дней', from: maxIso(shiftDays(last, -6), first), to: last },
    { key: '30d', label: '30 дней', short: '30 дней', from: maxIso(shiftDays(last, -29), first), to: last },
    { key: 'all', label: 'Все данные', short: 'Всё', from: first, to: last },
  ];
}

/**
 * Какой из пресетов сейчас выбран — чтобы подсветить его, а не заставлять
 * человека гадать, тот ли период он смотрит.
 */
export function activePreset(
  presets: readonly PeriodPreset[],
  from: string,
  to: string,
): string | null {
  return presets.find((p) => p.from === from && p.to === to)?.key ?? null;
}

/**
 * Начало периода не уводим раньше первого дня с данными: «30 дней» на
 * истории в неделю показывали бы три недели заведомо пустых столбцов.
 */
function maxIso(a: string, b: string): string {
  return a >= b ? a : b;
}

export function shiftDays(iso: string, n: number): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() + n);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
}
