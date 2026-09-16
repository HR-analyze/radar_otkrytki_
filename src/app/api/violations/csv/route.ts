import { NextResponse } from 'next/server';
import { violations } from '@/lib/queries';
import { toCsv } from '@/lib/violations';
import { resolveParams } from '@/lib/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Нарушения открытия таблицей для Excel — с теми же фильтрами, что у вкладки.
 * Одна строка — одно нарушение: так его можно отфильтровать по-своему.
 */
export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = await resolveParams(sp);

  const { report, departures } = await violations({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
  });

  const csv = toCsv(report, departures);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="narusheniya-${p.from}_${p.to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
