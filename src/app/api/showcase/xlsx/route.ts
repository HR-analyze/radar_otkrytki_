import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { listShops } from '@/lib/queries';
import { readShowcase } from '@/lib/showcase-store';
import { showcaseXlsx, showcaseXlsxRows } from '@/lib/showcase-xlsx';
import { isOpenOn } from '@/lib/status';
import { dateRange, todayIso } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/** Больше года за раз не отдаём: это уже не выгрузка, а бэкап (см. showcase:export). */
const MAX_DAYS = 366;

/**
 * Наполнение витрин за период таблицей Excel: номер лавки, дата, утро, 16:00.
 *
 *   /api/showcase/xlsx?from=2026-09-01&to=2026-09-30
 *
 * Дни после сегодняшнего отрезаются: будущие пустые строки выглядели бы
 * пропусками. Под паролем «Витрин» — роут лежит под /api/showcase (см. auth.ts).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const from = params.get('from') ?? '';
  const rawTo = params.get('to') ?? '';
  if (!ISO_DATE.test(from) || !ISO_DATE.test(rawTo) || from > rawTo) {
    return NextResponse.json(
      { ok: false, error: 'Нужен период в виде from=2026-09-01&to=2026-09-30' },
      { status: 400 },
    );
  }

  const today = todayIso();
  const to = rawTo > today ? today : rawTo;
  const dates = from > to ? [] : dateRange(from, to);
  if (dates.length > MAX_DAYS) {
    return NextResponse.json(
      { ok: false, error: `Период длиннее ${MAX_DAYS} дней — разбейте его на части` },
      { status: 400 },
    );
  }

  const config = loadConfig();
  const [store, shops] = await Promise.all([readShowcase(), listShops()]);
  const rows = showcaseXlsxRows(
    store,
    shops.map((s) => s.code),
    dates,
    (code, date) => isOpenOn(config, code, date),
  );

  return new NextResponse(new Uint8Array(showcaseXlsx(rows)), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="vitriny-${from}_${rawTo}.xlsx"`,
      'Cache-Control': 'no-store',
    },
  });
}
