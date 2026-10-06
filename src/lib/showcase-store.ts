import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { getMeta, manualDbWritable, openManualDb, setMeta } from './manual-db';
import { showcaseAuditWriter, type ShowcaseEditSource } from './showcase-audit';
import { averagePercent } from './day-fill';
import { normalizeFill, statusForFill } from './status';
import type { CriterionStatusRow, ShowcaseRow } from './types';

/**
 * Наполнение витрин — единственные данные радара, которые не выгружаются из 1С,
 * а заполняются человеком на вкладке «Витрины».
 *
 * Где лежат. В базе ручных данных `data/manual.db` — вне git (см. manual-db.ts).
 * До 04.09.2026 они хранились в `fixtures/showcase.json` внутри репозитория, и
 * деплой затирал всё, что успели заполнить: так пропали витрины за 03.09.
 *
 * `fixtures/showcase.json` остался, но теперь у него другая роль — **сид**:
 * из него база наполняется один раз при первом запуске, и по нему же дашборд
 * показывает историю там, где базы нет вовсе (Vercel). Экспорт обратно в этот
 * файл делается по команде `npm run showcase:export` — это резервная копия,
 * которую можно закоммитить.
 *
 * В снимок витрины не пекутся: сборка занимает секунды, а правка ячейки должна
 * быть видна сразу. Они подмешиваются при чтении снимка — см. withShowcase.
 *
 * Здесь лежит только текущее значение. «Было 95%, стало 90%, в 13:40» —
 * в журнале правок, см. showcase-audit.ts: он пишется этой же транзакцией.
 *
 * Замеров в день два: утренний (`days`, как было всегда) и в 16:00
 * (`afternoon`). Итог дня для радара, статусов и балла лавки — среднее двух
 * (см. dayFill): утром 100%, в 16:00 50% — значит, 75%. Конкурс по витринам
 * считается только по утреннему замеру, как и до появления второго (см.
 * contest в queries.ts).
 */

export interface ShowcaseStore {
  /** Утренний замер: дата (YYYY-MM-DD) → код лавки → доля 0–1. */
  days: Record<string, Record<string, number>>;
  /** Замер в 16:00: дата → код лавки → доля 0–1. */
  afternoon: Record<string, Record<string, number>>;
  /** Дата → код лавки → комментарий. Хранится отдельно от процента. */
  notes: Record<string, Record<string, string>>;
  /** Дата → когда её последний раз правили. */
  touched: Record<string, string>;
  updatedAt: string | null;
  /** Откуда прочитано: база или закоммиченный сид. */
  source: 'db' | 'seed';
}

export interface ShowcaseEdit {
  date: string;
  shopCode: string;
  /**
   * Утренний замер: доля 0–1, null — стереть значение, undefined — не трогать
   * (правят только комментарий или замер в 16:00).
   */
  fill?: number | null;
  /** Замер в 16:00 — то же самое: null стирает, undefined не трогает. */
  afternoonFill?: number | null;
  /** Комментарий; пустая строка стирает, undefined — не трогать. */
  note?: string | null;
}

const EMPTY: ShowcaseStore = {
  days: {},
  afternoon: {},
  notes: {},
  touched: {},
  updatedAt: null,
  source: 'seed',
};

/** Таблица базы под каждый замер: утренний жил в showcase_fill всегда. */
const FILL_TABLE = { fill: 'showcase_fill', fill_afternoon: 'showcase_fill_afternoon' } as const;

/** Закоммиченный сид: начальное наполнение базы и запасной вариант без диска. */
export function showcaseSeedPath(): string {
  return process.env.RADAR_SHOWCASE_PATH ?? path.join(process.cwd(), 'fixtures', 'showcase.json');
}

export function canEditShowcase(): boolean {
  return manualDbWritable();
}

export function showcaseEditHint(): string {
  return canEditShowcase()
    ? 'Правки сохраняются в базу сразу и тут же видны на дашборде.'
    : 'Здесь только просмотр: на этом хостинге нет диска под базу ручных данных. ' +
        'Правьте витрины там, где радар развёрнут на своём сервере.';
}

/**
 * Дешёвая «версия» витрин: по ней снимок понимает, что данные сменились, и
 * пересобирает подмешивание. Читать все строки на каждый рендер незачем.
 */
