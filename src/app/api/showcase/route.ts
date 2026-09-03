import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { listDates, listShops } from '@/lib/queries';
import { invalidateSnapshot } from '@/lib/snapshot';
import { statusForFill } from '@/lib/status';
import { checkUploadToken } from '@/lib/upload-store';
import {
  applyEdits,
  readShowcaseStore,
  writeShowcaseStore,
  type ShowcaseEdit,
} from '@/lib/showcase-store';
import { canEditShowcase, showcaseEditHint } from '@/lib/showcase-access';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Наполнение витрин за день: что показать в редакторе и что он присылает назад.
 *
 * Правки сохраняются пачкой и видны на дашборде сразу — снимок читает витрины
 * из того же файла (см. showcase-store.ts), пересобирать ничего не нужно.
 */
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, error: 'Нужна дата в виде 2026-08-31' }, { status: 400 });
  }

  const config = loadConfig();
  const store = readShowcaseStore();
  const values = store.days[date] ?? {};
  const shops = await listShops();

  return NextResponse.json({
    ok: true,
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
    shops: shops.map((s) => ({
      code: s.code,
      name: s.name,
      region: s.region,
      percent: values[s.code] == null ? null : Math.round(values[s.code] * 100),
      status: statusForFill(values[s.code] ?? null, config),
    })),
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

  const { store, changed } = applyEdits(readShowcaseStore(), edits.value);
  writeShowcaseStore(store);
  invalidateSnapshot();

  const config = loadConfig();
  return NextResponse.json({
    ok: true,
    changed,
    updatedAt: store.updatedAt,
    /** Статусы после сохранения — редактор красит ячейки по ответу сервера. */
    saved: edits.value.map((e) => ({
      date: e.date,
      shopCode: e.shopCode,
      percent: e.fill == null ? null : Math.round(e.fill * 100),
      status: statusForFill(e.fill, config),
    })),
    filled: Object.keys(store.days[edits.value[0]?.date ?? ''] ?? {}).length,
  });
}

type ParsedEdits = { ok: true; value: ShowcaseEdit[] } | { ok: false; error: string };

/** Ввод недоверенный: правки приходят из браузера, а ложатся в файл данных. */
function parseEdits(raw: unknown): ParsedEdits {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, error: 'Пустой список правок' };
  }
  if (raw.length > 500) {
    return { ok: false, error: 'Слишком много правок за раз' };
  }

  const value: ShowcaseEdit[] = [];
  for (const item of raw) {
    const e = item as { date?: unknown; shopCode?: unknown; percent?: unknown };
    const date = String(e.date ?? '');
    const shopCode = String(e.shopCode ?? '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: `Некорректная дата «${date}»` };
    if (!/^[А-ЯA-Z]{1,3}\d{1,4}$/i.test(shopCode)) {
      return { ok: false, error: `Некорректный код лавки «${shopCode}»` };
    }

    if (e.percent == null || e.percent === '') {
      value.push({ date, shopCode, fill: null });
      continue;
    }

    const percent = Number(String(e.percent).replace(',', '.'));
    if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
      return { ok: false, error: `${shopCode}: наполнение должно быть числом от 0 до 100` };
    }
    value.push({ date, shopCode, fill: percent / 100 });
  }

  return { ok: true, value };
}
