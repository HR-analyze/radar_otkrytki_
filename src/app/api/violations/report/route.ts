import { NextResponse } from 'next/server';
import { violations } from '@/lib/queries';
import { renderViolationsReport, violationsReportFilename } from '@/lib/violations-pdf';
import { resolveParams } from '@/lib/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PDF-отчёт по нарушениям открытия за выбранный период.
 *
 * Параметры те же, что у вкладки (from, to, region, shop) и разбираются тем же
 * resolveParams — иначе отчёт по ссылке однажды показал бы не то, что на
 * экране. Вёрстка — violations-pdf.ts.
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

  if (report.summary.checked === 0 && !departures.hasData) {
    return NextResponse.json(
      {
        ok: false,
        error: 'За этот период нет ни отметок водителей, ни выгрузки по РЦ — отчёт был бы пустым.',
      },
      { status: 404 },
    );
  }

  const pdf = await renderViolationsReport({
    report,
    departures,
    region: p.region,
    shop: p.shop,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline не ставим: кнопка называется «скачать» — файл и должен скачаться.
      'Content-Disposition': `attachment; filename="${violationsReportFilename(p.from, p.to)}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store',
    },
  });
}
