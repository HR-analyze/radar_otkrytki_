import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { yellowStep, normsEnabled } from '@/lib/norms';
import { parseCookShifts, parseNormTime } from '@/lib/parsers/shop-norms';
import { listShops } from '@/lib/queries';
import { invalidateSnapshot } from '@/lib/snapshot';
import {
  canEditNorms,
  normsEditHint,
  readNorms,
  resetNorms,
  saveNormsEdits,
  type ShopNormsEdit,
} from '@/lib/shop-norms-store';
import { checkUploadToken } from '@/lib/upload-store';
import type { CookShift } from '@/lib/types';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Нормативы открытия лавок: что показать в редакторе на вкладке «Пороги» и
 * что он присылает назад.
 *
 * Правки ложатся в базу ручных данных поверх справочника (см.
 * shop-norms-store.ts). На статусы они влияют со следующей пересборки снимка —
 * в отличие от витрин, которые подмешиваются при чтении: статусы отметок
 * считаются один раз при сборке, и пересчитать их «на лету» нельзя.
 */
export async function GET() {
  const config = loadConfig();
  const store = await readNorms();

  // Лавки радара — те, что есть в выгрузках. Справочник шире: в нём попадаются
  // лавки, которых в отметках ещё нет. Показываем и те, и другие, но лавку
  // радара — с именем из выгрузки: оно свежее справочника.
  const shops = await listShops();
  const names = new Map(shops.map((s) => [s.code, s.name]));

  const codes = [...new Set([...shops.map((s) => s.code), ...Object.keys(store.byCode)])];

  return NextResponse.json({
    ok: true,
    enabled: normsEnabled(config),
    yellowStepMinutes: yellowStep(config),
    confirmed: config.rules.shopNorms?.confirmed ?? false,
    note: config.rules.shopNorms?.note ?? '',
    editable: canEditNorms(),
    hint: normsEditHint(),
    tokenRequired: Boolean(process.env.RADAR_UPLOAD_TOKEN),
    updatedAt: store.updatedAt,
    shops: codes
      .map((code) => {
        const n = store.byCode[code];
        return {
          code,
          name: names.get(code) ?? n?.name ?? code,
          /** Есть ли лавка в выгрузках — у «бумажной» нормы некому опаздывать. */
          inRadar: names.has(code),
          driverAt: n?.driverAt ?? null,
          cookShifts: n?.cookShifts ?? [],
          rawDriver: n?.rawDriver ?? null,
          rawCook: n?.rawCook ?? null,
          source: n?.source ?? 'reference',
          warnings: n?.warnings ?? [],
        };
      })
      .sort((a, b) => a.code.localeCompare(b.code, 'ru', { numeric: true })),
  });
}

export async function POST(req: Request) {
  if (!canEditNorms()) {
    // 503, а не 500: не сбой, а невозможность записи на этом хостинге.
    return NextResponse.json({ ok: false, error: normsEditHint() }, { status: 503 });
  }

  const token = checkUploadToken(req);
  if (!token.ok) return NextResponse.json({ ok: false, error: token.reason }, { status: 401 });

  let body: { edits?: unknown; reset?: unknown };
  try {
    body = (await req.json()) as { edits?: unknown; reset?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  // Сброс возвращает лавку к справочнику — это не правка, а её отмена.
  if (typeof body.reset === 'string') {
    const code = body.reset.trim();
    if (!SHOP_CODE.test(code)) {
      return NextResponse.json({ ok: false, error: `Некорректный код лавки «${code}»` }, { status: 400 });
    }
    await resetNorms(code);
    invalidateSnapshot();
    return NextResponse.json({ ok: true, changed: 1, ...(await readNorms()).byCode[code] });
  }

  const edits = parseEdits(body.edits);
  if (!edits.ok) return NextResponse.json({ ok: false, error: edits.error }, { status: 400 });

  let changed: number;
  try {
    ({ changed } = await saveNormsEdits(edits.value));
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Не удалось сохранить' },
      { status: 503 },
    );
  }
  invalidateSnapshot();

  const store = await readNorms();
  return NextResponse.json({
    ok: true,
    changed,
    updatedAt: store.updatedAt,
    saved: edits.value.map((e) => ({
      code: e.shopCode,
      driverAt: e.driverAt,
      cookShifts: store.byCode[e.shopCode]?.cookShifts ?? [],
      source: 'manual' as const,
    })),
  });
}

const SHOP_CODE = /^[А-ЯA-Z]{1,3}\d{1,4}$/i;
/** Больше смен в одной лавке не бывает: в справочнике максимум две. */
const MAX_SHIFTS = 6;

type ParsedEdits = { ok: true; value: ShopNormsEdit[] } | { ok: false; error: string };

/** Ввод недоверенный: правки приходят из браузера, а ложатся в базу. */
function parseEdits(raw: unknown): ParsedEdits {
  if (!Array.isArray(raw) || raw.length === 0) return { ok: false, error: 'Пустой список правок' };
  if (raw.length > 500) return { ok: false, error: 'Слишком много правок за раз' };

  const value: ShopNormsEdit[] = [];
  for (const item of raw) {
    const e = item as { shopCode?: unknown; driverAt?: unknown; cook?: unknown };
    const shopCode = String(e.shopCode ?? '').trim();
    if (!SHOP_CODE.test(shopCode)) {
      return { ok: false, error: `Некорректный код лавки «${shopCode}»` };
    }

    // Пустая строка — осознанное «нормы нет», а не пропуск поля.
    const rawDriver = e.driverAt == null ? '' : String(e.driverAt).trim();
    const driverAt = rawDriver === '' ? null : parseNormTime(rawDriver);
    if (rawDriver !== '' && !driverAt) {
      return { ok: false, error: `${shopCode}: не разобрал время «${rawDriver}» — нужно 6:30 или 06:30` };
    }

    // Смены принимаются той же строкой, что и в справочнике («1 с 6:00/2 с 6:30»):
    // так человек переносит норму как есть, не раскладывая её по полям.
    const rawCook = e.cook == null ? '' : String(e.cook).trim();
    const cookShifts: CookShift[] = rawCook === '' ? [] : parseCookShifts(rawCook);
    if (rawCook !== '' && cookShifts.length === 0) {
      return {
        ok: false,
        error: `${shopCode}: не разобрал смены поваров «${rawCook}» — нужно «3 с 6:20» или «1 с 6:00/2 с 6:30»`,
      };
    }
    if (cookShifts.length > MAX_SHIFTS) {
      return { ok: false, error: `${shopCode}: слишком много смен (${cookShifts.length})` };
    }
    if (cookShifts.some((s) => s.count > 50)) {
      return { ok: false, error: `${shopCode}: столько поваров в смене не бывает` };
    }

    value.push({ shopCode, driverAt, cookShifts });
  }

  return { ok: true, value };
}
