import { cookies } from 'next/headers';
import { readStaffingLive, canEditStaffing } from '@/lib/staffing-edits';
import { STAFFING_COOKIE, isStaffingUnlocked, staffingPassword } from '@/lib/auth';
import { findStaffNorm, parseTimeOfDay } from '@/lib/staffing';
import { minutesNowMsk } from '@/lib/time';
import { StaffingBoard } from '@/components/StaffingBoard';

export const dynamic = 'force-dynamic';

/**
 * Норма выхода сотрудников: сколько кассиров, поваров, бариста и уборщиков
 * должно быть на смене в лавке в каждом часовом окне. Источник — шаблон «по
 * часам-пикам», правило окон — в staffing.ts.
 *
 * Страница читает из адреса лавку и время (`?shop=М1&time=14:00`); без них
 * открывается на всех лавках и текущем времени по Москве. Лавка понимает и
 * поиск со сводки и радара — его шапка переносит сюда.
 */
export default async function StaffingPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const one = (k: string) => {
    const v = sp[k];
    return Array.isArray(v) ? v[0] : v;
  };

  const { norms, source, builtAt } = await readStaffingLive();
  // Править можно, если пароль на правку задан и хранилище есть; войти —
  // кнопкой на вкладке, тогда кука уже стоит.
  const editable = Boolean(staffingPassword()) && canEditStaffing();
  const unlocked = editable && (await isStaffingUnlocked((await cookies()).get(STAFFING_COOKIE)?.value));
  if (norms.length === 0) {
    return (
      <div className="surface p-8 text-center text-sm muted">
        Шаблон норм выхода ещё не загружен. Соберите его командой{' '}
        <code>npm run staffing:build -- шаблон.xlsx</code>.
      </div>
    );
  }

  const shop = findStaffNorm(norms, one('shop'));
  const fixed = parseTimeOfDay(one('time'));
  const minutes = fixed ?? minutesNowMsk();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">График пиков</h1>
        <p className="mt-1 text-sm muted">
          Сколько человек каждой должности должно быть на смене. Выберите лавку и время — радар покажет норму
          на этот момент. Источник — {source}, собран {builtAt.split('-').reverse().join('.')}.
        </p>
      </div>
      <StaffingBoard
        norms={norms}
        initialCode={shop?.code ?? null}
        initialMinutes={minutes}
        initialLive={fixed == null}
        editable={editable}
        unlocked={unlocked}
      />
    </div>
  );
}
