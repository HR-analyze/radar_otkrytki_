import { openManualDb } from './manual-db';

/**
 * Фото витрины: к лавке за день можно приложить от 1 до 7 снимков.
 *
 * Процент наполнения — это чья-то оценка «на глаз», и спор «да там было
 * пусто» / «да всё стояло» без снимка решить нечем. Фото — подтверждение
 * цифры, а не замена ей: на статусы, баллы и конкурс оно не влияет.
 *
 * Где лежат. В той же базе ручных данных, что и наполнение: SQLite
 * `data/manual.db` на своём сервере, PostgreSQL на RelaxDev. Не в `fixtures/`
 * и не в git — по той же причине, по какой туда не кладут проценты (см.
 * manual-db.ts): деплой затёр бы всё, что сняли после последнего коммита.
 * На хостинге без базы (Vercel) фото нет вовсе — ни показать, ни добавить.
 *
 * Хранится то, что загрузили: скриншот или фото до 900 КБ браузер шлёт как
 * есть. Ужимает он только тяжёлые снимки с камеры — до 2560 px по длинной
 * стороне, без обрезки (см. ShowcasePhotos.tsx). Сервер всё равно проверяет размер и сам формат по первым
 * байтам: файлу с расширением .jpg верить на слово нельзя.
 */

/**
 * Потолок на лавку за день: витрина целиком, холодильники, крупные планы полок.
 * Было 5 — по просьбе с 15.10.2026 стало 7: на больших лавках не хватало.
 */
export const MAX_PHOTOS = 7;
/** Потолок на один файл после сжатия в браузере — с запасом на PNG-скриншот. */
export const MAX_PHOTO_BYTES = 3 * 1024 * 1024;

export type PhotoMime = 'image/jpeg' | 'image/png' | 'image/webp';

export interface ShowcasePhoto {
  id: string;
  date: string;
  shopCode: string;
  mime: PhotoMime;
  size: number;
  createdAt: string;
}

export interface PhotoFile {
  mime: PhotoMime;
  data: Buffer;
}

const usePg = (): boolean => process.env.RADAR_STORAGE === 'postgres';

/**
 * Формат по сигнатуре файла, а не по заголовку из браузера: заголовок шлёт
 * клиент, и подсунуть под видом картинки можно что угодно. Отдаём файл потом
 * с тем типом, который определили здесь.
 */
export function sniffImage(data: Uint8Array): PhotoMime | null {
  const at = (i: number) => data[i];
  if (data.length >= 3 && at(0) === 0xff && at(1) === 0xd8 && at(2) === 0xff) return 'image/jpeg';
  if (
    data.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => at(i) === b)
  ) {
    return 'image/png';
  }
  const ascii = (from: number, to: number) => String.fromCharCode(...data.subarray(from, to));
  if (data.length >= 12 && ascii(0, 4) === 'RIFF' && ascii(8, 12) === 'WEBP') return 'image/webp';
  return null;
}

/** Фото одной лавки за день — без самих байтов, только описание. Старые — первыми. */
export async function listPhotos(date: string, shopCode: string): Promise<ShowcasePhoto[]> {
  if (usePg()) {
    const { pgRows } = await import('./postgres');
    const rows = await pgRows<PhotoRow>(
      'SELECT id::text AS id,date,shop_code,mime,size,created_at FROM radar_pg_showcase_photo ' +
        'WHERE date=$1 AND shop_code=$2 ORDER BY radar_pg_showcase_photo.id',
      [date, shopCode],
    );
    return rows.map(fromRow);
  }
  const db = await openManualDb();
  if (!db) return [];
  const rows = db
    .prepare(
      `SELECT CAST(id AS TEXT) AS id, date, shop_code, mime, size, created_at FROM showcase_photo
       WHERE date = ? AND shop_code = ? ORDER BY showcase_photo.id`,
    )
    .all(date, shopCode) as PhotoRow[];
  return rows.map(fromRow);
}

/**
 * Фото одной лавки за период, по дням — для карточки лавки: там снимки
 * стоят прямо у дня, рядом с процентом наполнения. Без байтов.
 */
