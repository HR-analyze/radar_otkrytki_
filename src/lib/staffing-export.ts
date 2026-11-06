import { findStaffNorm, type StaffNorm } from './staffing';
import type { StaffingSeed } from './staffing-store';

/**
 * Что выгружать из «Графика пиков» в Excel и PDF — то же, что в таблице на
 * вкладке: без `shop` вся сеть (или лавки выбранного РМ), с `shop` одна лавка. Лавку ищем тем же
 * findStaffNorm, что и страница, иначе ссылка «Скачать» однажды выгрузила бы
 * не то, что на экране.
 */
export interface StaffingSelection {
  /** Выбранная лавка; null — вся сеть или все лавки РМ. */
  shop: StaffNorm | null;
  /** Выбранный РМ; null — без фильтра по РМ. */
  region: string | null;
  /** Лавки в выгрузке, в порядке шаблона. */
  shown: StaffNorm[];
}

/**
 * `region` — фильтр по РМ: `name` и коды его лавок из справочника. Лавка
 * важнее РМ, как и на вкладке: выбрали лавку — выгружается она одна.
 */
export function selectStaffing(
  seed: Pick<StaffingSeed, 'norms'>,
  shopQuery: string | null | undefined,
  region?: { name: string; codes: ReadonlySet<string> } | null,
): StaffingSelection | { error: string } {
  if (seed.norms.length === 0) return { error: 'Шаблон норм выхода ещё не загружен — выгружать нечего.' };
  const query = String(shopQuery ?? '').trim();
  if (query) {
    const shop = findStaffNorm(seed.norms, query);
    return shop ? { shop, region: null, shown: [shop] } : { error: `Лавки «${query}» в шаблоне нет.` };
  }
  if (!region) return { shop: null, region: null, shown: seed.norms };
  const shown = seed.norms.filter((n) => region.codes.has(n.code));
  return shown.length > 0
    ? { shop: null, region: region.name, shown }
    : { error: `У РМ «${region.name}» нет лавок в шаблоне.` };
}

/**
 * Имя файла латиницей, как у остальных выгрузок радара: такие файлы потом
 * лежат в почте и мессенджерах, где кириллица в имени ломается.
 * «grafik-pikov-2026-10-28.pdf», с лавкой — «grafik-pikov-M50-2026-10-28.pdf».
 */
export function staffingFilename(
  ext: 'xlsx' | 'pdf',
  shop: StaffNorm | null,
  date: string,
  region: string | null = null,
): string {
  const scope = shop ? latin(shop.code) : region ? region.trim().split(/\s+/).map(latin).filter(Boolean).join('-') || null : null;
  return ['grafik-pikov', scope, date].filter(Boolean).join('-') + `.${ext}`;
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
