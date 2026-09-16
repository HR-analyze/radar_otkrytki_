import { NextResponse } from 'next/server';
import { driverCook } from '@/lib/queries';
import { driverCookReportFilename, renderDriverCookReport } from '@/lib/driver-cook-pdf';
import { resolveParams } from '@/lib/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PDF-отчёт по сверке отметок за выбранный период.
 *
 * Параметры те же, что у вкладки (from, to, region, shop) и разбираются тем же
 * resolveParams — иначе отчёт по ссылке однажды показал бы не то, что на
 * экране. Считается на сервере: см. driver-cook-pdf.ts.
 */
export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = await resolveParams(sp);

  const report = await driverCook({ from: p.from, to: p.to, region: p.region, shop: p.shop });

  if (report.summary.pairs === 0) {
    return NextResponse.json(
      {
        ok: false,
        error:
          'За этот период нет дней, где face id есть и у водителя, и у повара, — отчёт был бы пустым.',
      },
      { status: 404 },
    );
  }

  const pdf = await renderDriverCookReport({ report, region: p.region, shop: p.shop });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline не ставим: кнопка называется «скачать» — файл и должен скачаться.
      'Content-Disposition': `attachment; filename="${driverCookReportFilename(p.from, p.to)}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store',
    },
  });
}
