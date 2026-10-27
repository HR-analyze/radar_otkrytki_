'use client';

import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';

/**
 * Подсказка, которая работает и пальцем.
 *
 * Всё пояснительное на радаре держалось на атрибуте `title`: «в среднем за
 * день», «зоны балла», «сумма баллов ÷ оценённые дни». На телефоне и планшете
 * `title` не показывается вообще — половина объяснений к цифрам была доступна
 * только тем, кто сидит с мышью. А объяснения тут не украшение: без них
 * непонятно, почему у лавки 2,33 и почему это жёлтый.
 *
 * Открывается наведением, нажатием и фокусом с клавиатуры; закрывается
 * Escape, уходом курсора и нажатием мимо.
 */
export function Hint({
  text,
  children,
  className = '',
  below = false,
}: {
  text: string;
  /** К чему подсказка. Не передано — рисуем значок «?». */
  children?: React.ReactNode;
  className?: string;
  /**
   * Открыть вниз и влево от правого края — для шапки таблицы, прилипшей к
   * верху рамки: вверх подсказка легла бы на соседние колонки шапки. Места
   * нет — откроется в другую сторону.
   */
  below?: boolean;
}) {
  /**
   * Два независимых повода показать подсказку, а не один переключатель.
   *
   * С одним получалось так: браузер перед нажатием шлёт наведение — подсказка
   * открывалась, — и следом нажатие переключало её обратно в закрытое. На
   * телефоне наведение эмулируется точно так же, поэтому подсказка не
   * открывалась вообще там, ради чего её и делали.
   *
   * Теперь наведение показывает, пока курсор рядом, а нажатие закрепляет —
   * убрать курсор и прочитать текст становится можно.
   */
  const [hovered, setHovered] = useState(false);
  const [pinned, setPinned] = useState(false);
  const open = hovered || pinned;
  const rootRef = useRef<HTMLSpanElement>(null);
  const tipRef = useRef<HTMLSpanElement>(null);
  /** Где рисовать подсказку, px от края окна; null — ещё не померили. */
  const [pos, setPos] = useState<{ top: number; left: number } | null>(null);
  const id = useId();

  /**
   * Подсказка висит position: fixed, а не absolute от значка.
   *
   * С absolute её обрезала рамка со скроллом: в шапке таблицы с одной лавкой
   * рамка ниже подсказки, и вместо текста появлялись полосы прокрутки. Fixed
   * рамка не обрезает, зато место считаем сами: от значка, с прижатием к краям
   * окна и разворотом вверх-вниз, если не влезает. Считаем до отрисовки
   * (useLayoutEffect) и заново на каждый скролл — подсказка едет за значком.
   */
  useLayoutEffect(() => {
    if (!open) return;
    const place = () => {
      const anchor = rootRef.current?.getBoundingClientRect();
      const tip = tipRef.current?.getBoundingClientRect();
      if (!anchor || !tip) return;
      const gap = 6;
      const edge = 8;
      const fitsAbove = anchor.top - gap - tip.height >= edge;
      const fitsBelow = anchor.bottom + gap + tip.height <= window.innerHeight - edge;
      const down = below ? fitsBelow || !fitsAbove : !fitsAbove && fitsBelow;
      const left = below ? anchor.right - tip.width : anchor.left;
      setPos({
        top: down ? anchor.bottom + gap : anchor.top - gap - tip.height,
        left: Math.max(edge, Math.min(left, document.documentElement.clientWidth - edge - tip.width)),
      });
    };
    place();
    window.addEventListener('scroll', place, true);
    window.addEventListener('resize', place);
    return () => {
      window.removeEventListener('scroll', place, true);
      window.removeEventListener('resize', place);
      // Следующий раз мерить с нуля: у края окна fixed-блок сжимается, и
      // ширина, снятая на старом месте, была бы не та.
      setPos(null);
    };
  }, [open, below]);

  useEffect(() => {
    if (!open) return;

    const hide = () => {
      setPinned(false);
      setHovered(false);
    };
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') hide();
    };
    const onDown = (e: MouseEvent | TouchEvent) => {
      // Нажали мимо — гасим оба повода: на телефоне «увести курсор» нечем,
      // и без этого подсказка осталась бы висеть навсегда.
      if (!rootRef.current?.contains(e.target as Node)) hide();
    };

    document.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    document.addEventListener('touchstart', onDown);
    return () => {
      document.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
      document.removeEventListener('touchstart', onDown);
    };
  }, [open]);

  return (
    <span
      ref={rootRef}
      className={`relative inline-flex items-center ${className}`}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
    >
      <button
        type="button"
        onClick={() => setPinned((v) => !v)}
        onFocus={() => setHovered(true)}
        onBlur={() => setHovered(false)}
        aria-describedby={open ? id : undefined}
        aria-label={children ? undefined : 'Пояснение'}
        aria-expanded={open}
        className={
          children
            ? 'cursor-help text-left underline decoration-dotted underline-offset-2'
            : /* relative нужен для расширенной области нажатия (.tap): она
                 рисуется псевдоэлементом и считается от самого значка. */
              'tap relative flex size-4 shrink-0 cursor-help items-center justify-center rounded-full border text-[10px] leading-none muted'
        }
        style={children ? undefined : { borderColor: 'var(--border)' }}
      >
        {children ?? '?'}
      </button>

      {open && (
        <span
          id={id}
          role="tooltip"
          ref={tipRef}
          /* Ширина по тексту без переносов (w-max), но не шире 16rem: длинное
             пояснение переносится в две-три строки, а не тянется в нитку или
             во весь экран, а короткое («Итого по штату») не сидит в пустой
             плашке на 16rem. whitespace-normal — нарочно: в шапке таблицы
             ячейка с nowrap, и без него текст уходил в одну строку далеко за
             плашку, прямо поверх цифр. */
          className="surface fixed top-0 left-0 z-50 w-max max-w-[min(16rem,calc(100vw-2rem))] p-2 text-left text-xs font-normal whitespace-normal shadow-lg"
          style={{
            color: 'var(--text)',
            ...(pos ? { top: pos.top, left: pos.left } : { visibility: 'hidden' }),
          }}
        >
          {text}
        </span>
      )}
    </span>
  );
}
