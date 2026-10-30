import seed from '../../fixtures/shop-directors.json';
import type { ShopDirectorRow } from './parsers/shop-directors';

/**
 * Кто руководит лавкой — директор или ТД, — из таблицы «Лавки» (см.
 * parsers/shop-directors.ts). Собирается в репозиторий только именами:
 * npm run directors:build -- таблица.xlsx.
 *
 * JSON импортируется, а не читается с диска — так же, как нормы выхода:
 * гарантированно доезжает до сборки и весит пару килобайт.
 */

export interface ShopDirectorsSeed {
  source: string;
  builtAt: string;
  shops: ShopDirectorRow[];
}

export const SHOP_DIRECTORS_SEED_PATH = 'fixtures/shop-directors.json';

export function readShopDirectors(): ShopDirectorsSeed {
  return seed as ShopDirectorsSeed;
}
