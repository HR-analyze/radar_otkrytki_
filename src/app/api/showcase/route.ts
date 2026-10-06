import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { listDates, listShops } from '@/lib/queries';
import { resolveShowcaseRange } from '@/lib/showcase-range';
import { invalidateSnapshot } from '@/lib/snapshot';
import { closureOf, isOpenOn, scheduleFor, statusForFill } from '@/lib/status';
import { dateRange } from '@/lib/time';
import { checkUploadToken } from '@/lib/upload-store';
import {
  canEditShowcase,
  readShowcase,
  saveShowcaseEdits,
  showcaseEditHint,
  type ShowcaseEdit,
} from '@/lib/showcase-store';
import { dayFill } from '@/lib/day-fill';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Наполнение витрин: что показать в редакторе и что он присылает назад.
 *
 * Правки сохраняются пачкой в базу ручных данных и видны на дашборде сразу —
 * снимок читает витрины оттуда же (см. showcase-store.ts), пересобирать
 * ничего не нужно.
 */

/** Код лавки: тот же формат, что принимают правки. */
const SHOP_CODE = /^[А-ЯA-Z]{1,3}\d{1,4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * Два разреза одних и тех же данных:
 *
 *  · `?date=2026-09-21` — день: список лавок. Так заполняют за сегодня.
 *  · `?shop=М12&from=…&to=…` — лавка: список дней. Так дозаполняют пропуски,
 *    не переключая дату после каждой цифры (см. showcase-range.ts).
 *
 * Правки в обоих случаях уходят одним и тем же POST: у каждой правки своя
 * дата, и серверу всё равно, из какого разреза она пришла.
 *
 * Замеров в день два: `percent` — утренний, `afternoonPercent` — в 16:00.
 * `status` — статус итога дня, среднего двух замеров (см. dayFill).
 */
export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const shop = params.get('shop');
  if (shop) return shopSlice(shop, params.get('from') ?? '', params.get('to') ?? '');

  const date = params.get('date') ?? '';
  if (!ISO_DATE.test(date)) {
    return NextResponse.json({ ok: false, error: 'Нужна дата в виде 2026-08-31' }, { status: 400 });
  }

  const config = loadConfig();
  const store = await readShowcase();
  const values = store.days[date] ?? {};
  const afternoon = store.afternoon[date] ?? {};
  const notes = store.notes[date] ?? {};
  // Лавки на этот день: закрытая в список заполнения не попадает, но её
  // прошлые дни открываются как прежде (см. shopClosures).
  const shops = await listShops(date);

  return NextResponse.json({
    ok: true,
    mode: 'day',
    date,
    editable: canEditShowcase(),
    hint: showcaseEditHint(),
    tokenRequired: Boolean(process.env.RADAR_UPLOAD_TOKEN),
    updatedAt: store.touched[date] ?? null,
    thresholds: {
      green: config.criteria.showcase.kind === 'percent' ? config.criteria.showcase.greenFrom : 0,
      yellow: config.criteria.showcase.kind === 'percent' ? config.criteria.showcase.yellowFrom : 0,
    },
    /** Дни, за которые вообще есть данные — для быстрых переходов в редакторе. */
    knownDates: await listDates(),
    filledByDate: Object.fromEntries(
      Object.entries(store.days).map(([d, v]) => [d, Object.keys(v).length]),
    ),
    afternoonFilledByDate: Object.fromEntries(
      Object.entries(store.afternoon).map(([d, v]) => [d, Object.keys(v).length]),
    ),
    shops: shops.map((s) => ({
      code: s.code,
      name: s.name,
      region: s.region,
      // Особый график лавки (М71, М72 — с 10:00). Наполнение витрины от часа
      // открытия не зависит, но человек, который проходит день по списку,
      // должен видеть, что лавка в 08:00 ещё закрыта, и не искать у неё нули.
      opensAt: scheduleFor(config, s.code)?.opensAt ?? null,
      percent: toPercent(values[s.code]),
      afternoonPercent: toPercent(afternoon[s.code]),
      status: statusForFill(dayFill(values[s.code] ?? null, afternoon[s.code] ?? null), config),
      note: notes[s.code] ?? '',
    })),
  });
}

