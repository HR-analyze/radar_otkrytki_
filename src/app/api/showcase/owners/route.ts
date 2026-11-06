import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isUnlocked } from '@/lib/auth';
import { OwnersConflictError, parseOwners } from '@/lib/showcase-owners';
import { canEditOwners, saveOwners } from '@/lib/showcase-owners-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Сохранение списка «кто какие лавки заполняет». Читает его сама страница
 * «Кто не заполнил» на сервере, поэтому GET здесь не нужен.
 *
 * Список приходит целиком и целиком же заменяет прежний. `baseUpdatedAt` —
 * с какой версией открывали редактор: не совпала — кто-то сохранил раньше,
 * и молча затирать его правку нельзя (409).
 */
export async function POST(req: NextRequest) {
  if (!(await isUnlocked(req.cookies.get(COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Нужен пароль управления. Войдите заново.' }, { status: 401 });
  }
  if (!canEditOwners()) {
    return NextResponse.json(
      { ok: false, error: 'Здесь только просмотр: на этом хостинге нет базы ручных данных.' },
      { status: 503 },
    );
  }

  let body: { owners?: unknown; baseUpdatedAt?: unknown };
  try {
    body = (await req.json()) as { owners?: unknown; baseUpdatedAt?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  const owners = parseOwners(body.owners);
  if (!owners.ok) return NextResponse.json({ ok: false, error: owners.error }, { status: 400 });
  const base = typeof body.baseUpdatedAt === 'string' ? body.baseUpdatedAt : null;

  try {
    const saved = await saveOwners(owners.value, { expectedUpdatedAt: base });
    return NextResponse.json({ ok: true, owners: saved.owners, updatedAt: saved.updatedAt });
  } catch (e) {
    if (e instanceof OwnersConflictError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Не удалось сохранить' },
      { status: 503 },
    );
  }
}
