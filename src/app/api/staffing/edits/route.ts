import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { STAFFING_COOKIE, isStaffingUnlocked } from '@/lib/auth';
import { findStaffNorm } from '@/lib/staffing';
import { readStaffing } from '@/lib/staffing-store';
import {
  canEditStaffing,
  parseStaffingEdit,
  readPlaceAliasesSafe,
  readStaffingLive,
  resetStaffingEdit,
  restrictToCatalog,
  saveStaffingEdit,
} from '@/lib/staffing-edits';
import { functionCatalog, placeAliasMap } from '@/lib/staffing-places';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Правка «Графика пиков» по лавке: POST { shop, roles } сохраняет числа в
 * окнах и дислокации, DELETE ?shop=М50 возвращает лавку к шаблону.
 * Только с куки входа в правку (см. /api/staffing/login).
 */
async function guard(): Promise<NextResponse | null> {
  const jar = await cookies();
  if (!(await isStaffingUnlocked(jar.get(STAFFING_COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Нужен пароль на правку графика' }, { status: 401 });
  }
  if (!canEditStaffing()) {
    return NextResponse.json({ ok: false, error: 'На этом хостинге правки негде хранить' }, { status: 503 });
  }
  return null;
}

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  let body: { shop?: unknown; roles?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }
  // Правку сверяем с шаблоном, а не с прежней правкой: окна задаёт шаблон.
  const norm = findStaffNorm(readStaffing().norms, String(body.shop ?? ''));
  if (!norm) return NextResponse.json({ ok: false, error: 'Нет такой лавки' }, { status: 404 });

  const parsed = parseStaffingEdit(norm, body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  // Посты — только функционалы из справочника, как в выпадающем списке формы.
  const [{ norms }, saved] = await Promise.all([readStaffingLive(), readPlaceAliasesSafe()]);
  const checked = restrictToCatalog(parsed.roles, functionCatalog(norms, saved), placeAliasMap(saved));
  if (!checked.ok) return NextResponse.json({ ok: false, error: checked.error }, { status: 400 });

  await saveStaffingEdit(norm.code, checked.roles, new Date().toISOString());
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const norm = findStaffNorm(readStaffing().norms, new URL(req.url).searchParams.get('shop'));
  if (!norm) return NextResponse.json({ ok: false, error: 'Нет такой лавки' }, { status: 404 });
  await resetStaffingEdit(norm.code);
  return NextResponse.json({ ok: true });
}
