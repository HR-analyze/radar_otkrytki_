import { NextResponse } from 'next/server';
import { COOKIE, passwordFor, tokenFor, type Scope } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Месяц: внутренний инструмент, вводить пароль каждый день незачем. */
const MAX_AGE = 60 * 60 * 24 * 30;

export async function POST(req: Request) {
  let body: { password?: unknown; scope?: unknown };
  try {
    body = (await req.json()) as { password?: unknown; scope?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  const scope: Scope = body.scope === 'manage' ? 'manage' : 'site';
  const expected = passwordFor(scope);
  if (!expected) {
    return NextResponse.json({ ok: true, note: 'Пароль не задан — вход не требуется' });
  }

  const got = String(body.password ?? '');
  if (got !== expected) {
    return NextResponse.json({ ok: false, error: 'Неверный пароль' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(COOKIE[scope], await tokenFor(scope, expected), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
    // Только на https: под http такая кука не сохранилась бы вовсе, и вход
    // молча не срабатывал бы.
    secure: new URL(req.url).protocol === 'https:',
  });
  return res;
}
