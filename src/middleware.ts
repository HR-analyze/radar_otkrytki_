import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isManaged, isPublic, isUnlocked, type Scope } from './lib/auth';

/**
 * Пароль на вход. Проверяется здесь, до страницы: иначе каждую страницу и
 * каждый роут пришлось бы закрывать вручную, и однажды кто-нибудь забыл бы.
 *
 * Два уровня: общий пароль на весь радар и отдельный — на «Витрины» и
 * «Историю», где данные правят (см. auth.ts).
 */
export async function middleware(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  if (isPublic(pathname)) return NextResponse.next();

  const needed: Scope[] = isManaged(pathname) ? ['site', 'manage'] : ['site'];

  for (const scope of needed) {
    if (await isUnlocked(scope, req.cookies.get(COOKIE[scope])?.value)) continue;

    // Запросам от кода отвечаем кодом, а не редиректом на страницу входа:
    // иначе fetch получил бы HTML вместо JSON и сломался невнятно.
    if (pathname.startsWith('/api/')) {
      return NextResponse.json(
        { ok: false, error: 'Нужен пароль. Откройте сайт и войдите заново.' },
        { status: 401 },
      );
    }

    const url = req.nextUrl.clone();
    url.pathname = '/login';
    url.search = '';
    url.searchParams.set('scope', scope);
    url.searchParams.set('next', `${pathname}${search}`);
    return NextResponse.redirect(url);
  }

  return NextResponse.next();
}

export const config = {
  // Статику и иконки не трогаем: они и так ничего не раскрывают, а лишняя
  // проверка на каждом файле только замедляет отдачу.
  matcher: [
    '/((?!_next/static|_next/image|favicon|apple-touch-icon|android-chrome|site\\.webmanifest).*)',
  ],
};

/**
 * Node, а не Edge: в Edge-сборке `process.env` подставляется на этапе сборки,
 * и пароль, заданный на сервере после неё, middleware бы не увидел.
 */
export const runtime = 'nodejs';
