import { NextResponse } from 'next/server';
import { loadSnapshot } from '@/lib/snapshot';
import { uploadCapability } from '@/lib/upload-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Состояние загрузки для панели на дашборде.
 *
 * Помимо режима отдаёт отпечаток выгрузок из снимка: по нему UI понимает, что
 * пересборка после коммита закончилась и новые данные уже отдаются. Сравнивать
 * даты недостаточно — файл могли перезалить за тот же день.
 */
export async function GET() {
  const capability = uploadCapability();
  const snapshot = await loadSnapshot();
  const dates = [...new Set(snapshot.criteria.map((c) => c.date))].sort();

  return NextResponse.json({
    mode: capability.mode,
    hint: capability.hint,
    tokenRequired: capability.tokenRequired,
    fingerprint: snapshot.fixturesFingerprint,
    generatedAt: snapshot.generatedAt,
    dates: {
      from: dates[0] ?? null,
      to: dates[dates.length - 1] ?? null,
      count: dates.length,
    },
  });
}
