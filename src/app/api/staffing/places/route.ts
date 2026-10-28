import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { STAFFING_COOKIE, isStaffingUnlocked } from '@/lib/auth';
import { canEditStaffing, savePlaceAliases } from '@/lib/staffing-edits';
import { parsePlaceAliases } from '@/lib/staffing-places';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Единые названия функционалов: POST { aliases: [{ place, name }] } сохраняет
 * строки словаря (остальные не трогает). Пароль — тот же, что на правку
 * графика (см. /api/staffing/login).
 */
export async function POST(req: Request) {
  const jar = await cookies();
  if (!(await isStaffingUnlocked(jar.get(STAFFING_COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Нужен пароль на правку графика' }, { status: 401 });
  }
  if (!canEditStaffing()) {
    return NextResponse.json({ ok: false, error: 'На этом хостинге правки негде хранить' }, { status: 503 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }
  const parsed = parsePlaceAliases(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  await savePlaceAliases(parsed.aliases, new Date().toISOString());
  return NextResponse.json({ ok: true });
}
