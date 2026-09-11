'use client';

import { useEffect } from 'react';

/**
 * Меряет реальную высоту шапки и кладёт её в CSS-переменную --header-h.
 *
 * Радар отдаёт таблице всю оставшуюся высоту окна, а к чему прилипает шапка
 * с датами — считается от той же величины. Раньше высота была вписана
 * константой («7.5rem»), и любое отклонение ломало экран: жёлтая плашка
 * «вкладки открыты без пароля», перенос шапки на две строки на узком ноутбуке,
 * другой размер шрифта в системе — таблица уезжала за нижний край.
 *
 * ResizeObserver — браузерный наблюдатель за размером элемента: сам сообщает,
 * когда шапка стала выше или ниже, без опроса по таймеру.
 */
export function HeaderMetrics({ selector = 'header' }: { selector?: string }) {
  useEffect(() => {
    const header = document.querySelector(selector);
    if (!header) return;

    const write = () => {
      const h = header.getBoundingClientRect().height;
      if (h > 0) document.documentElement.style.setProperty('--header-h', `${Math.round(h)}px`);
    };

    write();
    const observer = new ResizeObserver(write);
    observer.observe(header);
    // Поворот телефона меняет ширину, а с ней и число строк в шапке.
    window.addEventListener('orientationchange', write);

    return () => {
      observer.disconnect();
      window.removeEventListener('orientationchange', write);
    };
  }, [selector]);

  return null;
}