/**
 * Одна лавка за окно дней.
 *
 * Дни, когда лавка была закрыта, в список не попадают — как не попадает
 * закрытая лавка в дневной список. Но прошлые дни той же лавки открываются
 * как прежде: закрытие отрезает будущее, а не историю (см. isOpenOn).
 */
async function shopSlice(rawShop: string, rawFrom: string, rawTo: string): Promise<Response> {
  const shopCode = rawShop.trim();
  // `*` — «первая лавка справочника»: редактор открывается на чём-то, а не на
  // пустом экране с просьбой выбрать. Какая это лавка, он узнаёт из ответа.
  const first = shopCode === '*';
  if (!first && !SHOP_CODE.test(shopCode)) {
    return NextResponse.json({ ok: false, error: `Некорректный код лавки «${shopCode}»` }, { status: 400 });
  }
  if (!ISO_DATE.test(rawFrom) || !ISO_DATE.test(rawTo)) {
    return NextResponse.json({ ok: false, error: 'Нужны обе границы в виде 2026-08-31' }, { status: 400 });
  }

  const { from, to } = resolveShowcaseRange(rawFrom, rawTo);
  const config = loadConfig();
  const store = await readShowcase();

  // Справочник целиком, без привязки к дню: закрытую лавку в выпадающем списке
  // всё равно нужно уметь выбрать — её прошлые дни никуда не делись.
  const shops = await listShops();
  const shop = first ? shops[0] : shops.find((s) => s.code.toUpperCase() === shopCode.toUpperCase());
  if (!shop) {
    return NextResponse.json(
      { ok: false, error: first ? 'Справочник лавок пуст' : `Лавка «${shopCode}» не найдена` },
      { status: 404 },
    );
  }

  const days = dateRange(from, to)
    .filter((date) => isOpenOn(config, shop.code, date))
    .map((date) => {
      const fill = store.days[date]?.[shop.code] ?? null;
      const afternoon = store.afternoon[date]?.[shop.code] ?? null;
      return {
        date,
        percent: toPercent(fill),
        afternoonPercent: toPercent(afternoon),
        status: statusForFill(dayFill(fill, afternoon), config),
        note: store.notes[date]?.[shop.code] ?? '',
        updatedAt: store.touched[date] ?? null,
      };
    })
    // Свежий день сверху: дозаполняют обычно вчерашнее, а не начало месяца.
    .reverse();

  return NextResponse.json({
    ok: true,
    mode: 'shop',
    from,
    to,
    editable: canEditShowcase(),
    hint: showcaseEditHint(),
    tokenRequired: Boolean(process.env.RADAR_UPLOAD_TOKEN),
    thresholds: {
      green: config.criteria.showcase.kind === 'percent' ? config.criteria.showcase.greenFrom : 0,
      yellow: config.criteria.showcase.kind === 'percent' ? config.criteria.showcase.yellowFrom : 0,
    },
    shop: {
      code: shop.code,
      name: shop.name,
      region: shop.region,
      opensAt: scheduleFor(config, shop.code)?.opensAt ?? null,
      closedFrom: closureOf(config, shop.code)?.closedFrom ?? null,
    },
    /** Справочник для переключателя «предыдущая/следующая лавка». */
    shops: shops.map((s) => ({ code: s.code, name: s.name, region: s.region })),
    days,
  });
}

