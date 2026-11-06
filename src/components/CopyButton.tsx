'use client';

import { useState } from 'react';

/** Копирует готовый текст в буфер: отчёт уходит в чат команды без перепечатки. */
export function CopyButton({ text, label }: { text: string; label: string }) {
  const [state, setState] = useState<'idle' | 'done' | 'error'>('idle');

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(text);
      setState('done');
    } catch {
      // Буфер недоступен (http без TLS, запрет браузера) — говорим честно.
      setState('error');
    }
    setTimeout(() => setState('idle'), 2500);
  };

  return (
    <button
      type="button"
      onClick={() => void copy()}
      className="rounded-lg border px-3 py-2 text-sm font-medium whitespace-nowrap hover:opacity-90"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)' }}
    >
      {state === 'done' ? 'Скопировано ✓' : state === 'error' ? 'Не удалось скопировать' : label}
    </button>
  );
}
