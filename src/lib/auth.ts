/**
 * Пароли на сайт и на вкладки с ручными данными.
 *
 * Два уровня. `site` закрывает радар целиком — его знают все, кто смотрит
 * цифры. `manage` дополнительно закрывает «Витрины» и «Историю»: там правят
 * данные, и доступ туда нужен не всем.
 *
 * Сами пароли лежат в переменных окружения, а не в репозитории: пароль в git —
 * это пароль, который видит каждый, у кого есть доступ к коду, и который
 * нельзя сменить без правки кода. На сервере они задаются в `.env.local`
 * (файл в .gitignore) — см. README, раздел «Пароли».
 *
 * Если переменная не задана, соответствующий уровень не спрашивается вовсе:
 * иначе `npm run dev` и тесты требовали бы пароль. Чтобы это не оказалось
 * молчаливой дырой, шапка сайта в таком случае прямо пишет, что пароля нет.
 *
 * В куке лежит не пароль, а его отпечаток: даже вытащив куку из браузера,
 * прочитать сам пароль нельзя.
 */

export type Scope = 'site' | 'manage';

export const COOKIE: Record<Scope, string> = {
  site: 'radar_site',
  manage: 'radar_manage',
};

/** Вкладки, для которых мало общего пароля. */
const MANAGED = ['/showcase', '/history', '/api/showcase'];

export const SCOPE_TITLE: Record<Scope, string> = {
  site: 'Радар витрин',
  manage: 'Витрины и История',
};

export function passwordFor(scope: Scope): string | undefined {
  const value = scope === 'site' ? process.env.RADAR_PASSWORD : process.env.RADAR_MANAGE_PASSWORD;
  return value ? value : undefined;
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

/** Нужен ли для пути отдельный пароль на правку данных. */
export function isManaged(pathname: string): boolean {
  return MANAGED.some((p) => pathname === p || pathname.startsWith(`${p}/`));
}

/**
 * Значение куки — SHA-256 от пароля с солью-областью. Считается через Web
 * Crypto, потому что middleware выполняется в Edge-окружении, где node:crypto
 * недоступен.
 */
export async function tokenFor(scope: Scope, password: string): Promise<string> {
  const data = new TextEncoder().encode(`radar:${scope}:${password}`);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * Уровни, оставшиеся без пароля. Шапка показывает это прямым текстом: забытая
 * переменная окружения иначе означала бы открытый сайт, о котором никто
 * не знает.
 */
export function openScopes(): Scope[] {
  return (['site', 'manage'] as Scope[]).filter((s) => !passwordFor(s));
}

/** Совпадает ли кука с действующим паролем. Без пароля уровень открыт. */
export async function isUnlocked(scope: Scope, cookieValue: string | undefined): Promise<boolean> {
  const password = passwordFor(scope);
  if (!password) return true;
  if (!cookieValue) return false;

  return cookieValue === (await tokenFor(scope, password));
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
