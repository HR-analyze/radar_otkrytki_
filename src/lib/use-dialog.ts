'use client';

import { useEffect, type RefObject } from 'react';

/**
 * Поведение модального окна, которого не хватало окну загрузки выгрузок.
 *
 * Окно объявляло себя `aria-modal="true"`, но вело себя как обычный блок:
 * Tab из последнего поля уходил на ссылки под затемнением, фон продолжал
 * прокручиваться колесом, а после закрытия фокус улетал в начало страницы —
 * человек с клавиатуры терял место и шёл по вкладкам заново.
 *
 * Здесь собрано четыре вещи, которые модальное окно обязано делать:
 *   · держать Tab внутри себя по кругу;
 *   · ставить фокус внутрь при открытии;
 *   · возвращать фокус туда, откуда открыли;
 *   · не давать фону прокручиваться, пока окно открыто.
 *
 * Escape остаётся на стороне вызывающего кода: где-то он закрывает окно, а
 * где-то (незавершённая загрузка) закрывать нельзя.
 */

/** Что вообще может получить фокус. `disabled` и скрытое — не может. */
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',');

export function useDialog(
  open: boolean,
  ref: RefObject<HTMLElement | null>,
  options: { autoFocus?: boolean } = {},
): void {
  const { autoFocus = true } = options;

  useEffect(() => {
    if (!open) return;

    const opener = document.activeElement as HTMLElement | null;

    /**
     * Прокрутка фона.
     *
     * Просто `overflow: hidden` на body сдвигает страницу на ширину полосы
     * прокрутки — окно открывается, и всё под ним прыгает вбок. Компенсируем
     * отступом ровно в ту же ширину.
     */
    const { body } = document;
    const prevOverflow = body.style.overflow;
    const prevPadding = body.style.paddingRight;
    const gap = window.innerWidth - document.documentElement.clientWidth;
    body.style.overflow = 'hidden';
    if (gap > 0) body.style.paddingRight = `${gap}px`;

    // Фокус внутрь: без этого первый Tab уводил на фон, а не в окно.
    if (autoFocus) {
      const first = ref.current?.querySelector<HTMLElement>(FOCUSABLE);
      (first ?? ref.current)?.focus();
    }

    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Tab' || !ref.current) return;

      const items = [...ref.current.querySelectorAll<HTMLElement>(FOCUSABLE)].filter(
        // Скрытый элемент фокус не берёт, но в выборку попадает.
        (el) => el.offsetParent !== null || el === document.activeElement,
      );
      if (items.length === 0) return;

      const first = items[0];
      const last = items[items.length - 1];
      const active = document.activeElement;

      // По кругу: с последнего — на первый, и обратно с Shift.
      if (!e.shiftKey && active === last) {
        e.preventDefault();
        first.focus();
      } else if (e.shiftKey && active === first) {
        e.preventDefault();
        last.focus();
      } else if (!ref.current.contains(active)) {
        // Фокус уже снаружи (например, после клика мимо) — возвращаем.
        e.preventDefault();
        first.focus();
      }
    };

    document.addEventListener('keydown', onKey);

    return () => {
      document.removeEventListener('keydown', onKey);
      body.style.overflow = prevOverflow;
      body.style.paddingRight = prevPadding;
      // Возврат фокуса туда, откуда открыли: иначе он начинается заново
      // с начала страницы, и до места приходится идти по всем вкладкам.
      opener?.focus?.();
    };
  }, [open, ref, autoFocus]);
}
