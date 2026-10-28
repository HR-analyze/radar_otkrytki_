import { NextResponse } from 'next/server';
import { readStaffing } from '@/lib/staffing-store';
import { selectStaffing, staffingFilename } from '@/lib/staffing-export';
import { staffingXlsx } from '@/lib/staffing-xlsx';
import { todayIso } from '@/lib/time';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * «График пиков» книгой Excel: люди и рубли по окнам, длинная таблица под
 * сводные и лист «Как считается» (см. staffing-xlsx.ts).
 *
 *   /api/staffing/xlsx            — вся сеть
 *   /api/staffing/xlsx?shop=М50   — одна лавка, как в таблице на вкладке
 *
 * Без пароля, как и сама вкладка (см. auth.ts).
 */
export async function GET(req: Request) {
  const seed = readStaffing();
  const picked = selectStaffing(seed, new URL(req.url).searchParams.get('shop'));
  if ('error' in picked) return NextResponse.json({ ok: false, error: picked.error }, { status: 404 });

  const file = staffingXlsx({ shown: picked.shown, source: seed.source, builtAt: seed.builtAt });
  return new NextResponse(new Uint8Array(file), {
    headers: {
      'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'Content-Disposition': `attachment; filename="${staffingFilename('xlsx', picked.shop, todayIso())}"`,
      'Content-Length': String(file.length),
      'Cache-Control': 'no-store',
    },
  });
}
