import { NextResponse } from 'next/server';
import { loadConfig } from '@/lib/config';
import { listDates, listShops } from '@/lib/queries';
import { invalidateSnapshot } from '@/lib/snapshot';
import { statusForFill } from '@/lib/status';
import { checkUploadToken } from '@/lib/upload-store';
import {
  canEditShowcase,
  readShowcase,
  saveShowcaseEdits,
  showcaseEditHint,
  type ShowcaseEdit,
} from '@/lib/showcase-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Наполнение витрин за день: что показать в редакторе и что он присылает назад.
 *
 * Правки сохраняются пачкой в базу ручных данных и видны на дашборде сразу —
 * снимок читает витрины оттуда же (см. showcase-store.ts), пересобирать
 * ничего не нужно.
 */
export async function GET(req: Request) {
  const date = new URL(req.url).searchParams.get('date') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) {
    return NextResponse.json({ ok: false, error: 'Нужна дата в виде 2026-08-31' }, { status: 400 });
  }

  const config = loadConfig();
  const store = await readShowcase();
  const values = store.days[date] ?? {};
  const notes = store.notes[date] ?? {};
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
      note: notes[s.code] ?? '',
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

  let changed: number;
  try {
    ({ changed } = await saveShowcaseEdits(edits.value));
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
      // fill=undefined значит «правили только комментарий»: процент остаётся
      // прежним, и брать его надо из базы, а не из правки.
      const fill = e.fill === undefined ? (store.days[e.date]?.[e.shopCode] ?? null) : e.fill;
      return {
        date: e.date,
        shopCode: e.shopCode,
        percent: fill == null ? null : Math.round(fill * 100),
        status: statusForFill(fill, config),
        note: store.notes[e.date]?.[e.shopCode] ?? '',
      };
    }),
    filled: Object.keys(store.days[edits.value[0]?.date ?? ''] ?? {}).length,
  });
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
    const e = item as { date?: unknown; shopCode?: unknown; percent?: unknown; note?: unknown };
    const date = String(e.date ?? '');
    const shopCode = String(e.shopCode ?? '').trim();

    if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return { ok: false, error: `Некорректная дата «${date}»` };
    if (!/^[А-ЯA-Z]{1,3}\d{1,4}$/i.test(shopCode)) {
      return { ok: false, error: `Некорректный код лавки «${shopCode}»` };
    }

    const edit: ShowcaseEdit = { date, shopCode };

    // Ключа нет вовсе — поле не правили. Пустая строка или null — стереть.
    if ('percent' in e) {
      if (e.percent == null || e.percent === '') {
        edit.fill = null;
      } else {
        const percent = Number(String(e.percent).replace(',', '.'));
        if (!Number.isFinite(percent) || percent < 0 || percent > 100) {
          return { ok: false, error: `${shopCode}: наполнение должно быть числом от 0 до 100` };
        }
        edit.fill = percent / 100;
      }
    }

    if ('note' in e) {
      const note = e.note == null ? '' : String(e.note);
      if (note.length > MAX_NOTE) {
        return { ok: false, error: `${shopCode}: комментарий длиннее ${MAX_NOTE} символов` };
      }
      edit.note = note;
    }

    if (edit.fill === undefined && edit.note === undefined) {
      return { ok: false, error: `${shopCode}: в правке нет ни процента, ни комментария` };
    }
    value.push(edit);
  }

  return { ok: true, value };
}
