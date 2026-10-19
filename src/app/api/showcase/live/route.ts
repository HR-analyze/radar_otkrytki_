import { NextResponse, type NextRequest } from 'next/server';
import { COOKIE, isUnlocked } from '@/lib/auth';
import { presenceBoard } from '@/lib/showcase-presence';
import { showcaseVersion } from '@/lib/showcase-store';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

const CLIENT = /^[a-z0-9-]{8,40}$/;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHOP_CODE = /^[А-ЯA-Z]{1,3}\d{1,4}$/i;

/**
 * Пульс редактора витрин: раз в несколько секунд вкладка говорит, на какой
 * строке стоит, и узнаёт две вещи:
 *
 *  · `version` — дешёвую версию данных витрин (см. showcaseVersion). Сменилась —
 *    кто-то сохранил цифры, редактор тихо перечитывает свой день или лавку;
 *  · `presence` — где сейчас стоят остальные (см. showcase-presence.ts).
 *
 * Один запрос на оба вопроса: два таймера на вкладку — вдвое больше запросов
 * при тех же ответах.
 */
export async function POST(req: NextRequest) {
  if (!(await isUnlocked(req.cookies.get(COOKIE)?.value))) {
    return NextResponse.json({ ok: false, error: 'Нужен пароль управления. Войдите заново.' }, { status: 401 });
  }

  let body: { client?: unknown; who?: unknown; focus?: unknown };
  try {
    body = (await req.json()) as typeof body;
  } catch {
    return NextResponse.json({ ok: false, error: 'Не удалось прочитать запрос' }, { status: 400 });
  }

  const client = String(body.client ?? '');
  if (!CLIENT.test(client)) return NextResponse.json({ ok: false, error: 'Нет номера вкладки' }, { status: 400 });
  const who = String(body.who ?? '').replace(/\s+/g, ' ').trim().slice(0, 40);

  const f = body.focus as { date?: unknown; shopCode?: unknown } | null | undefined;
  const date = String(f?.date ?? '');
  const shopCode = String(f?.shopCode ?? '');
  const focus = f && ISO_DATE.test(date) && SHOP_CODE.test(shopCode) ? { date, shopCode } : null;

  const board = presenceBoard();
  board.touch(client, who, focus);

  return NextResponse.json({
    ok: true,
    version: await showcaseVersion(),
    presence: board.others(client),
  });
}
