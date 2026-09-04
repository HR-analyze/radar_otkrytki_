'use client';

import { useState } from 'react';

/**
 * Вход по паролю. Одна форма на оба уровня: общий пароль на радар и отдельный
 * на «Витрины» с «Историей» — отличается только подпись (см. auth.ts).
 */
export function LoginForm({
  scope,
  next,
  title,
  hint,
}: {
  scope: 'site' | 'manage';
  next: string;
  title: string;
  hint: string;
}) {
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: React.FormEvent) {
    e.preventDefault();
    setBusy(true);
    setError(null);

    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ password, scope }),
      });
      const data = (await res.json()) as { ok: boolean; error?: string };

      if (!data.ok) {
        setError(data.error ?? 'Не удалось войти');
        setBusy(false);
        return;
      }

      // Полная перезагрузка, а не router.replace: если цель требует ещё и
      // второй пароль, клиентский переход возвращает ту же страницу входа,
      // и форма зависает на «Проверяем…». Здесь адрес пересчитывает сервер.
      window.location.replace(next);
    } catch {
      setError('Сервер не ответил. Попробуйте ещё раз.');
      setBusy(false);
    }
  }

  return (
    <form onSubmit={submit} className="surface flex w-full max-w-sm flex-col gap-3 p-5">
      <div>
        <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
        <p className="mt-1 text-sm muted">{hint}</p>
      </div>

      <input
        type="password"
        value={password}
        onChange={(e) => setPassword(e.target.value)}
        placeholder="Пароль"
        aria-label="Пароль"
        autoFocus
        autoComplete="current-password"
        className="w-full rounded-lg border px-3 py-2 text-sm"
        style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
      />

      {error && <p className="text-sm" style={{ color: 'var(--red)' }}>{error}</p>}

      <button
        type="submit"
        disabled={busy || password.length === 0}
        className="rounded-lg px-3 py-2 text-sm font-medium disabled:opacity-50"
        style={{ background: 'var(--accent, #2563eb)', color: '#fff' }}
      >
        {busy ? 'Проверяем…' : 'Войти'}
      </button>
    </form>
  );
}