export async function photosByDate(
  shopCode: string,
  from: string,
  to: string,
): Promise<Record<string, ShowcasePhoto[]>> {
  let rows: PhotoRow[];
  if (usePg()) {
    const { pgRows } = await import('./postgres');
    rows = await pgRows<PhotoRow>(
      'SELECT id::text AS id,date,shop_code,mime,size,created_at FROM radar_pg_showcase_photo ' +
        'WHERE shop_code=$1 AND date BETWEEN $2 AND $3 ORDER BY date,radar_pg_showcase_photo.id',
      [shopCode, from, to],
    );
  } else {
    const db = await openManualDb();
    if (!db) return {};
    rows = db
      .prepare(
        `SELECT CAST(id AS TEXT) AS id, date, shop_code, mime, size, created_at FROM showcase_photo
         WHERE shop_code = ? AND date BETWEEN ? AND ? ORDER BY date, showcase_photo.id`,
      )
      .all(shopCode, from, to) as PhotoRow[];
  }
  const out: Record<string, ShowcasePhoto[]> = {};
  for (const r of rows) (out[r.date] ??= []).push(fromRow(r));
  return out;
}

/**
 * Сколько фото у каждой лавки — для значка «📷 3» в строке редактора.
 * Ключ — «дата|лавка». Фильтр — либо один день, либо одна лавка за период:
 * ровно те два разреза, что у редактора витрин.
 */
export async function photoCounts(
  filter: { date: string } | { shopCode: string; from: string; to: string },
): Promise<Record<string, number>> {
  const byDay = 'date' in filter;
  const out: Record<string, number> = {};

  if (usePg()) {
    const { pgRows } = await import('./postgres');
    const rows = byDay
      ? await pgRows<CountRow>(
          'SELECT date,shop_code,COUNT(*)::int AS n FROM radar_pg_showcase_photo WHERE date=$1 GROUP BY date,shop_code',
          [filter.date],
        )
      : await pgRows<CountRow>(
          'SELECT date,shop_code,COUNT(*)::int AS n FROM radar_pg_showcase_photo ' +
            'WHERE shop_code=$1 AND date BETWEEN $2 AND $3 GROUP BY date,shop_code',
          [filter.shopCode, filter.from, filter.to],
        );
    for (const r of rows) out[`${r.date}|${r.shop_code}`] = Number(r.n);
    return out;
  }

  const db = await openManualDb();
  if (!db) return out;
  const rows = (
    byDay
      ? db
          .prepare(
            `SELECT date, shop_code, COUNT(*) AS n FROM showcase_photo WHERE date = ? GROUP BY date, shop_code`,
          )
          .all(filter.date)
      : db
          .prepare(
            `SELECT date, shop_code, COUNT(*) AS n FROM showcase_photo
             WHERE shop_code = ? AND date BETWEEN ? AND ? GROUP BY date, shop_code`,
          )
          .all(filter.shopCode, filter.from, filter.to)
  ) as CountRow[];
  for (const r of rows) out[`${r.date}|${r.shop_code}`] = Number(r.n);
  return out;
}

/** Отказ, который надо показать человеку как есть, а не как сбой сервера. */
export class PhotoLimitError extends Error {}

/**
 * Добавляет фото. Лимит проверяется в той же транзакции, что и вставка: два
 * телефона, одновременно досылающие по три снимка, вместе лимит не превысят.
 */
