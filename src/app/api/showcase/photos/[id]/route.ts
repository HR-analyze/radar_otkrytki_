import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isUnlocked } from '@/lib/auth';
import { canEditShowcase, showcaseEditHint } from '@/lib/showcase-store';
import { deletePhoto, listPhotos, readPhoto } from '@/lib/showcase-photos';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** Одно фото витрины: GET — сам файл для <img>, DELETE — убрать. */

/**
 * Кэш — только с проверкой на каждом показе (no-cache + ETag). Не immutable:
 * удалённое фото иначе оставалось бы в кэше браузера, а после смены пароля
 * открывалось бы мимо proxy. Сам снимок под id не меняется, поэтому повторный
 * показ — это короткий ответ 304 без байтов.
 */
const CACHE = { 'Cache-Control': 'private, no-cache', Vary: 'Cookie' } as const;

export async function GET(req: Request, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const photo = await readPhoto(id);
  if (!photo) {
    return NextResponse.json({ ok: false, error: 'Фото не найдено' }, { status: 404, headers: CACHE });
  }

  const etag = `"photo-${photo.id}"`;
  if (req.headers.get('if-none-match') === etag) {
    return new Response(null, { status: 304, headers: { ...CACHE, ETag: etag } });
  }

  const ext = photo.mime.split('/')[1].replace('jpeg', 'jpg');
  return new Response(new Uint8Array(photo.data), {
    headers: {
      // Тип — тот, что определили по байтам при загрузке, а не присланный браузером.
      'Content-Type': photo.mime,
      'Content-Length': String(photo.data.length),
      'X-Content-Type-Options': 'nosniff',
      ...CACHE,
      ETag: etag,
      'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(
        `${photo.shopCode}_${photo.date}_${photo.id}.${ext}`,
      )}`,
    },
  });
}

export async function DELETE(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  if (!(await isUnlocked(req.cookies.get(COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Нужен пароль управления. Войдите заново.' }, { status: 401 });
  }
  if (!canEditShowcase()) {
    return NextResponse.json({ ok: false, error: showcaseEditHint() }, { status: 503 });
  }

  const { id } = await params;
  const gone = await deletePhoto(id);
  if (!gone) return NextResponse.json({ ok: false, error: 'Фото уже удалено' }, { status: 404 });

  return NextResponse.json({ ok: true, photos: await listPhotos(gone.date, gone.shopCode) });
}
