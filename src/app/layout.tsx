import type { Metadata } from 'next';
import { Suspense } from 'react';
import Image from 'next/image';
import Link from 'next/link';
import { MANAGED_TITLE, passwordSet } from '@/lib/auth';
import { UploadButton } from '@/components/UploadButton';
import { SiteNav, SiteNavFallback } from '@/components/SiteNav';
import { HeaderMetrics } from '@/components/HeaderMetrics';
import { ThemeToggle, THEME_BOOT_SCRIPT } from '@/components/ThemeToggle';
import './globals.css';

export const metadata: Metadata = {
  title: 'Радар витрин',
  description: 'Контроль своевременного открытия лавок и наполнения витрин',
  icons: {
    icon: [
      { url: '/favicon.ico', sizes: '48x48' },
      { url: '/favicon-32x32.png', type: 'image/png', sizes: '32x32' },
      { url: '/favicon-16x16.png', type: 'image/png', sizes: '16x16' },
    ],
    apple: '/apple-touch-icon.png',
  },
  manifest: '/site.webmanifest',
};

export default function RootLayout({ children }: { children: React.ReactNode }) {
  const unprotected = !passwordSet();

  return (
    <html lang="ru">
      <head>
        {/* Выбранную тему ставим до первой отрисовки — иначе тёмная тема
            начинается со вспышки белого экрана. См. ThemeToggle. */}
        <script dangerouslySetInnerHTML={{ __html: THEME_BOOT_SCRIPT }} />
      </head>
      <body className="min-h-screen">
        {/* Первая остановка клавиши Tab: перепрыгнуть шапку и попасть сразу в
            таблицу. Без неё до данных приходилось шесть раз щёлкать по вкладкам,
            и так на каждой странице. Видна только когда на ней фокус. */}
        <a href="#main" className="skip-link">
          Перейти к содержимому
        </a>
        <HeaderMetrics />
        {/* Вкладки без пароля — не мелочь: без этой полосы забытая переменная
            окружения означала бы открытую правку данных, и никто бы об этом
            не узнал. */}
        {unprotected && (
          <div
            className="px-4 py-1.5 text-center text-xs"
            style={{ background: 'var(--yellow-bg, #7c5b13)', color: '#fff' }}
          >
            «{MANAGED_TITLE}» открыты без пароля. Задайте <code>RADAR_MANAGE_PASSWORD</code> в{' '}
            <code>.env.local</code> и перезапустите сайт.
          </div>
        )}
        <header
          className="sticky top-0 z-50 border-b backdrop-blur"
          style={{ borderColor: 'var(--border)', background: 'color-mix(in srgb, var(--surface) 88%, transparent)' }}
        >
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5">
            <Link
              href="/"
              className="flex shrink-0 items-center gap-2 text-lg font-semibold tracking-tight"
            >
              {/* Иконка та же, что во вкладке браузера: логотип один. */}
              <Image src="/favicon-32x32.png" alt="" width={22} height={22} priority />
              {/* На узком экране название прячем: шесть вкладок и кнопка
                  загрузки нужнее, чем ещё раз прочитать, где мы находимся. */}
              <span className="hidden sm:inline">Радар витрин</span>
            </Link>
            {/* Вкладки тащат за собой фильтры — см. SiteNav. Suspense нужен
                из-за чтения адреса: без него страница-404 не собирается. */}
            <Suspense fallback={<SiteNavFallback />}>
              <SiteNav />
            </Suspense>
            {/* Загрузка — в шапке: данными занимается вся команда, а не только
                тот, у кого открыт репозиторий. */}
            <div className="ml-auto flex shrink-0 items-center gap-2">
              <ThemeToggle />
              <UploadButton />
            </div>
          </div>
        </header>
        <main id="main" className="mx-auto max-w-[1600px] px-4 py-6">
          {children}
        </main>
      </body>
    </html>
  );
}
