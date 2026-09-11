'use client';

import Link from 'next/link';
import { useEffect } from 'react';

/**
 * Экран ошибки вместо стандартного английского.
 *
 * Радар считает статусы из выгрузок, и выгрузка бывает битой: пустой лист,
 * съехавшие колонки, отсутствующий файл. До этого экрана человек в таком
 * случае видел служебную страницу Next.js на английском и не понимал ни что
 * сломалось, ни что делать дальше.
 *
 * Текст ошибки показываем: здесь его читает тот же человек, который грузил
 * файл, и «Cannot read properties of undefined» для него — подсказка, какой
 * файл перезалить, а не шум.
 */
export default function Error({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  useEffect(() => {
    // В консоль — со стеком: без него в проде разбираться не по чему.
    console.error('Страница упала:', error);
  }, [error]);

  return (
    <div className="surface mx-auto flex max-w-xl flex-col items-start gap-4 p-6">
      <div>
        <h1 className="text-xl font-semibold tracking-tight">Страница не собралась</h1>
        <p className="mt-1.5 text-sm muted">
          Чаще всего это значит, что выгрузка, из которой считается эта страница, битая или не
          на месте. Обновление помогает, если сбой был разовым.
        </p>
      </div>

      <pre
        className="w-full overflow-x-auto rounded-lg border p-3 text-xs"
        style={{ borderColor: 'var(--border)', background: 'var(--neutral-soft)' }}
      >
        {error.message}
        {error.digest && `\n\nКод: ${error.digest}`}
      </pre>

      <div className="flex flex-wrap gap-2">
        <button
          type="button"
          onClick={reset}
          className="rounded-lg border px-3 py-2 text-sm font-medium"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          Попробовать снова
        </button>
        <Link
          href="/"
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          На сводку
        </Link>
        <Link
          href="/history"
          className="rounded-lg border px-3 py-2 text-sm"
          style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
        >
          Посмотреть, что загружали
        </Link>
      </div>
    </div>
  );
}