export async function addPhotos(
  date: string,
  shopCode: string,
  files: readonly PhotoFile[],
  now = new Date().toISOString(),
): Promise<ShowcasePhoto[]> {
  const refuse = (have: number): never => {
    const left = MAX_PHOTOS - have;
    throw new PhotoLimitError(
      left <= 0
        ? `У ${shopCode} за этот день уже ${MAX_PHOTOS} фото — больше нельзя. Удалите лишнее, чтобы добавить новое.`
        : `Можно добавить ещё ${left} из ${MAX_PHOTOS}, а выбрано ${files.length}.`,
    );
  };

  if (usePg()) {
    const { pgTx } = await import('./postgres');
    await pgTx(async (c) => {
      const have = Number(
        (
          await c.query(
            'SELECT COUNT(*)::int AS n FROM radar_pg_showcase_photo WHERE date=$1 AND shop_code=$2',
            [date, shopCode],
          )
        ).rows[0].n,
      );
      if (have + files.length > MAX_PHOTOS) refuse(have);
      for (const f of files) {
        await c.query(
          'INSERT INTO radar_pg_showcase_photo(date,shop_code,mime,size,data,created_at) VALUES($1,$2,$3,$4,$5,$6)',
          [date, shopCode, f.mime, f.data.length, f.data, now],
        );
      }
    });
    return listPhotos(date, shopCode);
  }

  const db = await openManualDb();
  if (!db) {
    throw new Error(
      'Фото некуда сохранить: на этом хостинге нет диска под базу ручных данных. ' +
        'Добавляйте там, где радар развёрнут на своём сервере.',
    );
  }
  const count = db.prepare(`SELECT COUNT(*) AS n FROM showcase_photo WHERE date = ? AND shop_code = ?`);
  const put = db.prepare(
    `INSERT INTO showcase_photo (date, shop_code, mime, size, data, created_at) VALUES (?, ?, ?, ?, ?, ?)`,
  );
  db.transaction(() => {
    const have = (count.get(date, shopCode) as { n: number }).n;
    if (have + files.length > MAX_PHOTOS) refuse(have);
    for (const f of files) put.run(date, shopCode, f.mime, f.data.length, f.data, now);
  })();
  return listPhotos(date, shopCode);
}

/** Сам файл — для <img>. null — такого фото нет (или удалили). */
export async function readPhoto(id: string): Promise<(ShowcasePhoto & { data: Buffer }) | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  if (usePg()) {
    const { pgRows } = await import('./postgres');
    const [row] = await pgRows<PhotoRow & { data: Buffer }>(
      'SELECT id::text AS id,date,shop_code,mime,size,created_at,data FROM radar_pg_showcase_photo WHERE id=$1',
      [id],
    );
    return row ? { ...fromRow(row), data: row.data } : null;
  }
  const db = await openManualDb();
  if (!db) return null;
  const row = db
    .prepare(
      `SELECT CAST(id AS TEXT) AS id, date, shop_code, mime, size, created_at, data
       FROM showcase_photo WHERE id = ?`,
    )
    .get(Number(id)) as (PhotoRow & { data: Buffer }) | undefined;
  return row ? { ...fromRow(row), data: row.data } : null;
}

/** Удаляет фото. Возвращает удалённое (без байтов) — чтобы знать, чью строку обновить. */
export async function deletePhoto(id: string): Promise<ShowcasePhoto | null> {
  if (!/^\d{1,18}$/.test(id)) return null;
  if (usePg()) {
    const { pgTx } = await import('./postgres');
    return pgTx(async (c) => {
      const r = await c.query(
        'DELETE FROM radar_pg_showcase_photo WHERE id=$1 RETURNING id::text AS id,date,shop_code,mime,size,created_at',
        [id],
      );
      return r.rows.length ? fromRow(r.rows[0] as unknown as PhotoRow) : null;
    });
  }
  const db = await openManualDb();
  if (!db) return null;
  const row = db
    .prepare(
      `DELETE FROM showcase_photo WHERE id = ?
       RETURNING CAST(id AS TEXT) AS id, date, shop_code, mime, size, created_at`,
    )
    .get(Number(id)) as PhotoRow | undefined;
  return row ? fromRow(row) : null;
}

// В запросах id отдаётся строкой (id::text / CAST), а сортируется по столбцу
// таблицы с полным именем: голое «ORDER BY id» взяло бы строковый псевдоним, и
// фото № 10 встало бы раньше № 2.
type PhotoRow = {
  id: string;
  date: string;
  shop_code: string;
  mime: string;
  size: number | string;
  created_at: string;
};

type CountRow = {
  date: string;
  shop_code: string;
  n: number | string;
};

function fromRow(r: PhotoRow): ShowcasePhoto {
  return {
    id: String(r.id),
    date: r.date,
    shopCode: r.shop_code,
    mime: r.mime as PhotoMime,
    size: Number(r.size),
    createdAt: r.created_at,
  };
}
