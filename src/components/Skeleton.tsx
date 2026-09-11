/**
 * Заглушки на время сборки страницы.
 *
 * Все страницы радара помечены `dynamic = 'force-dynamic'`: каждая собирается
 * на сервере заново, а сводка успевает сделать десяток запросов к данным. Пока
 * это происходит, браузер держит на экране предыдущую страницу — без единого
 * признака работы. Сайт от этого выглядит зависшим, хотя он считает.
 *
 * Заглушка повторяет будущую раскладку, а не показывает крутилку по центру:
 * так глаз заранее знает, где появятся плитки, а где таблица, и не
 * перестраивается заново, когда данные приедут.
 */

export function Line({ w = '100%', h = '0.75rem' }: { w?: string; h?: string }) {
  return <span className="skeleton block" style={{ width: w, height: h }} />;
}

/** Заголовок страницы с подзаголовком — он есть на каждой вкладке. */
export function HeadingSkeleton() {
  return (
    <div className="flex flex-col gap-2">
      <Line w="14rem" h="1.6rem" />
      <Line w="22rem" h="0.85rem" />
    </div>
  );
}

/** Панель фильтров: пять полей в ряд, как в Filters. */
export function FiltersSkeleton({ fields = 5 }: { fields?: number }) {
  return (
    <div className="surface p-3">
      <div className="grid gap-3 sm:grid-cols-2 lg:grid-cols-5">
        {Array.from({ length: fields }, (_, i) => (
          <div key={i} className="flex flex-col gap-1.5">
            <Line w="3.5rem" h="0.7rem" />
            <Line h="2.4rem" />
          </div>
        ))}
      </div>
    </div>
  );
}

/** Ряд плиток со счётчиками. */
export function TilesSkeleton({ count = 4 }: { count?: number }) {
  return (
    <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
      {Array.from({ length: count }, (_, i) => (
        <div key={i} className="surface flex flex-col gap-2 p-4">
          <Line w="7rem" h="0.7rem" />
          <Line w="4rem" h="1.7rem" />
          <Line h="0.5rem" />
        </div>
      ))}
    </div>
  );
}

/** Карточка с заголовком и несколькими строками. */
export function CardSkeleton({ rows = 4 }: { rows?: number }) {
  return (
    <div className="surface flex flex-col gap-3 p-4">
      <Line w="12rem" h="0.9rem" />
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="flex items-center justify-between gap-4">
          <Line w={`${8 + ((i * 3) % 7)}rem`} />
          <Line w="3rem" />
        </div>
      ))}
    </div>
  );
}

/**
 * Таблица-радар: закреплённая колонка слева и клетки статусов.
 * Ширину строк не рандомим — на перерисовке она бы прыгала.
 */
export function TableSkeleton({ rows = 12, cols = 14 }: { rows?: number; cols?: number }) {
  return (
    <div className="surface overflow-hidden p-3">
      <div className="flex flex-col gap-2">
        {Array.from({ length: rows }, (_, r) => (
          <div key={r} className="flex items-center gap-1.5">
            <span className="shrink-0" style={{ width: '9rem' }}>
              <Line w="85%" />
            </span>
            {Array.from({ length: cols }, (_, c) => (
              <span key={c} className="skeleton hidden h-6 flex-1 sm:block" />
            ))}
            <span className="skeleton h-6 flex-1 sm:hidden" />
          </div>
        ))}
      </div>
    </div>
  );
}
