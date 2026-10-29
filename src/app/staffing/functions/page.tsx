import { cookies } from 'next/headers';
import { canEditStaffing, readPlaceAliasesSafe, readPlaceLog, readStaffingUnnamed } from '@/lib/staffing-edits';
import { STAFFING_COOKIE, isStaffingUnlocked, staffingPassword } from '@/lib/auth';
import {
  collectPlaces,
  defaultPlaceName,
  isReviewedPlace,
  placeAliasMap,
  placeKey,
  placeWindows,
  resolvePlace,
  unusedAliases,
} from '@/lib/staffing-places';
import { formatMoment } from '@/lib/time';
import { StaffingPlaces } from '@/components/StaffingPlaces';
import { StaffingTabs } from '@/components/StaffingTabs';

export const dynamic = 'force-dynamic';

/**
 * Функционалы: все написания мест из расстановки по сети и единое название
 * каждого. Правится здесь — меняется во всех лавках (см. staffing-places.ts).
 */
export default async function StaffingFunctionsPage() {
  const [{ norms }, saved, log] = await Promise.all([readStaffingUnnamed(), readPlaceAliasesSafe(), readPlaceLog()]);
  const editable = Boolean(staffingPassword()) && canEditStaffing();
  const unlocked = editable && (await isStaffingUnlocked((await cookies()).get(STAFFING_COOKIE)?.value));
  const aliases = placeAliasMap(saved);
  const savedKeys = new Set(saved.map((a) => placeKey(a.place)));

  const usages = collectPlaces(norms);
  const rows = usages.map((p) => ({
    ...p,
    name: resolvePlace(p.place, aliases),
    fromSite: savedKeys.has(p.key),
    reviewed: isReviewedPlace(p.key, savedKeys),
    defaultName: defaultPlaceName(p.place),
  }));

  return (
    <div className="flex flex-col gap-5">
      <div className="flex flex-col gap-3">
        <StaffingTabs current="places" />
        <div>
          <h1 className="text-2xl font-semibold tracking-tight">Функционалы</h1>
          <p className="mt-1 text-sm muted">
            Все написания мест из расстановки по сети: одно и то же ТД пишут по-разному («разогрев», «разог», «разлгрев»). Справа
            — единое название. Поправили его — оно меняется во всех лавках, окнах, Excel и PDF; одинаковые места в окне
            складываются. В правке лавки функционал выбирают из этого списка — вписать свой там нельзя.
          </p>
        </div>
      </div>
      <StaffingPlaces
        rows={rows}
        shopCount={norms.length}
        editable={editable}
        unlocked={unlocked}
        saved={saved.map((a) => ({ place: placeKey(a.place), name: a.name }))}
        windows={placeWindows(norms)}
        unused={unusedAliases(saved, usages)}
        log={log.map((e) => ({ ...e, when: formatMoment(e.at) }))}
      />
    </div>
  );
}
