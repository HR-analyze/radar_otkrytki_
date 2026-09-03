import { getMeta, openManualDb, setMeta } from './manual-db';
import { isoDate } from './time';
import type { RegionPeriod } from './types';

/**
 * История «какой РМ отвечал за лавку в какой период».
 *
 * Зачем это нужно. Справочник лавок — срез «кто сейчас», а не журнал
 * изменений: когда РМ увольняется или лавки перераспределяют, его просто нет
 * в новом файле. Раньше при загрузке нового справочника это стирало имя
 * менеджера из ВСЕХ дней радара, включая прошлые месяцы, где он реально
 * отвечал за лавку, — сравнить его показатели с показателями преемника было
 * уже нельзя.
 *
 * Как это исправлено. Лавка получает не одно имя РМ, а список периодов:
 * «с такого-то числа по такое-то — Иванов, дальше — Петров». Два периода,
 * известных уже сейчас из закоммиченных файлов, считает `deriveRegionHistory`:
 * легаси-книга «Витрины» была источником РМ до ROSTER_EFFECTIVE_DATE, дальше —
 * справочник лавок. Это чистая функция без базы — работает и на Vercel, где
 * снимок печётся при сборке и писать дальше некуда.
 *
 * Там, где есть диск под базу ручных данных, `reconcileRegionHistory`
 * пополняет эту историю на каждой сборке снимка: если менеджер лавки в новом
 * справочнике отличается от того, что уже записан как действующий, старый
 * период закрывается вчерашним числом, а новый открывается с сегодняшнего —
 * без ручной правки дат при каждой смене РМ.
 */

/** Когда справочник лавок стал источником РМ вместо легаси-книги «Витрины». */
export const ROSTER_EFFECTIVE_DATE = '2026-09-01';

/** Раньше любых реальных дат в радаре — эффективное «с начала времён». */
const EPOCH = '2000-01-01';

/**
 * Один и тот же человек в двух документах может быть записан по-разному:
 * в легаси-книге — только фамилия («Шевкун»), в справочнике — фамилия и имя
 * («Шевкун Виктория»). Совпадение первого слова считаем тем же человеком —
 * иначе почти каждая лавка получала бы лишний «переход», хотя РМ не менялся,
 * просто сменился формат имени в документе.
 */
function sameManager(a: string, b: string): boolean {
  const first = (s: string): string => s.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return first(a) === first(b);
}

function dayBefore(iso: string): string {
  const d = new Date(`${iso}T00:00:00`);
  d.setDate(d.getDate() - 1);
  return isoDate(d);
}

/**
 * Базовая история из двух источников, которые уже есть в репозитории:
 * легаси-книга (до ROSTER_EFFECTIVE_DATE) и текущий справочник (с неё).
 * Считается на месте, без базы данных, — значит, всегда даёт верную историю
 * по этим двум главам, даже там, где базы ручных данных нет.
 */
export function deriveRegionHistory(
  legacy: ReadonlyMap<string, string>,
  roster: ReadonlyMap<string, string>,
): RegionPeriod[] {
  const codes = new Set([...legacy.keys(), ...roster.keys()]);
  const canonical = canonicalNames(roster.values());
  const out: RegionPeriod[] = [];

  for (const shopCode of codes) {
    // Легаси-имя приводим к тому же виду, что и в справочнике: иначе один и тот
    // же человек попал бы в список дважды — «Карабак» за прошлые месяцы и
    // «Карабак Денис» за нынешние, — и выглядел бы как двое разных.
    const before = canonicalOf(legacy.get(shopCode) ?? null, canonical);
    const after = roster.get(shopCode) ?? null;

    if (before && after && !sameManager(before, after)) {
      // Реальная смена: разные люди — лавку передали другому РМ.
      out.push({ shopCode, manager: before, from: EPOCH, to: dayBefore(ROSTER_EFFECTIVE_DATE) });
      out.push({ shopCode, manager: after, from: ROSTER_EFFECTIVE_DATE, to: null });
    } else if (after) {
      // Тот же человек (или в легаси лавки не было вовсе) — один период.
      out.push({ shopCode, manager: after, from: EPOCH, to: null });
    } else if (before) {
      // В новом справочнике лавки нет — легаси остаётся единственным источником.
      out.push({ shopCode, manager: before, from: EPOCH, to: null });
    }
  }

  return out;
}