export async function POST(req: Request) {
  if (!canEditShowcase()) {
    // 503, а не 500: не сбой, а невозможность записи на этом хостинге.
    return NextResponse.json({ ok: false, error: showcaseEditHint() }, { status: 503 });
  }

  const token = checkUploadToken(req);
  if (!token.ok) return NextResponse.json({ ok: false, error: token.reason }, { status: 401 });

  let body: { edits?: unknown };
  try {
    body = (await req.json()) as { edits?: unknown };
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  const edits = parseEdits(body.edits);
  if (!edits.ok) return NextResponse.json({ ok: false, error: edits.error }, { status: 400 });

  let changed: number;
  try {
    ({ changed } = await saveShowcaseEdits(edits.value, { source: 'ui' }));
  } catch (e) {
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Не удалось сохранить' },
      { status: 503 },
    );
  }
  invalidateSnapshot();

  const config = loadConfig();
  const store = await readShowcase();
  return NextResponse.json({
    ok: true,
    changed,
    updatedAt: store.updatedAt,
    /** Статусы после сохранения — редактор красит ячейки по ответу сервера. */
    saved: edits.value.map((e) => {
      // Значения берём из базы после записи, а не из правки: правка могла
      // трогать только один замер или только комментарий, а статус итога
      // зависит от обоих замеров.
      const fill = store.days[e.date]?.[e.shopCode] ?? null;
      const afternoon = store.afternoon[e.date]?.[e.shopCode] ?? null;
      return {
        date: e.date,
        shopCode: e.shopCode,
        percent: toPercent(fill),
        afternoonPercent: toPercent(afternoon),
        status: statusForFill(dayFill(fill, afternoon), config),
        note: store.notes[e.date]?.[e.shopCode] ?? '',
      };
    }),
    filled: Object.keys(store.days[edits.value[0]?.date ?? ''] ?? {}).length,
  });
}

function toPercent(fill: number | null | undefined): number | null {
  return fill == null ? null : Math.round(fill * 100);
}

/** Процент из браузера: null/'' — стереть, число 0–100 — доля, иначе ошибка. */
function parsePercent(raw: unknown): number | null | string {
  if (raw == null || raw === '') return null;
  const percent = Number(String(raw).replace(',', '.'));
  if (!Number.isFinite(percent) || percent < 0 || percent > 100) return 'bad';
  return percent / 100;
}

/** Комментарий — короткая пометка, а не поле для романа. */
const MAX_NOTE = 300;

type ParsedEdits = { ok: true; value: ShowcaseEdit[] } | { ok: false; error: string };

/** Ввод недоверенный: правки приходят из браузера, а ложатся в базу. */
function parseEdits(raw: unknown): ParsedEdits {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Пустой список правок' };
  }
  if (raw.length > 500) {
    return { ok: false, error: 'Слишком много правок за раз' };
  }

  const value: ShowcaseEdit[] = [];
  for (const item of raw) {
    const e = item as {
      date?: unknown;
      shopCode?: unknown;
      percent?: unknown;
      afternoonPercent?: unknown;
      note?: unknown;
    };
    const date = String(e.date ?? '');
    const shopCode = String(e.shopCode ?? '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: `Некорректная дата «${date}»` };
    if (!/^[А-ЯA-Z]{1,3}\d{1,4}$/i.test(shopCode)) {
      return { ok: false, error: `Некорректный код лавки «${shopCode}»` };
    }

    const edit: ShowcaseEdit = { date, shopCode };

    // Ключа нет вовсе — поле не правили. Пустая строка или null — стереть.
    if ('percent' in e) {
      const fill = parsePercent(e.percent);
      if (typeof fill === 'string') {
        return { ok: false, error: `${shopCode}: наполнение должно быть числом от 0 до 100` };
      }
      edit.fill = fill;
    }
    if ('afternoonPercent' in e) {
      const fill = parsePercent(e.afternoonPercent);
      if (typeof fill === 'string') {
        return { ok: false, error: `${shopCode}: наполнение в 16:00 должно быть числом от 0 до 100` };
      }
      edit.afternoonFill = fill;
    }

    if ('note' in e) {
      const note = e.note == null ? '' : String(e.note);
      if (note.length > MAX_NOTE) {
        return { ok: false, error: `${shopCode}: комментарий длиннее ${MAX_NOTE} символов` };
      }
      edit.note = note;
    }

    if (edit.fill === undefined && edit.afternoonFill === undefined && edit.note === undefined) {
      return { ok: false, error: `${shopCode}: в правке нет ни процента, ни комментария` };
    }
    value.push(edit);
  }

  return { ok: true, value };
}
