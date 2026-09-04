/**
 * Пароль на вкладки, где правят данные.
 *
 * Сам радар открыт: цифры смотрит вся команда, и лишний барьер на входе только
 * мешает. Закрыты «Витрины» и «История» — там данные меняют, и доступ туда
 * нужен не всем.
 *
 * Пароль лежит в переменной окружения, а не в репозитории: пароль в git — это
 * пароль, который видит каждый, у кого есть доступ к коду, и который нельзя
 * сменить без правки кода. На сервере он задаётся в `.env.local` (файл в
 * .gitignore) — см. README, раздел «Пароль».
 *
 * Если переменная не задана, пароль не спрашивается вовсе: иначе `npm run dev`
 * и тесты требовали бы его. Чтобы это не оказалось молчаливой дырой, шапка
 * сайта в таком случае прямо пишет, что вкладки открыты.
 *
 * В куке лежит не пароль, а его отпечаток: даже вытащив куку из браузера,
 * прочитать сам пароль нельзя.
 */

export const COOKIE = 'radar_manage';

/** Вкладки под паролем. Остальной радар открыт. */
const MANAGED = ['/showcase', '/history', '/api/showcase'];

export const MANAGED_TITLE = 'Витрины и История';

export function password(): string | undefined {
  return process.env.RADAR_MANAGE_PASSWORD || undefined;
}

/** Задан ли пароль. Не задан — вкладки открыты, и шапка об этом пишет. */
export function passwordSet(): boolean {
  return password() !== undefined;
}

/**
 * Пути, которые пароль не спрашивают вовсе:
 *  · сама страница входа — иначе войти было бы некуда;
 *  · крон-роуты — они ходят без браузера и куку завести не могут, у них своя
 *    проверка по Bearer CRON_SECRET внутри роута (см. checkCronSecret).
 */
export function isPublic(pathname: string): boolean {
  return (
    pathname === '/login' || pathname === '/api/login' || pathname.startsWith('/api/cron/')
  );
}

/** Нужен ли для пути пароль. */
export function isManaged(pathname: string): boolean {
  return MANAGED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Значение куки — SHA-256 от пароля с солью. Считается через Web Crypto:
 * middleware выполняется там, где node:crypto может быть недоступен.
 */
export async function tokenFor(value: string): Promise<string> {
  const data = new TextEncoder().encode(`radar:manage:${value}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** Совпадает ли кука с действующим паролем. Пароля нет — открыто. */
export async function isUnlocked(cookieValue: string | undefined): Promise<boolean> {
  const expected = password();
  if (!expected) return true;
  if (!cookieValue) return false;

  return cookieValue === (await tokenFor(expected));
}

/* ------------------------------ крон-роуты ------------------------------ */

/** Крон-роуты закрыты общим секретом: Authorization: Bearer <CRON_SECRET>. */
export function checkCronSecret(req: Request): { ok: true } | { ok: false; reason: string } {
  const expected = process.env.CRON_SECRET;
  if (!expected) return { ok: false, reason: 'CRON_SECRET не задан на сервере' };

  const header = req.headers.get('authorization') ?? '';
  const token = header.startsWith('Bearer ') ? header.slice(7) : '';
  if (!token || !timingSafeEqual(token, expected)) {
    return { ok: false, reason: 'Неверный или отсутствующий токен' };
  }
  return { ok: true };
}

function timingSafeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
