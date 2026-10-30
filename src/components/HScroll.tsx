'use client';

import { useCallback, useEffect, useRef, useState } from 'react';

/**
 * Блок с горизонтальной прокруткой и кнопками «◀ ▶» над ним.
 *
 * Таблица «лавки × дни» за месяц шире экрана ноутбука, а полоса прокрутки у
 * неё — под последней строкой, за восемьюдесятью лавками: её просто не видно,
 * и правые дни выглядели как обрезанные. Колёсико мыши крутит вниз, а про
 * Shift+колёсико знают не все.
 *
 * Кнопки листают на ширину видимой части, гаснут у края и появляются, только
 * когда содержимое и правда не влезает: над узкой таблицей они были бы шумом.
 * Сам блок фокусируется — стрелки клавиатуры листают его, как любой скролл.
 */
export function HScroll({
  className = '',
  label,
  children,
}: {
  /** Классы прокручиваемого блока: рамка, высота и т. п. */
  className?: string;
  /** Что листаем — для подписи кнопок и программы чтения с экрана. */
  label: string;
  children: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [edge, setEdge] = useState({ left: false, right: false });

  const update = useCallback(() => {
    const el = ref.current;
    if (!el) return;
    // Пиксель запаса: при масштабе страницы scrollLeft бывает дробным.
    setEdge({
      left: el.scrollLeft > 1,
      right: el.scrollLeft + el.clientWidth < el.scrollWidth - 1,
    });
  }, []);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    update();
    el.addEventListener('scroll', update, { passive: true });
    // Ширина меняется не только с окном: таблица дорисовывается, панель
    // фильтров сворачивается — следим за самим блоком и его содержимым.
    const ro = new ResizeObserver(update);
    ro.observe(el);
    if (el.firstElementChild) ro.observe(el.firstElementChild);
    return () => {
      el.removeEventListener('scroll', update);
      ro.disconnect();
    };
  }, [update]);

  const page = (dir: -1 | 1) => {
    const el = ref.current;
    if (!el) return;
    // Не на всю ширину: столбец с названием лавки липнет к краю и закрывает
    // часть кадра — с запасом в пятую часть предыдущие дни остаются в виду.
    el.scrollBy({ left: dir * el.clientWidth * 0.8, behavior: 'smooth' });
  };

  const overflow = edge.left || edge.right;

  return (
    <div className="flex flex-col gap-1.5">
      {overflow && (
        <div className="flex items-center justify-end gap-1.5 text-xs muted">
          <span className="hidden sm:inline">Не всё влезло — листайте:</span>
          <ArrowButton disabled={!edge.left} onClick={() => page(-1)} title={`${label}: назад`}>
            ◀
          </ArrowButton>
          <ArrowButton disabled={!edge.right} onClick={() => page(1)} title={`${label}: дальше`}>
            ▶
          </ArrowButton>
        </div>
      )}
      <div ref={ref} className={className} tabIndex={overflow ? 0 : undefined} aria-label={label} role="region">
        {children}
      </div>
    </div>
  );
}

function ArrowButton({
  disabled,
  onClick,
  title,
  children,
}: {
  disabled: boolean;
  onClick: () => void;
  title: string;
  children: React.ReactNode;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      title={title}
      aria-label={title}
      className="flex h-8 w-10 items-center justify-center rounded-lg border text-sm hover:opacity-80 disabled:opacity-35"
      style={{ borderColor: 'var(--border)', background: 'var(--surface)', color: 'var(--text)' }}
    >
      {children}
    </button>
  );
}
