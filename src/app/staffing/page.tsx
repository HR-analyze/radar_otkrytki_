import { readStaffing } from '@/lib/staffing-store';
import { findStaffNorm, parseTimeOfDay } from '@/lib/staffing';
import { clockNow } from '@/lib/time';
import { StaffingBoard } from '@/components/StaffingBoard';

export const dynamic = 'force-dynamic';

/**
 * Норма выхода сотрудников: сколько кассиров, поваров, бариста и уборщиков
 * должно быть на смене в лавке в каждом часовом окне. Источник — шаблон «по
 * часам-пикам», правило окон — в staffing.ts.
 *
 * Страница читает из адреса лавку и время (`?shop=М1&time=14:00`); без них
 * открывается на первой лавке и текущем времени по Москве. Лавка понимает и
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

  const { norms, source, builtAt } = readStaffing();
  if (norms.length === 0) {
    return (
      <div className="surface p-8 text-center text-sm muted">
        Шаблон норм выхода ещё не загружен. Соберите его командой{' '}
        <code>npm run staffing:build -- шаблон.xlsx</code>.
      </div>
    );
  }

  const shop = findStaffNorm(norms, one('shop')) ?? norms[0];
  const minutes = parseTimeOfDay(one('time')) ?? clockNow();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Норма выхода сотрудников</h1>
        <p className="mt-1 text-sm muted">
          Сколько человек каждой должности должно быть на смене. Выберите лавку и время — радар покажет норму
          на этот момент. Источник — {source}, собран {builtAt.split('-').reverse().join('.')}.
        </p>
      </div>
      <StaffingBoard norms={norms} initialCode={shop.code} initialMinutes={minutes} />
    </div>
  );
}
