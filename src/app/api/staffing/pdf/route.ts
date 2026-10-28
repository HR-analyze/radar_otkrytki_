import { NextResponse } from 'next/server';
import { readStaffing } from '@/lib/staffing-store';
import { selectStaffing, staffingFilename } from '@/lib/staffing-export';
import { renderStaffingReport } from '@/lib/staffing-pdf';
import { todayIso } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «График пиков» в PDF для чтения и печати: сводка по должностям и раздел на
 * каждую должность с заливкой пиков (см. staffing-pdf.ts).
 *
 *   /api/staffing/pdf            — вся сеть
 *   /api/staffing/pdf?shop=М50   — одна лавка, как в таблице на вкладке
 *
 * Без пароля, как и сама вкладка (см. auth.ts).
 */
export async function GET(req: Request) {
  const seed = readStaffing();
  const picked = selectStaffing(seed, new URL(req.url).searchParams.get('shop'));
  if ('error' in picked) return NextResponse.json({ ok: false, error: picked.error }, { status: 404 });

  const pdf = await renderStaffingReport({ shown: picked.shown, source: seed.source, builtAt: seed.builtAt });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline не ставим: кнопка называется «скачать» — файл и должен скачаться.
      'Content-Disposition': `attachment; filename="${staffingFilename('pdf', picked.shop, todayIso())}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store',
    },
  });
}
