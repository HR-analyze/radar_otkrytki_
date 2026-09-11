'use client';

import Link from 'next/link';
import { usePathname, useSearchParams } from 'next/navigation';

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
 *
 * Подсветка текущей вкладки здесь работает: путь читается через usePathname,
 * а он, в отличие от параметров адреса, доступен сразу и Suspense не требует.
 */
export function SiteNavFallback() {
  return <NavLinks params={new URLSearchParams()} />;
}

function NavLinks({ params }: { params: URLSearchParams }) {
  const pathname = usePathname();

  return (
    /*
     * На телефоне шесть вкладок переносились на две-три строки и разъезжали
     * шапку по высоте. Здесь они складываются в одну ленту с прокруткой вбок:
     * высота постоянная, а до дальних вкладок можно домотать пальцем.
     * scrollbar полосу не рисуем — она бы съела и без того тесную высоту.
     */
    <nav
      aria-label="Разделы радара"
      className="-mx-1 flex max-w-full gap-1 overflow-x-auto px-1 text-sm [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
    >
      {TABS.map((tab) => {
        const active = isActive(pathname, tab.href);
        return (
          <Link
            key={tab.href}
            href={hrefWith(tab.href, tab.keys, params)}
            /*
             * Где я нахожусь — раньше не отвечал ни один пиксель: шесть ссылок
             * выглядели одинаково на всех шести страницах. Цвет не единственный
             * признак: у текущей вкладки ещё и подложка, и жирность, и
             * aria-current для программ чтения с экрана.
             */
            aria-current={active ? 'page' : undefined}
            className={`shrink-0 rounded-lg px-2.5 py-1.5 whitespace-nowrap transition-colors ${
              active ? 'font-semibold' : 'muted hover:opacity-70'
            }`}
            style={
              active
                ? { background: 'color-mix(in srgb, var(--focus) 12%, transparent)', color: 'var(--text)' }
                : undefined
            }
          >
            {tab.label}
          </Link>
        );
      })}
    </nav>
  );
}

/**
 * Текущая вкладка. Карточка лавки — это тоже радар: человек попал в неё
 * из таблицы и продолжает быть «в радаре», подсвечивать нечего другого.
 */
function isActive(pathname: string, href: string): boolean {
  if (href === '/') return pathname === '/';
  if (href === '/radar') return pathname === '/radar' || pathname.startsWith('/shop/');
  return pathname === href || pathname.startsWith(`${href}/`);
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
