import { NextResponse } from 'next/server';
import { cookies } from 'next/headers';
import { STAFFING_COOKIE, isStaffingUnlocked } from '@/lib/auth';
import { canEditStaffing, deletePlaceAlias, savePlaceAliases } from '@/lib/staffing-edits';
import { normalizePlace } from '@/lib/staffing';
import { parsePlaceAliases } from '@/lib/staffing-places';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Единые названия функционалов: POST { aliases: [{ place, name }], author }
 * сохраняет строки словаря (остальные не трогает), DELETE ?place=…&author=…
 * удаляет строку. Пароль — тот же, что на правку графика (см.
 * /api/staffing/login). author — кто правит, для журнала: пароль у всех один,
 * и без имени в журнале не видно, чья правка.
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

/** Имя для журнала: обязательно, до 60 знаков. */
function parseAuthor(raw: unknown): string | null {
  const author = String(raw ?? '').replace(/\s+/g, ' ').trim();
  return author && author.length <= 60 ? author : null;
}

const NO_AUTHOR = { ok: false, error: 'Укажите, кто правит, — это попадёт в журнал правок' };

export async function POST(req: Request) {
  const denied = await guard();
  if (denied) return denied;

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }
  const author = parseAuthor((body as { author?: unknown })?.author);
  if (!author) return NextResponse.json(NO_AUTHOR, { status: 400 });
  const parsed = parsePlaceAliases(body);
  if (!parsed.ok) return NextResponse.json({ ok: false, error: parsed.error }, { status: 400 });

  await savePlaceAliases(parsed.aliases, new Date().toISOString(), author);
  return NextResponse.json({ ok: true });
}

export async function DELETE(req: Request) {
  const denied = await guard();
  if (denied) return denied;
  const params = new URL(req.url).searchParams;
  const author = parseAuthor(params.get('author'));
  if (!author) return NextResponse.json(NO_AUTHOR, { status: 400 });
  const place = normalizePlace(params.get('place') ?? '');
  if (!place) return NextResponse.json({ ok: false, error: 'Нет написания' }, { status: 400 });
  await deletePlaceAlias(place, new Date().toISOString(), author);
  return NextResponse.json({ ok: true });
}
