'use client';

/**
 * Последний рубеж: упала сама разметка страницы (layout), и обычный error.tsx
 * отрисовать уже негде — этот экран заменяет собой весь документ, поэтому
 * тянет <html> и <body> сам и не может опереться ни на один общий стиль.
 */
export default function GlobalError({
  error,
  reset,
}: {
  error: Error & { digest?: string };
  reset: () => void;
}) {
  return (
    <html lang="ru">
      <body
        style={{
          margin: 0,
          minHeight: '100vh',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          background: '#f6f7f9',
          color: '#0f172a',
          fontFamily: 'ui-sans-serif, system-ui, -apple-system, "Segoe UI", Roboto, sans-serif',
        }}
      >
        <div style={{ maxWidth: '32rem', padding: '1.5rem' }}>
          <h1 style={{ fontSize: '1.25rem', margin: 0 }}>Радар не запустился</h1>
          <p style={{ fontSize: '0.875rem', color: '#556070', marginTop: '0.5rem' }}>
            Сломалось до того, как страница успела собраться. Обновите вкладку; если повторяется —
            смотрите логи сервера.
          </p>
          <pre
            style={{
              fontSize: '0.75rem',
              background: '#f1f5f9',
              padding: '0.75rem',
              borderRadius: '0.5rem',
              overflowX: 'auto',
            }}
          >
            {error.message}
            {error.digest ? `\n\nКод: ${error.digest}` : ''}
          </pre>
          <button
            type="button"
            onClick={reset}
            style={{
              marginTop: '0.5rem',
              padding: '0.5rem 0.75rem',
              fontSize: '0.875rem',
              borderRadius: '0.5rem',
              border: '1px solid #e2e8f0',
              background: '#fff',
              cursor: 'pointer',
            }}
          >
            Попробовать снова
          </button>
        </div>
      </body>
    </html>
  );
}
