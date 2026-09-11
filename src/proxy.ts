import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isManaged, isPublic, isUnlocked } from './lib/auth';
import { looksLikeShopCode } from './lib/shops';

/**
 * Пароль на вкладки, где данные правят: «Витрины», «История», «Пороги».
 * Проверяется здесь, до страницы: иначе каждый роут пришлось бы закрывать
 * вручную, и однажды кто-нибудь забыл бы.
 *
 * Остальной радар открыт — цифры смотрит вся команда (см. auth.ts).
 *
 * Файл назывался middleware.ts: в Next 16 это соглашение объявлено устаревшим
 * и переименовано в proxy — сборка предупреждала об этом на каждом запуске.
 */
export async function proxy(req: NextRequest) {
  const { pathname, search } = req.nextUrl;

  /*
   * Мусорный адрес лавки отсекаем здесь, до рендера: страница зовёт
   * `notFound()` уже во время отрисовки, когда ответ начал передаваться со
   * статусом 200 и поменять его нельзя. Человек и раньше видел «такой
   * страницы нет», но мониторинг и поисковики получали «всё хорошо».
   *
   * Отсекаем только по формату кода — почему именно так, см. looksLikeShopCode.
   */
  const shop = /^\/shop\/([^/]+)\/?$/.exec(pathname);
  if (shop && !looksLikeShopCode(safeDecode(shop[1]))) {
    return NextResponse.rewrite(new URL('/not-found', req.url), { status: 404 });
  }

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

/*
 * Раньше здесь стояло `export const runtime = 'nodejs'`: в Edge-сборке
 * `process.env` подставляется на этапе сборки, и пароль, заданный на сервере
 * после неё, проверка бы не увидела. Proxy работает на Node по умолчанию, а
 * сам параметр здесь запрещён — с ним файл падает с ошибкой.
 */

/** Кривая кодировка в адресе — не повод падать: считаем такой код негодным. */
function safeDecode(value: string): string {
  try {
    return decodeURIComponent(value);
  } catch {
    return value;
  }
}
