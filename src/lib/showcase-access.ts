import fs from 'node:fs';
import path from 'node:path';
import { showcaseStorePath } from './showcase-store';

/**
 * Можно ли править витрины на этом хостинге.
 *
 * Редактор пишет в файл, поэтому нужен диск: на своей виртуалке и локально он
 * есть, на Vercel файловая система только для чтения. Там вкладка открывается
 * в режиме просмотра и честно говорит почему — молча терять правки нельзя.
 */
export function canEditShowcase(): boolean {
  if (process.env.VERCEL) return false;

  const dir = path.dirname(showcaseStorePath());
  try {
    fs.mkdirSync(/* turbopackIgnore: true */ dir, { recursive: true });
    fs.accessSync(/* turbopackIgnore: true */ dir, fs.constants.W_OK);
    return true;
  } catch {
    return false;
  }
}

export function showcaseEditHint(): string {
  return canEditShowcase()
    ? 'Правки сохраняются сразу и тут же видны на дашборде.'
    : 'Здесь только просмотр: на этом хостинге файловая система доступна лишь для чтения. ' +
        'Правьте витрины там, где радар развёрнут на своём сервере.';
}
