/**
 * Кто сейчас заполняет какую лавку на вкладке «Витрины».
 *
 * Зачем. Двое садятся дозаполнять чужие пропуски и молча вбивают одну и ту же
 * лавку: друг друга они не видят, а цифры соседа появлялись только после
 * перезагрузки. Теперь каждый открытый редактор раз в несколько секунд
 * сообщает, на какой строке стоит курсор, и получает в ответ, где стоят
 * остальные (см. /api/showcase/live).
 *
 * Это подсказка, а не замок. Жёсткая бронь «моя лавка» зависала бы у того,
 * кто закрыл ноутбук и ушёл, и мешала бы больше, чем дубль. Метка гаснет сама,
 * если от вкладки ничего не слышно дольше PRESENCE_TTL_MS.
 *
 * Живёт в памяти процесса: радар на RelaxDev — один процесс `next start`.
 * Перезапуск сервера стирает метки, и это не потеря — через пару секунд их
 * пришлют заново.
 */

export const PRESENCE_TTL_MS = 15_000;

export interface PresenceFocus {
  date: string;
  shopCode: string;
}

export interface PresenceEntry extends PresenceFocus {
  /** Случайный номер вкладки: свою метку не показываем себе же. */
  client: string;
  /** Как человек назвался; пусто — «кто-то». */
  who: string;
}

export class PresenceBoard {
  private entries = new Map<string, PresenceEntry & { at: number }>();

  /** Отметиться: стою на строке; focus null — ушёл со строки. */
  touch(client: string, who: string, focus: PresenceFocus | null, now = Date.now()): void {
    if (focus) this.entries.set(client, { client, who, ...focus, at: now });
    else this.entries.delete(client);
  }

  /** Живые метки всех, кроме себя. */
  others(client: string, now = Date.now()): PresenceEntry[] {
    const out: PresenceEntry[] = [];
    for (const [key, e] of this.entries) {
      if (now - e.at > PRESENCE_TTL_MS) {
        this.entries.delete(key);
        continue;
      }
      if (key !== client) out.push({ client: e.client, who: e.who, date: e.date, shopCode: e.shopCode });
    }
    return out;
  }
}

/** Одна доска на процесс: модуль роута Next может подниматься не один раз. */
export function presenceBoard(): PresenceBoard {
  const g = globalThis as { __radarPresence?: PresenceBoard };
  return (g.__radarPresence ??= new PresenceBoard());
}
