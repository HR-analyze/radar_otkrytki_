import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isUnlocked } from '@/lib/auth';
import { canEditShowcase, showcaseEditHint } from '@/lib/showcase-store';
import {
  MAX_PHOTOS,
  MAX_UPLOAD_BYTES,
  PhotoFormatError,
  PhotoLimitError,
  addPhotos,
  listPhotos,
  normalizePhoto,
  type PhotoFile,
} from '@/lib/showcase-photos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/**
 * Фото витрины лавки за день (см. showcase-photos.ts).
 *
 *  · GET  ?date=2026-10-14&shop=М12 — что уже приложено;
 *  · POST multipart: date, shop, files (1–5) — добавить.
 *
 * Сам файл и удаление — /api/showcase/photos/<id>. Пароль на /api/showcase/*
 * проверяет proxy; запись проверяет его ещё раз, как и правки процентов.
 */

const SHOP_CODE = /^[А-ЯA-Z]{1,3}\d{1,4}$/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;

export async function GET(req: Request) {
  const params = new URL(req.url).searchParams;
  const cell = parseCell(params.get('date'), params.get('shop'));
  if (!cell.ok) return NextResponse.json({ ok: false, error: cell.error }, { status: 400 });

  return NextResponse.json({
    ok: true,
    max: MAX_PHOTOS,
    editable: canEditShowcase(),
    photos: await listPhotos(cell.date, cell.shopCode),
  });
}

export async function POST(req: NextRequest) {
  if (!(await isUnlocked(req.cookies.get(COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Нужен пароль управления. Войдите заново.' }, { status: 401 });
  }
  if (!canEditShowcase()) {
    return NextResponse.json({ ok: false, error: showcaseEditHint() }, { status: 503 });
  }

  // Файл по одному на запрос (так шлёт окно фото); тело заметно больше лимита
  // proxy обрежет, и разбор формы упал бы с невнятной ошибкой. Отвечаем по-людски
  // раньше, по заголовку.
  const length = Number(req.headers.get('content-length') ?? 0);
  if (length > MAX_UPLOAD_BYTES + 1024 * 1024) {
    return NextResponse.json(
      { ok: false, error: `Файл больше ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ — такой не принимается` },
      { status: 413 },
    );
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  const cell = parseCell(form.get('date'), form.get('shop'));
  if (!cell.ok) return NextResponse.json({ ok: false, error: cell.error }, { status: 400 });

  const raw = form.getAll('files').filter((f): f is File => typeof f !== 'string');
  if (raw.length === 0 || raw.length > MAX_PHOTOS) {
    return NextResponse.json(
      { ok: false, error: `Выберите от 1 до ${MAX_PHOTOS} фото` },
      { status: 400 },
    );
  }

  const files: PhotoFile[] = [];
  for (const f of raw) {
    if (f.size > MAX_UPLOAD_BYTES) {
      return NextResponse.json(
        { ok: false, error: `«${f.name}» больше ${MAX_UPLOAD_BYTES / 1024 / 1024} МБ` },
        { status: 413 },
      );
    }
    // Любой картиночный формат: что не JPEG/PNG/WebP, сервер переводит в JPEG.
    try {
      files.push(await normalizePhoto(Buffer.from(await f.arrayBuffer())));
    } catch (e) {
      if (!(e instanceof PhotoFormatError)) throw e;
      return NextResponse.json({ ok: false, error: `«${f.name}»: ${e.message}` }, { status: 415 });
    }
  }

  try {
    const photos = await addPhotos(cell.date, cell.shopCode, files);
    return NextResponse.json({ ok: true, max: MAX_PHOTOS, photos });
  } catch (e) {
    if (e instanceof PhotoLimitError) {
      return NextResponse.json({ ok: false, error: e.message }, { status: 409 });
    }
    return NextResponse.json(
      { ok: false, error: e instanceof Error ? e.message : 'Не удалось сохранить фото' },
      { status: 503 },
    );
  }
}

type Cell = { ok: true; date: string; shopCode: string } | { ok: false; error: string };

function parseCell(rawDate: unknown, rawShop: unknown): Cell {
  const date = typeof rawDate === 'string' ? rawDate : '';
  const shopCode = typeof rawShop === 'string' ? rawShop.trim() : '';
  if (!ISO_DATE.test(date)) return { ok: false, error: 'Нужна дата в виде 2026-08-31' };
  if (!SHOP_CODE.test(shopCode)) return { ok: false, error: `Некорректный код лавки «${shopCode}»` };
  return { ok: true, date, shopCode };
}
