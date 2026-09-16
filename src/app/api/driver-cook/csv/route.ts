import { NextResponse } from 'next/server';
import { driverCook } from '@/lib/queries';
import { toCsv } from '@/lib/driver-cook';
import { resolveParams } from '@/lib/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Все пары «водитель ↔ первый повар» за период — таблицей для Excel.
 *
 * Параметры те же, что у вкладки (from, to, region, shop) и разбираются тем же
 * resolveParams: иначе выгрузка по ссылке однажды показала бы не то, что на
 * экране. В файл идут все пары, а не только совпавшие, — чтобы в Excel можно
 * было отфильтровать по-своему и увидеть знаменатель.
 */
export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = await resolveParams(sp);

  const report = await driverCook({ from: p.from, to: p.to, region: p.region, shop: p.shop });

  if (report.pairs.length === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'За этот период нет дней, где face id есть и у водителя, и у повара, — файл был бы пустым.',
      },
      { status: 404 },
    );
  }

  const csv = toCsv(report.pairs);

  return new NextResponse(csv, {
    headers: {
      'Content-Type': 'text/csv; charset=utf-8',
      'Content-Disposition': `attachment; filename="sverka-otmetok-${p.from}_${p.to}.csv"`,
      'Cache-Control': 'no-store',
    },
  });
}
