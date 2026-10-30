import Link from 'next/link';

/**
 * Подвкладки «Графика пиков»: сам график и словарь функционалов. Вкладка в
 * шапке одна — «График пиков» подсвечен на обеих (см. isActive в SiteNav).
 */
export function StaffingTabs({ current }: { current: 'board' | 'places' }) {
  const tabs = [
    { key: 'board', href: '/staffing', label: 'График' },
    { key: 'places', href: '/staffing/functions', label: 'Функционалы' },
  ] as const;
  return (
    <nav aria-label="Разделы графика пиков" className="flex gap-1 text-sm">
      {tabs.map((t) => {
        const active = t.key === current;
        return (
          <Link
            key={t.key}
            href={t.href}
            aria-current={active ? 'page' : undefined}
            className={`rounded-lg border px-3 py-1.5 whitespace-nowrap ${active ? 'font-semibold' : 'muted hover:opacity-70'}`}
            style={{
              borderColor: active ? 'var(--focus)' : 'var(--border)',
              background: active ? 'color-mix(in srgb, var(--focus) 12%, var(--surface))' : 'var(--surface)',
            }}
          >
            {t.label}
          </Link>
        );
      })}
    </nav>
  );
}
