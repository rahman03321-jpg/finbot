/** State percakapan bot (draf sebelum Simpan). Satu draf aktif per user, TTL 10 menit. */
export const DRAFT_TTL_MS = 10 * 60 * 1000;

export async function loadState<T>(db: D1Database, telegramId: number, now: Date = new Date()): Promise<T | null> {
  const row = await db
    .prepare("SELECT state FROM bot_sessions WHERE telegram_id = ?1 AND expires_at > ?2")
    .bind(telegramId, now.toISOString())
    .first<{ state: string }>();
  return row ? (JSON.parse(row.state) as T) : null;
}

export async function saveState(db: D1Database, telegramId: number, state: unknown, now: Date = new Date()): Promise<void> {
  const expires = new Date(now.getTime() + DRAFT_TTL_MS).toISOString();
  await db
    .prepare(
      "INSERT INTO bot_sessions (telegram_id, state, expires_at) VALUES (?1, ?2, ?3) ON CONFLICT(telegram_id) DO UPDATE SET state = excluded.state, expires_at = excluded.expires_at",
    )
    .bind(telegramId, JSON.stringify(state), expires)
    .run();
}

export async function clearState(db: D1Database, telegramId: number): Promise<void> {
  await db.prepare("DELETE FROM bot_sessions WHERE telegram_id = ?1").bind(telegramId).run();
}
