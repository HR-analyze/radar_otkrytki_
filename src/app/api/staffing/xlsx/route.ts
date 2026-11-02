import { NextResponse } from 'next/server';
import { readStaffingLive } from '@/lib/staffing-edits';
import { selectStaffing, staffingFilename } from '@/lib/staffing-export';
import { staffingXlsx } from '@/lib/staffing-xlsx';
import { todayIso } from '@/lib/time';
import { staffingRegionFilter } from '@/lib/staffing-regions';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «График пиков» книгой Excel: люди и рубли по окнам, длинная таблица под
 * сводные и лист «Как считается» (см. staffing-xlsx.ts).
 *
 *   /api/staffing/xlsx            — вся сеть
 *   /api/staffing/xlsx?shop=М50   — одна лавка, как в таблице на вкладке
 *   /api/staffing/xlsx?region=Иванов — лавки РМ
 *
 * Без пароля, как и сама вкладка (см. auth.ts).
 */
export async function GET(req: Request) {
  // С правками сайта поверх шаблона — то же, что на вкладке.
  const seed = await readStaffingLive();
  const params = new URL(req.url).searchParams;
  const picked = selectStaffing(seed, params.get('shop'), await staffingRegionFilter(params.get('region')));
  if ('error' in picked) return NextResponse.json({ ok: false, error: picked.error }, { status: 404 });

  const file = staffingXlsx({ shown: picked.shown, source: seed.source, builtAt: seed.builtAt });
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${staffingFilename('xlsx', picked.shop, todayIso(), picked.region)}"`,
      'Content-Length': String(file.length),
      'Cache-Control': 'no-store',
    },
  });
}
