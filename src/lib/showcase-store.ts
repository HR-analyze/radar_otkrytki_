import fs from 'node:fs';
import path from 'node:path';
import { loadConfig } from './config';
import { normalizeFill, statusForFill } from './status';
import type { CriterionStatusRow, ShowcaseRow } from './types';

/**
 * Наполнение витрин — единственные данные радара, которые не выгружаются из 1С,
 * а заполняются человеком. Поэтому и хранятся отдельно от выгрузок: не в Excel,
 * а в своём файле, который правит вкладка «Витрины» на самом сайте.
 *
 * Почему не через пересборку снимка. Снимок собирается из fixtures за
 * несколько секунд — терпимо для загрузки файла раз в день, но не для правки
 * ячейки. Поэтому витрины подмешиваются в снимок при чтении: правка видна
 * сразу, а пересобирать ничего не нужно.
 *
 * Файл лежит рядом с выгрузками и коммитится: это такой же источник данных,
 * просто заполняется руками.
 */

export interface ShowcaseStore {
  /** Дата (YYYY-MM-DD) → код лавки → доля 0–1. */
  days: Record<string, Record<string, number>>;
  /** Дата → когда её последний раз правили. */
  touched: Record<string, string>;
  updatedAt: string | null;
}

export interface ShowcaseEdit {
  date: string;
  shopCode: string;
  /** Доля 0–1 или null, чтобы стереть значение. */
  fill: number | null;
}

const EMPTY: ShowcaseStore = { days: {}, touched: {}, updatedAt: null };

export function showcaseStorePath(): string {
  return (
    process.env.RADAR_SHOWCASE_PATH ?? path.join(process.cwd(), 'fixtures', 'showcase.json')
  );
}

export function showcaseStoreExists(): boolean {
  try {
    return fs.existsSync(/* turbopackIgnore: true */ showcaseStorePath());
  } catch {
    return false;
  }
}

export function readShowcaseStore(): ShowcaseStore {
  try {
    const raw = JSON.parse(
      fs.readFileSync(/* turbopackIgnore: true */ showcaseStorePath(), 'utf8'),
    ) as Partial<ShowcaseStore>;
    return {
      days: raw.days ?? {},
      touched: raw.touched ?? {},
      updatedAt: raw.updatedAt ?? null,
    };
  } catch {
    return { ...EMPTY };
  }
}

export function writeShowcaseStore(store: ShowcaseStore): void {
  const file = showcaseStorePath();
  fs.mkdirSync(/* turbopackIgnore: true */ path.dirname(file), { recursive: true });

  // Дни и лавки сортируем: файл коммитится, и в diff должно быть видно правку,
  // а не перетасованный JSON.
  const days: ShowcaseStore['days'] = {};
  for (const date of Object.keys(store.days).sort()) {
    const values = store.days[date];
    const codes = Object.keys(values).sort();
    if (codes.length === 0) continue;
    days[date] = Object.fromEntries(codes.map((c) => [c, values[c]]));
  }

  const touched: ShowcaseStore['touched'] = {};
  for (const date of Object.keys(store.touched).sort()) {
    if (days[date]) touched[date] = store.touched[date];
  }

  const body = {
    $comment:
      'Наполнение витрин. Правится на сайте, вкладка «Витрины» — руками этот файл трогать не нужно. ' +
      'Значение — доля 0–1 по лавке за день.',
    updatedAt: store.updatedAt,
    touched,
    days,
  };
  fs.writeFileSync(/* turbopackIgnore: true */ file, JSON.stringify(body, null, 2) + '\n');
}

/** Применяет правки и возвращает новый стор со счётчиком реальных изменений. */
export function applyEdits(
  store: ShowcaseStore,
  edits: readonly ShowcaseEdit[],
  now = new Date().toISOString(),
): { store: ShowcaseStore; changed: number } {
  const days: ShowcaseStore['days'] = { ...store.days };
  const touched = { ...store.touched };
  let changed = 0;

  for (const e of edits) {
    const values = { ...(days[e.date] ?? {}) };
    const before = values[e.shopCode];

    if (e.fill == null) {
      if (!(e.shopCode in values)) continue;
      delete values[e.shopCode];
    } else {
      const next = round(normalizeFill(e.fill));
      if (before === next) continue;
      values[e.shopCode] = next;
    }

    days[e.date] = values;
    touched[e.date] = now;
    changed++;
  }

  return {
    store: { days, touched, updatedAt: changed > 0 ? now : store.updatedAt },
    changed,
  };
}

/** Доля 0–1 с точностью до процента: 0.9500000000000001 в файле не нужен. */
function round(fill: number): number {
  return Math.round(Math.min(1, Math.max(0, fill)) * 100) / 100;
}

/**
 * Витрины из стора в том виде, в каком их ждёт дашборд: строки наполнения плюс
 * статусы критерия «витрина», посчитанные по действующим порогам.
 */
export function showcaseRowsFromStore(
  store: ShowcaseStore,
): { showcase: ShowcaseRow[]; criteria: CriterionStatusRow[] } {
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
