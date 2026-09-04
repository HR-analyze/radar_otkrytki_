import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isManaged, isPublic, isUnlocked } from './lib/auth';

/**
 * Пароль на «Витрины» и «Историю». Проверяется здесь, до страницы: иначе
 * каждый роут пришлось бы закрывать вручную, и однажды кто-нибудь забыл бы.
 *
 * Остальной радар открыт — цифры смотрит вся команда (см. auth.ts).
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname) || !isManaged(pathname)) return NextResponse.next();
  if (await isUnlocked(req.cookies.get(COOKIE)?.value)) return NextResponse.next();

  // Запросам от кода отвечаем кодом, а не редиректом на страницу входа:
  // иначе fetch получил бы HTML вместо JSON и сломался невнятно.
  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { ok: false, error: 'Нужен пароль. Откройте вкладку и введите его заново.' },
      { status: 401 },
    );
  }

  const url = req.nextUrl.clone();
  url.pathname = '/login';
  url.search = '';
  url.searchParams.set('next', `${pathname}${search}`);
  return NextResponse.redirect(url);
}

export const config = {
  // Проверять нужно только защищённые вкладки, но matcher не умеет в логику
  // из auth.ts — статику отсекаем здесь, остальное решает сам обработчик.
  matcher: [
    '/((?!_next/static|_next/image|favicon|apple-touch-icon|android-chrome|site\\.webmanifest).*)',
  ],
};

/**
 * Node, а не Edge: в Edge-сборке `process.env` подставляется на этапе сборки,
 * и пароль, заданный на сервере после неё, middleware бы не увидел.
 */
export const runtime = 'nodejs';
