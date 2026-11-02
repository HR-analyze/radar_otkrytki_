import { listShops } from './queries';
import { normalizeCode } from './shops';
import { todayIso } from './time';

/**
 * РМ лавок для фильтра на «Графике пиков»: код лавки → РМ по действующему
 * справочнику. В шаблоне норм РМ нет, поэтому берём его из справочника
 * лавок радара, коды сводим normalizeCode («М09» → «М9»).
 *
 * Не валим страницу, если снимка нет: без справочника фильтр просто пустой.
 */
export async function staffingRegionMap(): Promise<Record<string, string>> {
  try {
    const shops = await listShops(todayIso());
    const out: Record<string, string> = {};
    for (const s of shops) if (s.region) out[normalizeCode(s.code)] = s.region;
    return out;
  } catch {
    return {};
  }
}

/** Фильтр выгрузки по `?region=`: имя РМ и коды его лавок; null — без фильтра. */
export async function staffingRegionFilter(
  name: string | null | undefined,
): Promise<{ name: string; codes: Set<string> } | null> {
  const region = String(name ?? '').trim();
  if (!region) return null;
  const map = await staffingRegionMap();
  return { name: region, codes: new Set(Object.keys(map).filter((code) => map[code] === region)) };
}
