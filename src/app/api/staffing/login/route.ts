import { NextResponse } from 'next/server';
import { STAFFING_COOKIE, staffingPassword, timingSafeEqual, tokenFor } from '@/lib/auth';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Неделя: правят график редко, а забытый открытым браузер не должен править вечно. */
const MAX_AGE = 60 * 60 * 24 * 7;

/**
 * Вход в правку «Графика пиков» — свой пароль, RADAR_STAFFING_PASSWORD
 * (см. auth.ts). Не задан — правка выключена, вход не принимается.
 */
export async function POST(req: Request) {
  let body: { password?: unknown };
  try {
    body = (await req.json()) as { password?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  const expected = staffingPassword();
  if (!expected) {
    return NextResponse.json({ ok: false, error: 'Правка графика выключена: пароль на сервере не задан' }, { status: 403 });
  }
  if (!timingSafeEqual(String(body.password ?? ''), expected)) {
    return NextResponse.json({ ok: false, error: 'Неверный пароль' }, { status: 401 });
  }

  const res = NextResponse.json({ ok: true });
  res.cookies.set(STAFFING_COOKIE, await tokenFor(expected, 'staffing'), {
    httpOnly: true,
    sameSite: 'lax',
    path: '/',
    maxAge: MAX_AGE,
    secure: new URL(req.url).protocol === 'https:',
  });
  return res;
}

/** Выйти из правки — кука гасится. */
export async function DELETE() {
  const res = NextResponse.json({ ok: true });
  res.cookies.set(STAFFING_COOKIE, '', { path: '/', maxAge: 0 });
  return res;
}
