/** Bersih-bersih rutin dari cron (ARCHITECTURE.md §13). Bukan data keuangan. */
export async function cleanup(db: D1Database, now: Date = new Date()): Promise<void> {
  const nowIso = now.toISOString();
  const threeDaysAgo = new Date(now.getTime() - 3 * 24 * 60 * 60 * 1000).toISOString();
  await db.batch([
    db.prepare("DELETE FROM bot_sessions WHERE expires_at < ?1").bind(nowIso),
    db.prepare("DELETE FROM processed_updates WHERE processed_at < ?1").bind(threeDaysAgo),
  ]);
}
