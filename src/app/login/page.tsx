import { SCOPE_TITLE, type Scope } from '@/lib/auth';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

const HINT: Record<Scope, string> = {
  site: 'Радар закрыт паролем. Спросите его у своей команды.',
  manage: 'Здесь правят данные, поэтому нужен отдельный пароль.',
};

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const scope: Scope = sp.scope === 'manage' ? 'manage' : 'site';

  // Возвращаем только на свой сайт: иначе ссылкой с чужим next человека можно
  // было бы увести на посторонний адрес сразу после входа.
  const asked = typeof sp.next === 'string' ? sp.next : '/';
  const next = asked.startsWith('/') && !asked.startsWith('//') ? asked : '/';

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoginForm scope={scope} next={next} title={SCOPE_TITLE[scope]} hint={HINT[scope]} />
    </div>
  );
}