export async function showcaseVersion(): Promise<string> {
  const db = await openManualDb();
  if (!db) {
    const seed = readSeed();
    return `seed|${seed.updatedAt ?? ''}|${Object.keys(seed.days).length}|${Object.keys(seed.afternoon).length}`;
  }
  seedOnce(db);

  const row = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS at FROM (
         SELECT updated_at FROM showcase_fill
         UNION ALL SELECT updated_at FROM showcase_fill_afternoon
       )`,
    )
    .get() as { n: number; at: string };
  return `db|${row.at}|${row.n}`;
}

export async function readShowcase(): Promise<ShowcaseStore> {
  const db = await openManualDb();
  if (!db) return { ...readSeed(), source: 'seed' };

  seedOnce(db);

  const readFills = (table: string): ShowcaseStore['days'] => {
    const out: ShowcaseStore['days'] = {};
    const rows = db
      .prepare(`SELECT date, shop_code, fill FROM ${table} ORDER BY date, shop_code`)
      .all() as { date: string; shop_code: string; fill: number }[];
    for (const r of rows) (out[r.date] ??= {})[r.shop_code] = r.fill;
    return out;
  };
  const days = readFills(FILL_TABLE.fill);
  const afternoon = readFills(FILL_TABLE.fill_afternoon);

  const notes: ShowcaseStore['notes'] = {};
  const noteRows = db
    .prepare(`SELECT date, shop_code, note FROM showcase_note ORDER BY date, shop_code`)
    .all() as { date: string; shop_code: string; note: string }[];
  for (const r of noteRows) {
    (notes[r.date] ??= {})[r.shop_code] = r.note;
  }

  const touched: ShowcaseStore['touched'] = {};
  const marks = db.prepare(`SELECT date, updated_at FROM showcase_day`).all() as {
    date: string;
    updated_at: string;
  }[];
  for (const m of marks) touched[m.date] = m.updated_at;

  const latest = marks.map((m) => m.updated_at).sort();
  return {
    days,
    afternoon,
    notes,
    touched,
    updatedAt: latest[latest.length - 1] ?? null,
    source: 'db',
  };
}

export interface SaveShowcaseOptions {
  /** Откуда пришла правка: пишется в журнал (см. showcase-audit.ts). */
  source?: ShowcaseEditSource;
  /** Время правки, ISO. Задаётся в тестах, чтобы лента была предсказуемой. */
  now?: string;
}

/**
 * Сохраняет правки. Возвращает, сколько значений реально изменилось: повтор
 * того же числа правкой не считается.
 *
 * Заодно пишет журнал «было → стало» — в той же транзакции, что и сами данные.
 */
export async function saveShowcaseEdits(
  edits: readonly ShowcaseEdit[],
  options: SaveShowcaseOptions = {},
): Promise<{ changed: number }> {
  const now = options.now ?? new Date().toISOString();
  const db = await openManualDb();
  if (!db) {
    throw new Error(
      'Витрины некуда сохранять: на этом хостинге нет диска под базу ручных данных. ' +
        'Правьте там, где радар развёрнут на своём сервере.',
    );
  }
  seedOnce(db);

  // Оба замера пишутся одинаково, различается только таблица и имя поля в
  // журнале — поэтому один набор запросов на замер, а не копия кода.
  const statements = (table: string) => ({
    put: db.prepare(
      `INSERT INTO ${table} (date, shop_code, fill, updated_at) VALUES (?, ?, ?, ?)
       ON CONFLICT(date, shop_code) DO UPDATE SET fill = excluded.fill, updated_at = excluded.updated_at`,
    ),
    drop: db.prepare(`DELETE FROM ${table} WHERE date = ? AND shop_code = ?`),
    current: db.prepare(`SELECT fill FROM ${table} WHERE date = ? AND shop_code = ?`),
  });
  const slots = {
    fill: statements(FILL_TABLE.fill),
    fill_afternoon: statements(FILL_TABLE.fill_afternoon),
  };
  const putNote = db.prepare(
    `INSERT INTO showcase_note (date, shop_code, note, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, shop_code) DO UPDATE SET note = excluded.note, updated_at = excluded.updated_at`,
  );
  const dropNote = db.prepare(`DELETE FROM showcase_note WHERE date = ? AND shop_code = ?`);
  const currentNote = db.prepare(`SELECT note FROM showcase_note WHERE date = ? AND shop_code = ?`);
  const touch = db.prepare(
    `INSERT INTO showcase_day (date, updated_at) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at`,
  );

  const audit = showcaseAuditWriter(db, now, options.source ?? 'unknown');

  /** Один замер одной правки. true — значение в базе действительно сменилось. */
  const applyFill = (e: ShowcaseEdit, field: keyof typeof FILL_TABLE, fill: number | null): boolean => {
    const { put, drop, current } = slots[field];
    const before = (current.get(e.date, e.shopCode) as { fill: number } | undefined)?.fill;

    if (fill === null) {
      if (before === undefined) return false;
      drop.run(e.date, e.shopCode);
      // Стирание — единственная правка, после которой в таблице замера не
      // остаётся вообще ничего. Без журнала она была бы невидима.
      audit({ date: e.date, shopCode: e.shopCode, field, from: String(before), to: null });
      return true;
    }

    const next = round(normalizeFill(fill));
    if (before === next) return false;
    put.run(e.date, e.shopCode, next, now);
    audit({
      date: e.date,
      shopCode: e.shopCode,
      field,
      from: before === undefined ? null : String(before),
      to: String(next),
    });
    return true;
  };

  const apply = db.transaction((list: readonly ShowcaseEdit[]) => {
    let changed = 0;
    for (const e of list) {
      let touched = false;

      // undefined — поле в правке не участвует. Это не то же самое, что null:
      // им стирают значение. Иначе правка комментария сбрасывала бы процент,
      // а правка замера в 16:00 — утренний.
      if (e.fill !== undefined && applyFill(e, 'fill', e.fill)) touched = true;
      if (e.afternoonFill !== undefined && applyFill(e, 'fill_afternoon', e.afternoonFill)) {
        touched = true;
      }

      if (e.note !== undefined) {
        const was = (currentNote.get(e.date, e.shopCode) as { note: string } | undefined)?.note;
        const next = e.note === null ? '' : e.note.trim();

        if (next === '') {
          if (was !== undefined) {
            dropNote.run(e.date, e.shopCode);
            audit({ date: e.date, shopCode: e.shopCode, field: 'note', from: was, to: null });
            touched = true;
          }
        } else if (was !== next) {
          putNote.run(e.date, e.shopCode, next, now);
          audit({
            date: e.date,
            shopCode: e.shopCode,
            field: 'note',
            from: was ?? null,
            to: next,
          });
          touched = true;
        }
      }

      if (!touched) continue;
      touch.run(e.date, now);
      changed++;
    }
    return changed;
  });

  return { changed: apply(edits) };
}

/**
 * Первое наполнение базы из закоммиченного сида. Делается один раз: дальше
 * база — источник правды, и стёртое в ней значение не должно возвращаться
 * из файла при следующем запуске.
 */
function seedOnce(db: Awaited<ReturnType<typeof openManualDb>>): void {
  if (!db || getMeta(db, 'showcase_seeded')) return;

  const seed = readSeed();
  const put = db.prepare(
    `INSERT OR IGNORE INTO showcase_fill (date, shop_code, fill, updated_at) VALUES (?, ?, ?, ?)`,
  );
  const putAfternoon = db.prepare(
    `INSERT OR IGNORE INTO showcase_fill_afternoon (date, shop_code, fill, updated_at) VALUES (?, ?, ?, ?)`,
  );
  const putNote = db.prepare(
    `INSERT OR IGNORE INTO showcase_note (date, shop_code, note, updated_at) VALUES (?, ?, ?, ?)`,
  );
  const touch = db.prepare(
    `INSERT OR IGNORE INTO showcase_day (date, updated_at) VALUES (?, ?)`,
  );

  const at = (date: string): string =>
    seed.touched[date] ?? seed.updatedAt ?? new Date().toISOString();

  db.transaction(() => {
    for (const [date, values] of Object.entries(seed.days)) {
      for (const [shopCode, fill] of Object.entries(values)) put.run(date, shopCode, fill, at(date));
      touch.run(date, at(date));
    }
    for (const [date, values] of Object.entries(seed.afternoon)) {
      for (const [shopCode, fill] of Object.entries(values)) {
        putAfternoon.run(date, shopCode, fill, at(date));
      }
      touch.run(date, at(date));
    }
    for (const [date, values] of Object.entries(seed.notes ?? {})) {
      for (const [shopCode, note] of Object.entries(values)) {
        putNote.run(date, shopCode, note, at(date));
      }
      touch.run(date, at(date));
    }
    setMeta(db, 'showcase_seeded', new Date().toISOString());
  })();
}

export function readSeed(): Omit<ShowcaseStore, 'source'> {
  try {
    const raw = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ showcaseSeedPath(), 'utf8'),
    ) as Partial<ShowcaseStore>;
    return {
      days: raw.days ?? {},
      // В сидах до второго замера ключа нет — это «в 16:00 не мерили».
      afternoon: raw.afternoon ?? {},
      notes: raw.notes ?? {},
      touched: raw.touched ?? {},
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    return { days: {}, afternoon: {}, notes: {}, touched: {}, updatedAt: null };
  }
}

/**
 * Выгрузка базы обратно в файл-сид: резервная копия, которую можно закоммитить.
 * Дни и лавки сортируются — иначе в diff вместо правки была бы перетасовка.
 */
export function writeSeed(store: Omit<ShowcaseStore, 'source'>): string {
  const file = showcaseSeedPath();
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });

  const sorted = (source: ShowcaseStore['days']): ShowcaseStore['days'] => {
    const out: ShowcaseStore['days'] = {};
    for (const date of Object.keys(source).sort()) {
      const codes = Object.keys(source[date]).sort();
      if (codes.length === 0) continue;
      out[date] = Object.fromEntries(codes.map((c) => [c, source[date][c]]));
    }
    return out;
  };
  const days = sorted(store.days);
  const afternoon = sorted(store.afternoon ?? {});

  // Комментарии тоже в копию: иначе единственное место, где они есть, — база,
  // а у неё по определению нет резервной копии в репозитории.
  const notes: ShowcaseStore['notes'] = {};
  for (const date of Object.keys(store.notes ?? {}).sort()) {
    const codes = Object.keys(store.notes[date]).sort();
    if (codes.length === 0) continue;
    notes[date] = Object.fromEntries(codes.map((c) => [c, store.notes[date][c]]));
  }

  const touched: ShowcaseStore['touched'] = {};
  for (const date of Object.keys(store.touched).sort()) {
    if (days[date] || afternoon[date] || notes[date]) touched[date] = store.touched[date];
  }

  fs.writeFileSync(
    /* turbopackIgnore: true */ file,
    JSON.stringify(
      {
        $comment:
          'Резервная копия наполнения витрин. Рабочие данные — в data/manual.db (вне git); ' +
          'этот файл заполняет базу при первом запуске и показывает историю там, где базы нет. ' +
          'Обновляется командой npm run showcase:export.',
        updatedAt: store.updatedAt,
        touched,
        days,
        afternoon,
        notes,
      },
      null,
      2,
    ) + '\n',
  );
  return file;
}

/** Доля 0–1 с точностью до процента: 0.9500000000000001 в базе не нужен. */
function round(fill: number): number {
  return Math.round(Math.min(1, Math.max(0, fill)) * 100) / 100;
}

/**
 * Итог дня по двум замерам, доля 0–1 — их среднее: утром 100%, в 16:00 50% —
 * это 75%. Незаполненный замер итог не трогает: если в 16:00 не мерили, итог
 * равен утреннему как есть, и наоборот. Формула среднего (до целого процента,
 * половинка вверх) — в day-fill.ts: по ней же превью статуса в редакторе.
 */
export function dayFill(morning: number | null, afternoon: number | null): number | null {
  if (morning == null) return afternoon;
  if (afternoon == null) return morning;
  return averagePercent(morning * 100, afternoon * 100) / 100;
}

/**
 * Витрины в том виде, в каком их ждёт дашборд: строки наполнения плюс статусы
 * критерия «витрина», посчитанные по действующим порогам.
 *
 * `fill` и статус строки — итог дня (среднее двух замеров, см. dayFill), по
 * нему красится радар и считается балл лавки. Сами замеры лежат рядом: конкурсу
 * нужен утренний, фильтру «Витрина» — любой из двух.
 */
export function showcaseRowsFromStore(store: Omit<ShowcaseStore, 'source'>): {
  showcase: ShowcaseRow[];
  criteria: CriterionStatusRow[];
} {
  const config = loadConfig();
  const showcase: ShowcaseRow[] = [];
  const criteria: CriterionStatusRow[] = [];

  const afternoonDays = store.afternoon ?? {};
  const dates = new Set([...Object.keys(store.days), ...Object.keys(afternoonDays)]);
  for (const date of [...dates].sort()) {
    const codes = new Set([
      ...Object.keys(store.days[date] ?? {}),
      ...Object.keys(afternoonDays[date] ?? {}),
    ]);
    for (const shopCode of [...codes].sort()) {
      const morning = store.days[date]?.[shopCode] ?? null;
      const afternoon = afternoonDays[date]?.[shopCode] ?? null;
      // Хотя бы один замер есть: иначе лавки не было бы в codes.
      const fill = dayFill(morning, afternoon)!;
      const status = statusForFill(fill, config);

      showcase.push({ date, shopCode, fill, status, morning, afternoon });
      criteria.push({
        date,
        shopCode,
        criterion: 'showcase',
        status,
        // Итог — один процент на лавку (среднее замеров), усреднять дальше нечего.
        score: null,
        origin: 'manual',
      });
    }
  }

  return { showcase, criteria };
}

/** Пустой стор — для тестов и для случая, когда данных нет вовсе. */
export function emptyShowcaseStore(): ShowcaseStore {
  return { ...EMPTY, days: {}, afternoon: {}, notes: {}, touched: {} };
}
