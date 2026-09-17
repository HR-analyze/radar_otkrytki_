import { openManualDb } from './manual-db';

export interface ContestViolation {
  id: string;
  shopCode: string;
  /** Ответственный РМ фиксируется при внесении, не меняется со справочником. */
  region: string;
  reason: string;
  createdAt: string | null;
  fixed: boolean;
}

// Постоянная поправка к конкурсу, доступная и на хостинге без SQLite.
// Не вставляем при каждом запуске в БД: одна запись не может задвоиться.
const M25: ContestViolation = {
  id: 'm25-permanent', shopCode: 'М25', region: 'Лясецкая Юлия',
  reason: 'Постоянный штраф М25 по решению владельца', createdAt: null, fixed: true,
};

export async function readContestViolations(): Promise<ContestViolation[]> {
  const db = await openManualDb();
  if (!db) return [{ ...M25 }];
  const rows = db.prepare(`
    SELECT id, shop_code AS shopCode, region, reason, created_at AS createdAt
    FROM contest_violations ORDER BY created_at DESC, id
  `).all() as Omit<ContestViolation, 'fixed'>[];
  return [{ ...M25 }, ...rows.map((r) => ({ ...r, fixed: false }))];
}

export async function saveContestViolation(
  entry: Pick<ContestViolation, 'id' | 'shopCode' | 'region' | 'reason'>,
): Promise<void> {
  if (!/^[0-9a-f-]{36}$/i.test(entry.id) || !entry.shopCode || !entry.region ||
      !entry.reason.trim() || entry.reason.length > 300) {
    throw new Error('Нужны лавка, РМ и причина нарушения (до 300 символов).');
  }
  const db = await openManualDb();
  if (!db) throw new Error('На этом хостинге нет базы для сохранения нарушений.');
  // Один id на отправку: повтор запроса после обрыва сети не удваивает штраф.
  db.transaction(() => {
    const existing = db.prepare(`SELECT shop_code, region, reason FROM contest_violations WHERE id = ?`)
      .get(entry.id) as { shop_code: string; region: string; reason: string } | undefined;
    if (existing) {
      if (existing.shop_code !== entry.shopCode || existing.region !== entry.region || existing.reason !== entry.reason.trim()) {
        throw new Error('Этот запрос уже сохранён с другими данными. Обновите страницу.');
      }
      return;
    }
    db.prepare(`INSERT INTO contest_violations (id, shop_code, region, reason, created_at)
      VALUES (?, ?, ?, ?, ?)`).run(entry.id, entry.shopCode, entry.region, entry.reason.trim(), new Date().toISOString());
  })();
}

export async function removeContestViolation(id: string): Promise<void> {
  if (id === M25.id) throw new Error('Постоянный штраф М25 закреплён и не снимается.');
  const db = await openManualDb();
  if (!db) throw new Error('На этом хостинге нет базы для сохранения нарушений.');
  db.prepare(`DELETE FROM contest_violations WHERE id = ?`).run(id);
}
