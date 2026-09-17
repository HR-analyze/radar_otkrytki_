import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isUnlocked } from '@/lib/auth';
import { listShops } from '@/lib/queries';
import { normalizeCode } from '@/lib/shops';
import { checkUploadToken } from '@/lib/upload-store';
import { removeContestViolation, saveContestViolation } from '@/lib/contest-violations-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

async function authorize(req: NextRequest) {
  if (!(await isUnlocked(req.cookies.get(COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Для внесения нарушений нужен пароль.' }, { status: 401 });
  }
  const token = checkUploadToken(req);
  if (!token.ok) return NextResponse.json({ ok: false, error: token.reason }, { status: 401 });
  return null;
}

export async function POST(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;
  let body: unknown;
  try { body = await req.json(); } catch { body = null; }
  if (!body || typeof body !== 'object') {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать нарушение.' }, { status: 400 });
  }
  const { id, shopCode, reason } = body as Record<string, unknown>;
  if (typeof id !== 'string' || !/^[0-9a-f-]{36}$/i.test(id) ||
      typeof shopCode !== 'string' || typeof reason !== 'string' ||
      !reason.trim() || reason.length > 300) {
    return NextResponse.json({ ok: false, error: 'Выберите лавку и укажите причину (до 300 символов).' }, { status: 400 });
  }
  const shop = (await listShops()).find((s) => s.code === normalizeCode(shopCode));
  if (!shop?.region) {
    return NextResponse.json({ ok: false, error: 'Лавка или её РМ не найдены в справочнике.' }, { status: 400 });
  }
  try {
    // Клиент не задаёт РМ: берём его из справочника и сохраняем навсегда.
    await saveContestViolation({ id, shopCode: shop.code, region: shop.region, reason });
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Не удалось сохранить.' }, { status: 503 });
  }
}

export async function DELETE(req: NextRequest) {
  const denied = await authorize(req);
  if (denied) return denied;
  const id = req.nextUrl.searchParams.get('id') ?? '';
  if (!/^[0-9a-f-]{36}$/i.test(id)) {
    return NextResponse.json({ ok: false, error: 'Этот штраф нельзя снять.' }, { status: 400 });
  }
  try {
    await removeContestViolation(id);
    return NextResponse.json({ ok: true });
  } catch (e) {
    return NextResponse.json({ ok: false, error: e instanceof Error ? e.message : 'Не удалось снять штраф.' }, { status: 503 });
  }
}
