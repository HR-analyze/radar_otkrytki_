import { NextResponse } from 'next/server';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Diagnoses the new RelaxDev PostgreSQL storage without leaking URL,
 * passwords, hostnames or raw database error text to the browser.
 */
export async function GET() {
  if (process.env.RADAR_STORAGE !== 'postgres') {
    return NextResponse.json({ ok: true, mode: process.env.RADAR_STORAGE || 'auto', postgres: 'disabled' });
  }
  try {
    const { pgRows } = await import('@/lib/postgres');
    await pgRows('SELECT 1 AS ping');
    return NextResponse.json({ ok: true, mode: 'postgres', postgres: 'connected' });
  } catch (error) {
    const e = error as { code?: string; name?: string };
    // Error details stay in private server logs; never expose DATABASE_URL.
    console.error('[radar][postgres-health] Connection failed', e);
    return NextResponse.json({
      ok: false,
      mode: 'postgres',
      postgres: 'error',
      code: typeof e.code === 'string' ? e.code : 'UNKNOWN',
    }, { status: 503 });
  }
}
