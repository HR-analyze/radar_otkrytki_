import { latestDate, listDates, showcaseNotes } from '@/lib/queries';
import { defaultRange } from '@/lib/params';
import { canEditShowcase } from '@/lib/showcase-store';
import { isoDate } from '@/lib/time';
import { ShowcaseEditor } from '@/components/ShowcaseEditor';
import { NotesSummary } from '@/components/NotesSummary';

export const dynamic = 'force-dynamic';

/**
 * Наполнение витрин — единственные данные, которые заполняет человек, а не 1С.
 * Раньше их правили в Excel-книге и перезаливали целиком; теперь это отдельная
 * вкладка радара.
 *
 * Ниже редактора — сводка комментариев за месяц: их пишут по одному в разные
 * дни, а читать нужно вместе.
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

  // Месяц сводки — тот же, на котором открывается весь радар (см. defaultRange),
  // чтобы вкладки не показывали разные периоды.
  const month = monthParam(sp.month) ?? defaultRange(await listDates()).to.slice(0, 7);
  const notes = await showcaseNotes(`${month}-01`, `${month}-31`);

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

      <NotesSummary
        notes={notes}
        month={month}
        prev={shiftMonth(month, -1)}
        next={shiftMonth(month, 1)}
      />
    </div>
  );
}

function monthParam(value: string | string[] | undefined): string | null {
  const v = typeof value === 'string' ? value : null;
  return v && /^\d{4}-\d{2}$/.test(v) ? v : null;
}

/** «2026-09» ± месяц. Через Date, чтобы декабрь не превращался в 13-й месяц. */
function shiftMonth(month: string, by: number): string {
  const [year, m] = month.split('-').map(Number);
  const d = new Date(year, m - 1 + by, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
