import { NextResponse } from 'next/server';
import { readStaffingLive } from '@/lib/staffing-edits';
import { selectStaffing, staffingFilename } from '@/lib/staffing-export';
import { renderStaffingReport } from '@/lib/staffing-pdf';
import { todayIso } from '@/lib/time';
import { staffingRegionFilter } from '@/lib/staffing-regions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «График пиков» в PDF для чтения и печати: сводка по должностям и раздел на
 * каждую должность с заливкой пиков (см. staffing-pdf.ts).
 *
 *   /api/staffing/pdf            — вся сеть
 *   /api/staffing/pdf?shop=М50   — одна лавка, как в таблице на вкладке
 *   /api/staffing/pdf?region=Иванов — лавки РМ
 *
 * Без пароля, как и сама вкладка (см. auth.ts).
 */
export async function GET(req: Request) {
  // С правками сайта поверх шаблона — то же, что на вкладке.
  const seed = await readStaffingLive();
  const params = new URL(req.url).searchParams;
  const picked = selectStaffing(seed, params.get('shop'), await staffingRegionFilter(params.get('region')));
  if ('error' in picked) return NextResponse.json({ ok: false, error: picked.error }, { status: 404 });

  const pdf = await renderStaffingReport({ shown: picked.shown, source: seed.source, builtAt: seed.builtAt });
  return new NextResponse(new Uint8Array(pdf), {
    headers: {
      'Content-Type': 'application/pdf',
      // inline не ставим: кнопка называется «скачать» — файл и должен скачаться.
      'Content-Disposition': `attachment; filename="${staffingFilename('pdf', picked.shop, todayIso(), picked.region)}"`,
      'Content-Length': String(pdf.length),
      'Cache-Control': 'no-store',
    },
  });
}
