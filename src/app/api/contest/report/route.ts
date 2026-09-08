import { NextResponse } from 'next/server';
import { contest } from '@/lib/queries';
import { contestReportFilename, renderContestReport } from '@/lib/contest-pdf';
import { resolveParams } from '@/lib/params';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * PDF-отчёт по конкурсу витрин за выбранный период.
 *
 * Параметры те же, что у вкладки (from, to, region, shop) и разбираются тем же
 * resolveParams — иначе ссылка «Скачать PDF» однажды показала бы не то, что на
 * экране. Считается на сервере: см. contest-pdf.ts.
 */
export async function GET(req: Request) {
  const sp = Object.fromEntries(new URL(req.url).searchParams);
  const p = await resolveParams(sp);

  const { dates, rows, regions, total } = await contest({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
  });

  if (rows.length === 0) {
    return NextResponse.json(
      { ok: false, error: 'За этот период витрины не заполняли — отчёт был бы пустым.' },
      { status: 404 },
    );
  }

  const pdf = await renderContestReport({
    from: p.from,
    to: p.to,
    region: p.region,
    shop: p.shop,
    dates,
    rows,
    regions,
    total,
  });

  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline не ставим: кнопка называется «скачать» — файл и должен скачаться.
      'Content-Disposition': `attachment; filename="${contestReportFilename(p.from, p.to)}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store',
    },
  });
}
