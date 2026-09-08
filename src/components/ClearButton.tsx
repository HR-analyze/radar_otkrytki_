'use client';

/**
 * Крестик сброса в правом углу поля фильтра.
 *
 * Показывается только когда фильтр что-то фильтрует: у пустого поля сбрасывать
 * нечего, а мёртвая кнопка в каждой ячейке — шум. Родитель обязан быть
 * `position: relative` и держать справа место под кнопку — иначе она ляжет
 * на текст (см. `.has-clear` в globals.css).
 */
export function ClearButton({
  onClick,
  label,
  title = 'Сбросить',
}: {
  onClick: () => void;
  /** Что именно сбрасываем — для скринридера: «Сбросить» ×5 ни о чём не говорит. */
  label: string;
  title?: string;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      title={title}
      aria-label={label}
      className="absolute top-1/2 right-2 -translate-y-1/2 rounded px-0.5 text-sm leading-none muted hover:opacity-60"
    >
      ✕
    </button>
  );
}
