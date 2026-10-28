import { findStaffNorm, type StaffNorm } from './staffing';
import type { StaffingSeed } from './staffing-store';

/**
 * Что выгружать из «Графика пиков» в Excel и PDF — то же, что в таблице на
 * вкладке: без `shop` вся сеть, с `shop` одна лавка. Лавку ищем тем же
 * findStaffNorm, что и страница, иначе ссылка «Скачать» однажды выгрузила бы
 * не то, что на экране.
 */
export interface StaffingSelection {
  /** Выбранная лавка; null — вся сеть. */
  shop: StaffNorm | null;
  /** Лавки в выгрузке, в порядке шаблона. */
  shown: StaffNorm[];
}

export function selectStaffing(
  seed: Pick<StaffingSeed, 'norms'>,
  shopQuery: string | null | undefined,
): StaffingSelection | { error: string } {
  if (seed.norms.length === 0) return { error: 'Шаблон норм выхода ещё не загружен — выгружать нечего.' };
  const query = String(shopQuery ?? '').trim();
  if (!query) return { shop: null, shown: seed.norms };
  const shop = findStaffNorm(seed.norms, query);
  return shop ? { shop, shown: [shop] } : { error: `Лавки «${query}» в шаблоне нет.` };
}

/**
 * Имя файла латиницей, как у остальных выгрузок радара: такие файлы потом
 * лежат в почте и мессенджерах, где кириллица в имени ломается.
 * «grafik-pikov-2026-10-28.pdf», с лавкой — «grafik-pikov-M50-2026-10-28.pdf».
 */
export function staffingFilename(ext: 'xlsx' | 'pdf', shop: StaffNorm | null, date: string): string {
  return ['grafik-pikov', shop ? latin(shop.code) : null, date].filter(Boolean).join('-') + `.${ext}`;
}

const LATIN: Record<string, string> = {
  а: 'a', б: 'b', в: 'v', г: 'g', д: 'd', е: 'e', ё: 'e', ж: 'zh', з: 'z', и: 'i', й: 'y', к: 'k',
  л: 'l', м: 'm', н: 'n', о: 'o', п: 'p', р: 'r', с: 's', т: 't', у: 'u', ф: 'f', х: 'h', ц: 'ts',
  ч: 'ch', ш: 'sh', щ: 'sch', ъ: '', ы: 'y', ь: '', э: 'e', ю: 'yu', я: 'ya',
};

/** «М50» → «M50». Всё, что не буква и не цифра, выкидываем. */
function latin(text: string): string {
  return [...text]
    .map((ch) => {
      const low = ch.toLowerCase();
      const out = LATIN[low];
      if (out == null) return /[a-z0-9]/i.test(ch) ? ch : '';
      return ch === low ? out : out.toUpperCase();
    })
    .join('');
}
