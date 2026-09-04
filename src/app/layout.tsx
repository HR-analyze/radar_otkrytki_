import type { Metadata } from 'next';
import Image from 'next/image';
import Link from 'next/link';
import { MANAGED_TITLE, passwordSet } from '@/lib/auth';
import { UploadButton } from '@/components/UploadButton';
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
      <body className="min-h-screen">
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
          <div className="mx-auto flex max-w-[1600px] flex-wrap items-center gap-x-6 gap-y-2 px-4 py-3">
            <Link href="/" className="flex items-center gap-2 text-lg font-semibold tracking-tight">
              {/* Иконка та же, что во вкладке браузера: логотип один. */}
              <Image src="/favicon-32x32.png" alt="" width={22} height={22} priority />
              Радар витрин
            </Link>
            <nav className="flex gap-4 text-sm">
              <Link href="/" className="hover:underline">Сводка</Link>
              <Link href="/radar" className="hover:underline">Радар по лавкам</Link>
              <Link href="/showcase" className="hover:underline">Витрины</Link>
              <Link href="/history" className="hover:underline">История</Link>
              <Link href="/settings" className="hover:underline">Пороги</Link>
            </nav>
            {/* Загрузка — в шапке: данными занимается вся команда, а не только
                тот, у кого открыт репозиторий. */}
            <div className="ml-auto">
              <UploadButton />
            </div>
          </div>
        </header>
        <main className="mx-auto max-w-[1600px] px-4 py-6">{children}</main>
      </body>
    </html>
  );
}
