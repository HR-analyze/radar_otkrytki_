import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { getMeta, manualDbWritable, openManualDb, setMeta } from './manual-db';
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
 */

export interface ShowcaseStore {
  /** Дата (YYYY-MM-DD) → код лавки → доля 0–1. */
  days: Record<string, Record<string, number>>;
  /** Дата → когда её последний раз правили. */
  touched: Record<string, string>;
  updatedAt: string | null;
  /** Откуда прочитано: база или закоммиченный сид. */
  source: 'db' | 'seed';
}

export interface ShowcaseEdit {
  date: string;
  shopCode: string;
  /** Доля 0–1 или null, чтобы стереть значение. */
  fill: number | null;
}

const EMPTY: ShowcaseStore = { days: {}, touched: {}, updatedAt: null, source: 'seed' };

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
    return `seed|${seed.updatedAt ?? ''}|${Object.keys(seed.days).length}`;
  }
  seedOnce(db);

  const row = db
    .prepare(`SELECT COUNT(*) AS n, COALESCE(MAX(updated_at), '') AS at FROM showcase_fill`)
    .get() as { n: number; at: string };
  return `db|${row.at}|${row.n}`;
}

export async function readShowcase(): Promise<ShowcaseStore> {
  const db = await openManualDb();
  if (!db) return { ...readSeed(), source: 'seed' };

  seedOnce(db);

  const days: ShowcaseStore['days'] = {};
  const rows = db
    .prepare(`SELECT date, shop_code, fill FROM showcase_fill ORDER BY date, shop_code`)
    .all() as { date: string; shop_code: string; fill: number }[];
  for (const r of rows) {
    (days[r.date] ??= {})[r.shop_code] = r.fill;
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
    touched,
    updatedAt: latest[latest.length - 1] ?? null,
    source: 'db',
  };
}

/**
 * Сохраняет правки. Возвращает, сколько значений реально изменилось: повтор
 * того же числа правкой не считается.
 */
export async function saveShowcaseEdits(
  edits: readonly ShowcaseEdit[],
  now = new Date().toISOString(),
): Promise<{ changed: number }> {
  const db = await openManualDb();
  if (!db) {
    throw new Error(
      'Витрины некуда сохранять: на этом хостинге нет диска под базу ручных данных. ' +
        'Правьте там, где радар развёрнут на своём сервере.',
    );
  }
  seedOnce(db);

  const put = db.prepare(
    `INSERT INTO showcase_fill (date, shop_code, fill, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT(date, shop_code) DO UPDATE SET fill = excluded.fill, updated_at = excluded.updated_at`,
  );
  const drop = db.prepare(`DELETE FROM showcase_fill WHERE date = ? AND shop_code = ?`);
  const current = db.prepare(`SELECT fill FROM showcase_fill WHERE date = ? AND shop_code = ?`);
  const touch = db.prepare(
    `INSERT INTO showcase_day (date, updated_at) VALUES (?, ?)
     ON CONFLICT(date) DO UPDATE SET updated_at = excluded.updated_at`,
  );

  const apply = db.transaction((list: readonly ShowcaseEdit[]) => {
    let changed = 0;
    for (const e of list) {
      const before = (current.get(e.date, e.shopCode) as { fill: number } | undefined)?.fill;

      if (e.fill == null) {
        if (before === undefined) continue;
        drop.run(e.date, e.shopCode);
      } else {
        const next = round(normalizeFill(e.fill));
        if (before === next) continue;
        put.run(e.date, e.shopCode, next, now);
      }

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
  const touch = db.prepare(
    `INSERT OR IGNORE INTO showcase_day (date, updated_at) VALUES (?, ?)`,
  );

  db.transaction(() => {
    for (const [date, values] of Object.entries(seed.days)) {
      const at = seed.touched[date] ?? seed.updatedAt ?? new Date().toISOString();
      for (const [shopCode, fill] of Object.entries(values)) put.run(date, shopCode, fill, at);
      touch.run(date, at);
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
      touched: raw.touched ?? {},
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    return { days: {}, touched: {}, updatedAt: null };
  }
}

/**
 * Выгрузка базы обратно в файл-сид: резервная копия, которую можно закоммитить.
 * Дни и лавки сортируются — иначе в diff вместо правки была бы перетасовка.
 */
export function writeSeed(store: Omit<ShowcaseStore, 'source'>): string {
  const file = showcaseSeedPath();
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });

  const days: ShowcaseStore['days'] = {};
  for (const date of Object.keys(store.days).sort()) {
    const codes = Object.keys(store.days[date]).sort();
    if (codes.length === 0) continue;
    days[date] = Object.fromEntries(codes.map((c) => [c, store.days[date][c]]));
  }

  const touched: ShowcaseStore['touched'] = {};
  for (const date of Object.keys(store.touched).sort()) {
    if (days[date]) touched[date] = store.touched[date];
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
 * Витрины в том виде, в каком их ждёт дашборд: строки наполнения плюс статусы
 * критерия «витрина», посчитанные по действующим порогам.
 */
export function showcaseRowsFromStore(store: Omit<ShowcaseStore, 'source'>): {
  showcase: ShowcaseRow[];
  criteria: CriterionStatusRow[];
} {
  const config = loadConfig();
  const showcase: ShowcaseRow[] = [];
  const criteria: CriterionStatusRow[] = [];

  for (const date of Object.keys(store.days).sort()) {
    for (const shopCode of Object.keys(store.days[date]).sort()) {
      const fill = store.days[date][shopCode];
      const status = statusForFill(fill, config);

      showcase.push({ date, shopCode, fill, status });
      criteria.push({
        date,
        shopCode,
        criterion: 'showcase',
        status,
        // Витрина — один процент на лавку, усреднять нечего.
        score: null,
        origin: 'manual',
      });
    }
  }

  return { showcase, criteria };
}

/** Пустой стор — для тестов и для случая, когда данных нет вовсе. */
export function emptyShowcaseStore(): ShowcaseStore {
  return { ...EMPTY, days: {}, touched: {} };
}
