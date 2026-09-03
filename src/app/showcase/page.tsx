import { latestDate } from '@/lib/queries';
import { canEditShowcase } from '@/lib/showcase-store';
import { isoDate } from '@/lib/time';
import { ShowcaseEditor } from '@/components/ShowcaseEditor';

export const dynamic = 'force-dynamic';

/**
 * Наполнение витрин — единственные данные, которые заполняет человек, а не 1С.
 * Раньше их правили в Excel-книге и перезаливали целиком; теперь это отдельная
 * вкладка радара.
 */
export default async function ShowcasePage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const sp = await searchParams;
  const asked = typeof sp.date === 'string' ? sp.date : null;

  // По умолчанию открываем сегодняшний день: его и заполняют.
  const initial = asked ?? isoDate(new Date());
  const last = await latestDate();

  return (
    <div className="flex flex-col gap-5">
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Наполнение витрин</h1>
        <p className="mt-1 text-sm muted">
          {canEditShowcase()
            ? 'Заполняется здесь, руками. Правки сразу идут в дашборд — перезагружать и перезаливать ничего не нужно.'
            : 'Просмотр: этот хостинг не даёт записи, править можно там, где радар стоит на своём сервере.'}
          {last && ` Последний день с данными — ${last.split('-').reverse().slice(0, 2).join('.')}.`}
        </p>
      </div>

      <ShowcaseEditor initialDate={initial} />
    </div>
  );
}
