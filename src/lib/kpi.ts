/**
 * КПИ по наполнению витрин — один показатель на три уровня ответственности.
 *
 * Показатель везде один: процент наполнения витрины за день, итог дня —
 * среднее заполненных замеров: 08:00, 16:00 и с 26.10.2026 ещё 18:30 (dayFill
 * в showcase-store.ts).
 * Различается только то, за какой срез его усредняют:
 *
 *   · линейные сотрудники — каждый день отдельно, усреднять нечего;
 *   · директор лавки и территориальный директор — среднее за период по своим
 *     лавкам (у ТД их обычно две);
 *   · РМ — среднее за период по всем лавкам региона.
 *
 * Среднее за период — по лавко-дням, а не по средним лавок: каждый день
 * с замером весит одинаково. Лавка, где мерили два дня из тридцати, не тянет
 * итог ТД так же сильно, как лавка с тридцатью замерами. Дни без замера в
 * среднее не входят: «не заполняли» — это не 0%.
 */

/** Накопитель среднего: сумма процентов и число лавко-дней. */
export interface FillAverage {
  /** Сумма итогов дня в целых процентах. */
  sum: number;
  /** Сколько лавко-дней с замером в неё вошло. */
  days: number;
}

export function emptyAverage(): FillAverage {
  return { sum: 0, days: 0 };
}

/**
 * Досчитать итог дня (доля 0–1) в накопитель.
 *
 * Складываем в целых процентах: замер и так хранится целым процентом, а сумма
 * долей вида 0.95 + 0.94 + … копит хвосты двоичной арифметики и на границе
 * порога может дать 94,99999 вместо 95.
 */
export function addFill(acc: FillAverage, fill: number): FillAverage {
  acc.sum += Math.round(fill * 100);
  acc.days++;
  return acc;
}

/** Сложить накопители — лавки в ТД, лавки в регион. */
export function mergeAverages(list: readonly FillAverage[]): FillAverage {
  const total = emptyAverage();
  for (const a of list) {
    total.sum += a.sum;
    total.days += a.days;
  }
  return total;
}

/**
 * Средний процент за период с одним знаком после запятой: 94.6. null — за
 * период не мерили ни разу.
 *
 * Знак после запятой нужен именно здесь: за день процент целый, а у среднего
 * за месяц «95%» могло бы прятать и 94,6 (жёлтая зона), и 95,4 (зелёная).
 * Статус считается от того же округлённого числа, что показан на экране, —
 * иначе «95,0%» могло бы оказаться жёлтым.
 */
export function averagePercent(acc: FillAverage): number | null {
  if (acc.days === 0) return null;
  return Math.round((acc.sum / acc.days) * 10) / 10;
}

/**
 * «94,6%», «95,0%», «—» — запятая, как пишут по-русски. «,0» не срезаем:
 * в столбце рядом стояли бы «95%» и «94,6%», и цифры разъехались бы.
 */
export function formatPercent(percent: number | null): string {
  if (percent == null) return '—';
  return `${percent.toFixed(1).replace('.', ',')}%`;
}

/* ------------------------- руководители лавок ---------------------------- */

/**
 * Кто отвечает за лавку во втором блоке КПИ и в фильтре «Руководитель».
 *
 * У лавки либо свой директор (управляющий), либо территориальный директор на
 * две лавки. Источник — таблица «Лавки» (shop-directors.json): она новее и
 * знает имена директоров. Лавки, которой там нет, берём из справочника «Лавки
 * БК» — там есть только ТД, директор остаётся без имени.
 */
export interface ShopLeader {
  kind: 'territorial' | 'director';
  /** null — директор лавки, имени которого радар не знает. */
  name: string | null;
}

export function leaderOf(
  table: { director: string | null; territorial: string | null } | undefined,
  rosterTerritorial: string | null | undefined,
): ShopLeader {
  const territorial = table ? table.territorial : (rosterTerritorial ?? null);
  if (territorial) return { kind: 'territorial', name: territorial };
  return { kind: 'director', name: table?.director ?? null };
}

/**
 * Значение фильтра в адресе: «td:Макарова Дарья», «dir:Абрамова Дарья».
 * Приставка нужна: ТД и директор могут оказаться тёзками, а это разные строки.
 * У безымянного директора ключа нет — выбрать его в фильтре нельзя.
 */
export function leaderKey(leader: ShopLeader): string | null {
  return leader.name ? `${leader.kind === 'territorial' ? 'td' : 'dir'}:${leader.name}` : null;
}

/** Ключ из адреса обратно в руководителя; мусор — null, фильтр не действует. */
export function parseLeaderKey(value: string | undefined | null): ShopLeader | null {
  const m = /^(td|dir):(.+)$/.exec(String(value ?? '').trim());
  return m ? { kind: m[1] === 'td' ? 'territorial' : 'director', name: m[2].trim() } : null;
}

/** Варианты фильтра «Руководитель», по алфавиту внутри групп. */
export interface LeaderOptions {
  territorial: string[];
  directors: string[];
}

export function leaderOptions(leaders: Iterable<ShopLeader>): LeaderOptions {
  const territorial = new Set<string>();
  const directors = new Set<string>();
  for (const l of leaders) {
    if (!l.name) continue;
    (l.kind === 'territorial' ? territorial : directors).add(l.name);
  }
  const sort = (s: Set<string>) => [...s].sort((a, b) => a.localeCompare(b, 'ru'));
  return { territorial: sort(territorial), directors: sort(directors) };
}
