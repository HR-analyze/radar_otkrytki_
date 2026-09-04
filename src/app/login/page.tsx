import { MANAGED_TITLE } from '@/lib/auth';
import { LoginForm } from '@/components/LoginForm';

export const dynamic = 'force-dynamic';

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;

  // Возвращаем только на свой сайт: иначе ссылкой с чужим next человека можно
  // было бы увести на посторонний адрес сразу после входа.
  const asked = typeof sp.next === 'string' ? sp.next : '/showcase';
  const next = asked.startsWith('/') && !asked.startsWith('//') ? asked : '/showcase';

  return (
    <div className="flex min-h-[60vh] items-center justify-center">
      <LoginForm
        next={next}
        title={MANAGED_TITLE}
        hint="Здесь правят данные, поэтому нужен пароль. Остальной радар открыт."
      />
    </div>
  );
}