/** Фамилия → полное имя из справочника: «карабак» → «Карабак Денис». */
function canonicalNames(managers: Iterable<string>): Map<string, string> {
  const bySurname = new Map<string, string>();
  for (const name of managers) {
    const surname = name.trim().split(/\s+/)[0]?.toLowerCase();
    if (surname) bySurname.set(surname, name);
  }
  return bySurname;
}

/**
 * Имя из легаси-книги в виде справочника, если такой человек там есть.
 * Ушедшего (Суркова, Договой в справочнике нет) оставляем как записано —
 * он и должен остаться в истории под своим именем.
 */
function canonicalOf(name: string | null, canonical: ReadonlyMap<string, string>): string | null {
  if (!name) return null;
  const surname = name.trim().split(/\s+/)[0]?.toLowerCase() ?? '';
  return canonical.get(surname) ?? name;
}

const SEED_META_KEY = 'region_history_seeded';

/**
 * Дополняет базовую историю живыми изменениями там, где есть база ручных
 * данных. Без диска (Vercel) возвращает null — вызывающий код остаётся на
 * статической истории из снимка (двух известных глав).
 */
export async function reconcileRegionHistory(
  current: ReadonlyMap<string, string>,
  seed: readonly RegionPeriod[],
  today = isoDate(new Date()),
): Promise<RegionPeriod[] | null> {
  const db = await openManualDb();
  if (!db) return null;

  if (!getMeta(db, SEED_META_KEY)) {
    const put = db.prepare(
      `INSERT INTO region_periods (shop_code, manager, from_date, to_date, source) VALUES (?, ?, ?, ?, ?)`,
    );
    db.transaction(() => {
      for (const p of seed) put.run(p.shopCode, p.manager, p.from, p.to, 'seed');
      setMeta(db, SEED_META_KEY, new Date().toISOString());
    })();
  }

  const openPeriod = db.prepare(
    `SELECT id, manager FROM region_periods WHERE shop_code = ? AND to_date IS NULL`,
  );
  const anyPeriod = db.prepare(`SELECT 1 FROM region_periods WHERE shop_code = ? LIMIT 1`);
  const close = db.prepare(`UPDATE region_periods SET to_date = ? WHERE id = ?`);
  const relabel = db.prepare(`UPDATE region_periods SET manager = ? WHERE id = ?`);
  const open = db.prepare(
    `INSERT INTO region_periods (shop_code, manager, from_date, to_date, source) VALUES (?, ?, ?, NULL, 'roster')`,
  );

  db.transaction(() => {
    for (const [shopCode, manager] of current) {
      const row = openPeriod.get(shopCode) as { id: number; manager: string } | undefined;

      if (!row) {
        // Первая запись о лавке начинается «с начала времён», а не с сегодня:
        // мы не знаем, когда этот РМ её принял, и датировать задним числом
        // честнее, чем оставить все прошлые дни вообще без менеджера.
        // Сегодняшним днём открывается только период после реальной смены.
        const known = anyPeriod.get(shopCode) !== undefined;
        open.run(shopCode, manager, known ? today : EPOCH);
      } else if (row.manager !== manager) {
        if (sameManager(row.manager, manager)) {
          // Тот же человек, более полное имя — обновляем ярлык, период не рвём.
          relabel.run(manager, row.id);
        } else {
          close.run(dayBefore(today), row.id);
          open.run(shopCode, manager, today);
        }
      }
    }
  })();

  const rows = db
    .prepare(
      `SELECT shop_code, manager, from_date, to_date FROM region_periods ORDER BY shop_code, from_date`,
    )
    .all() as { shop_code: string; manager: string; from_date: string; to_date: string | null }[];

  return rows.map((r) => ({
    shopCode: r.shop_code,
    manager: r.manager,
    from: r.from_date,
    to: r.to_date,
  }));
}
