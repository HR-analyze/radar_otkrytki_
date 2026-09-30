import { openManualDb } from './manual-db';
import { normalizeCode } from './shops';

/**
 * Журнал правок наполнения витрин: что именно изменилось и когда.
 *
 * Зачем он появился. У витрин хранилось только текущее значение и время
 * последней правки (`showcase_fill.updated_at`), и на живой вопрос «утром лавка
 * была зелёная, днём жёлтая — значение правили или пороги сдвинули?» ответить
 * было нечем: прежнее число перезаписано, а стёртое исчезало вместе со строкой.
 * Теперь каждое изменение остаётся строкой «было → стало».
 *
 * Чего здесь нет — автора. Вход на «Витрины» — один общий пароль на всю
 * команду, отдельных пользователей в радаре нет (см. auth.ts). Писать в журнал
 * выдуманного «пользователя» или адрес, по которому человека всё равно не
 * опознать, хуже, чем честно показать только факт правки. Вместо автора
 * пишется `source`: правка пришла со страницы «Витрины» или из залитой книги.
 *
 * Журнал — производная запись, а не данные: его потеря не ломает радар, но
 * пишется он в той же транзакции, что и сама правка (см. saveShowcaseEdits),
 * иначе журнал и база расходились бы при сбое посреди пачки.
 */

/** Откуда пришла правка. 'unknown' — вызов без указания источника. */
export type ShowcaseEditSource = 'ui' | 'upload' | 'unknown';

/** Какое поле лавки за день изменилось: утренний замер, замер в 16:00, комментарий. */
export type ShowcaseAuditField = 'fill' | 'fill_afternoon' | 'note';

export interface ShowcaseAuditEntry {
  /** Когда правка применена, ISO. */
  at: string;
  /** День витрины, который правили (не день правки — он в `at`). */
  date: string;
  shopCode: string;
  field: ShowcaseAuditField;
  /** Прежнее значение; null — значения не было вовсе. */
  from: string | null;
  /** Новое значение; null — стёрли. */
  to: string | null;
  source: ShowcaseEditSource;
}

type ManualDb = NonNullable<Awaited<ReturnType<typeof openManualDb>>>;

/** Сколько правок отдаём за раз: лента, а не выгрузка всей базы. */
const LIMIT = 200;

/**
 * Готовит запись в журнал для одной транзакции сохранения.
 *
 * Возвращается функция, а не просто statement: время и источник у всей пачки
 * общие, и повторять их на каждом вызове значит однажды передать разные.
 */
export function showcaseAuditWriter(
  db: ManualDb,
  at: string,
  source: ShowcaseEditSource,
): (change: {
  date: string;
  shopCode: string;
  field: ShowcaseAuditField;
  from: string | null;
  to: string | null;
}) => void {
  const put = db.prepare(
    `INSERT INTO showcase_audit (at, date, shop_code, field, old_value, new_value, source)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
  );

  return (change) => {
    put.run(at, change.date, change.shopCode, change.field, change.from, change.to, source);
  };
}

export interface ShowcaseAuditFilter {
  /** День витрины: «что меняли за 21.09». */
  date?: string;
  /** Код лавки, регистр не важен. */
  shopCode?: string;
  limit?: number;
}

/**
 * Лента правок, свежие сверху.
 *
 * Без базы (Vercel) журнала нет вовсе — там витрины и не правятся, поэтому
 * пустой список, а не ошибка.
 */
export async function readShowcaseAudit(
  filter: ShowcaseAuditFilter = {},
): Promise<ShowcaseAuditEntry[]> {
  const db = await openManualDb();
  if (!db) return [];

  const where: string[] = [];
  const args: unknown[] = [];

  if (filter.date) {
    where.push('date = ?');
    args.push(filter.date);
  }
  if (filter.shopCode) {
    // Код лавки вводят руками: «м22», «M22» латиницей, «М022». В базе он лежит
    // в одном виде, поэтому приводим ввод к нему, а не сравниваем через UPPER:
    // UPPER в SQLite работает только с латиницей и «м22» бы не нашёл.
    where.push('shop_code = ?');
    args.push(normalizeCode(filter.shopCode));
  }

  const rows = db
    .prepare(
      `SELECT at, date, shop_code, field, old_value, new_value, source
       FROM showcase_audit
       ${where.length > 0 ? `WHERE ${where.join(' AND ')}` : ''}
       ORDER BY at DESC, id DESC
       LIMIT ?`,
    )
    .all(...args, Math.min(filter.limit ?? LIMIT, 1000)) as Record<string, unknown>[];

  return rows.map((r) => ({
    at: String(r.at),
    date: String(r.date),
    shopCode: String(r.shop_code),
    field: r.field === 'note' || r.field === 'fill_afternoon' ? r.field : 'fill',
    from: r.old_value == null ? null : String(r.old_value),
    to: r.new_value == null ? null : String(r.new_value),
    source: source(r.source),
  }));
}

/** Есть ли в журнале хоть что-то: пустая лента и «журнал ещё не вёлся» — разное. */
export async function showcaseAuditCount(): Promise<number> {
  const db = await openManualDb();
  if (!db) return 0;

  const row = db.prepare(`SELECT COUNT(*) AS n FROM showcase_audit`).get() as { n: number };
  return row.n;
}

/**
 * Значение для человека: доля 0.95 — это «95%», а отсутствие значения нужно
 * показать словом, иначе строка «было  стало 95%» читается как опечатка.
 */
export function formatAuditValue(field: ShowcaseAuditField, value: string | null): string {
  if (value === null || value === '') return '—';
  if (field === 'note') return value;

  const fill = Number(value);
  return Number.isFinite(fill) ? `${Math.round(fill * 100)}%` : value;
}

export const SOURCE_TITLE: Record<ShowcaseEditSource, string> = {
  ui: 'на сайте',
  upload: 'из книги «Витрины»',
  unknown: 'источник не указан',
};

function source(raw: unknown): ShowcaseEditSource {
  return raw === 'ui' || raw === 'upload' ? raw : 'unknown';
}
