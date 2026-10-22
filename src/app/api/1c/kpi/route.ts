import { NextResponse } from 'next/server';
import { ONEC_VALUE, checkOnecToken, guidOf, onecPeriod, onecValue } from '@/lib/onec';
import { kpiDays } from '@/lib/queries';

export const dynamic = 'force-dynamic';

/**
 * Показатели радара открытий для 1С: GET /api/1c/kpi?from=…&to=… (или date=…).
 * Authorization: Bearer <RADAR_1C_TOKEN>. Формат ответа — README, «API для 1С».
 */
export async function GET(req: Request) {
  const auth = checkOnecToken(req);
  if (!auth.ok) return NextResponse.json({ ok: false, error: auth.error }, { status: auth.status });

  const period = onecPeriod(new URL(req.url).searchParams);
  if (!period.ok) return NextResponse.json({ ok: false, error: period.error }, { status: 400 });

  try {
    const days = await kpiDays(period.from, period.to);

    const items = [];
    // Лавка без GUID в справочнике 1С: в 1С её не к чему привязать, но и
    // молча терять нельзя — пусть будет видно, чьи дни не доехали.
    const unmapped = new Map<string, string>();
    for (const d of days) {
      const value = onecValue(d.status);
      if (value == null) continue;
      const guid = guidOf(d.shop.code);
      if (!guid) {
        unmapped.set(d.shop.code, d.shop.name);
        continue;
      }
      items.push({
        date: d.date,
        guid,
        shopCode: d.shop.code,
        shopName: d.shop.name,
        value,
        components: d.components && {
          driver: onecValue(d.components.driver),
          staff: onecValue(d.components.staff),
          showcase: onecValue(d.components.showcase),
        },
      });
    }

    return NextResponse.json({
      ok: true,
      radar: 'opening',
      from: period.from,
      to: period.to,
      scale: ONEC_VALUE,
      items,
      unmapped: [...unmapped].map(([shopCode, shopName]) => ({ shopCode, shopName })),
    });
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : String(e) },
      { status: 500 },
    );
  }
}
