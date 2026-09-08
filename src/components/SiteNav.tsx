'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';

/**
 * Вкладки шапки, которые тащат за собой фильтры.
 *
 * Раньше ссылки были голыми: человек отбирал на сводке РМ и период, шёл в
 * радар — и попадал на текущий месяц по всей сети. Перенос фильтров внутри
 * страниц уже был (см. radarQuery на сводке), в шапке — нет.
 *
 * Каждая вкладка забирает только то, что умеет показывать. Критерий и статус
 * есть лишь у сводки и радара: конкурс их не читает, и параметр в ссылке
 * означал бы фильтр, которого не видно.
 */
const SHARED = ['from', 'to', 'region', 'shop'] as const;

const TABS: { href: string; label: string; keys: readonly string[] }[] = [
  { href: '/', label: 'Сводка', keys: [...SHARED, 'criterion', 'status'] },
  { href: '/radar', label: 'Радар по лавкам', keys: [...SHARED, 'criterion', 'status'] },
  { href: '/showcase', label: 'Витрины', keys: [] },
  { href: '/contest', label: 'Конкурс', keys: SHARED },
  { href: '/history', label: 'История', keys: [] },
  { href: '/settings', label: 'Пороги', keys: [] },
];

export function SiteNav() {
  const searchParams = useSearchParams();
  return <NavLinks params={searchParams} />;
}

/**
 * Ссылки без параметров: fallback для Suspense, пока не прочитан адрес.
 * Отдельный компонент, чтобы разметка шапки была одна на оба случая.
 */
export function SiteNavFallback() {
  return <NavLinks params={new URLSearchParams()} />;
}

function NavLinks({ params }: { params: URLSearchParams }) {
  return (
    <nav className="flex gap-4 text-sm">
      {TABS.map((tab) => (
        <Link key={tab.href} href={hrefWith(tab.href, tab.keys, params)} className="hover:underline">
          {tab.label}
        </Link>
      ))}
    </nav>
  );
}

/**
 * «Витрины» живут не периодом, а месяцем сводки комментариев — берём его из
 * конца выбранного периода, чтобы вкладки не показывали разные месяцы.
 */
function hrefWith(href: string, keys: readonly string[], params: URLSearchParams): string {
  const q = new URLSearchParams();

  if (href === '/showcase') {
    const to = params.get('to');
    if (to && /^\d{4}-\d{2}-\d{2}$/.test(to)) q.set('month', to.slice(0, 7));
  }

  for (const key of keys) {
    const value = params.get(key);
    if (value) q.set(key, value);
  }

  const query = q.toString();
  return query ? `${href}?${query}` : href;
}
