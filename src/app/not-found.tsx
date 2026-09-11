import Link from 'next/link';

/**
 * Страница не найдена — по-русски и со ссылками туда, куда человек шёл.
 *
 * Сюда попадают в основном по ссылке на лавку, которой больше нет в
 * справочнике: `notFound()` в карточке лавки. Поэтому радар в списке первый —
 * оттуда лавку выбирают заново.
 */
export default function NotFound() {
  return (
    <div className="surface mx-auto flex max-w-xl flex-col items-start gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Такой страницы нет</h1>
        <p className="mt-1.5 text-sm muted">
          Если вы шли по ссылке на лавку — её могло не оказаться в справочнике за выбранный
          период. Выберите лавку заново в радаре.
        </p>
      </div>
      <div className="flex flex-wrap gap-2">
        <Link
          href="/radar"
          className="rounded-lg border px-3 py-2 text-sm font-medium"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          Радар по лавкам
        </Link>
        <Link
          href="/"
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          На сводку
        </Link>
      </div>
    </div>
  );
}
