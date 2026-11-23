/**
 * Migrasi idempoten. Satu-satunya cara skema berubah (lihat ARCHITECTURE.md §6.3).
 * Setiap file migrasi baru WAJIB didaftarkan di MIGRATIONS.
 */
import m0001 from "../../migrations/0001_init.sql";
import m0002 from "../../migrations/0002_user_invites.sql";
import m0003 from "../../migrations/0003_channels.sql";

export interface Migration {
  version: number;
  sql: string;
}

export const MIGRATIONS: readonly Migration[] = [
  { version: 1, sql: m0001 },
  { version: 2, sql: m0002 },
  { version: 3, sql: m0003 },
];

/**
 * Pecah SQL menjadi statement. Mengabaikan komentar `--` dan `;` di dalam string '...'.
 * Tidak mendukung trigger / blok BEGIN…END (memang dilarang di migrasi).
 */
export function splitStatements(sql: string): string[] {
  const out: string[] = [];
  let cur = "";
  let inString = false;
  for (let i = 0; i < sql.length; i++) {
    const ch = sql[i]!;
    if (inString) {
      cur += ch;
      if (ch === "'") {
        if (sql[i + 1] === "'") {
          cur += "'";
          i++;
        } else {
          inString = false;
        }
      }
      continue;
    }
    if (ch === "'") {
      inString = true;
      cur += ch;
    } else if (ch === "-" && sql[i + 1] === "-") {
      while (i < sql.length && sql[i] !== "\n") i++;
      cur += "\n";
    } else if (ch === ";") {
      const s = cur.trim();
      if (s) out.push(s);
      cur = "";
    } else {
      cur += ch;
    }
  }
  const tail = cur.trim();
  if (tail) out.push(tail);
  return out;
}

export interface MigrateResult {
  applied: number[];
  current: number;
}

export async function migrate(db: D1Database, migrations: readonly Migration[] = MIGRATIONS): Promise<MigrateResult> {
  await db
    .prepare(
      "CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')))",
    )
    .run();

  const { results } = await db.prepare("SELECT version FROM schema_version").all<{ version: number }>();
  const done = new Set(results.map((r) => r.version));
  const applied: number[] = [];

  for (const m of [...migrations].sort((a, b) => a.version - b.version)) {
    if (done.has(m.version)) continue;
    const stmts = splitStatements(m.sql).map((s) => db.prepare(s));
    // Isi migrasi + pencatatan versi dalam SATU batch → berhasil penuh atau tidak sama sekali.
    stmts.push(db.prepare("INSERT INTO schema_version (version) VALUES (?1)").bind(m.version));
    await db.batch(stmts);
    applied.push(m.version);
    done.add(m.version);
  }

  return { applied, current: Math.max(0, ...done) };
}
