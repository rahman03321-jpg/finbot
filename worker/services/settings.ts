import type { Env } from "../env";
import { AppError } from "../lib/errors";
import { randomHex } from "../lib/crypto";

/** Key yang berisi rahasia: tidak boleh pernah dikirim lewat API. */
export const SECRET_SETTING_KEYS = new Set(["webhook_secret", "session_secret", "owner_claim_code"]);

export async function getSetting(db: D1Database, key: string): Promise<string | null> {
  const row = await db.prepare("SELECT value FROM settings WHERE key = ?1").bind(key).first<{ value: string }>();
  return row?.value ?? null;
}

export function setSettingStmt(db: D1Database, key: string, value: string): D1PreparedStatement {
  return db
    .prepare("INSERT INTO settings (key, value) VALUES (?1, ?2) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
    .bind(key, value);
}

export async function setSetting(db: D1Database, key: string, value: string): Promise<void> {
  await setSettingStmt(db, key, value).run();
}

/** Simpan nilai hanya jika key belum ada; kembalikan nilai yang berlaku. Aman dari balapan. */
export async function ensureSetting(db: D1Database, key: string, make: () => string): Promise<string> {
  await db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, ?2)").bind(key, make()).run();
  return (await getSetting(db, key))!;
}

/** Secret env diutamakan; kalau kosong, pakai (atau buat) nilai di tabel settings. */
async function secret(env: Env, envValue: string | undefined, key: string): Promise<string> {
  if (envValue && envValue.length > 0) return envValue;
  return ensureSetting(env.DB, key, () => randomHex(32));
}

export function getWebhookSecret(env: Env): Promise<string> {
  return secret(env, env.WEBHOOK_SECRET, "webhook_secret");
}

export function getSessionSecret(env: Env): Promise<string> {
  return secret(env, env.SESSION_SECRET, "session_secret");
}

// ---------------------------------------------------------------------------
// Pengaturan usaha & laporan otomatis (owner)
// ---------------------------------------------------------------------------

export interface ReportTarget {
  /** "owner" = chat pribadi owner; "group" = grup yang dipilih lewat /jadwal grup */
  type: "owner" | "group";
  chatId: number | null;
  title: string | null;
}

export interface AppSettings {
  business_name: string;
  daily_report_enabled: boolean;
  weekly_report_enabled: boolean;
  monthly_report_enabled: boolean;
  /** Jam kirim (WIB) 0–23 untuk semua laporan otomatis */
  report_hour: number;
  report_target: ReportTarget;
  /** Modul stok (§9.4) */
  feature_stock: boolean;
}

const BOOL_KEYS = ["daily_report_enabled", "weekly_report_enabled", "monthly_report_enabled", "feature_stock"] as const;

export async function getAppSettings(db: D1Database): Promise<AppSettings> {
  const { results } = await db
    .prepare(
      `SELECT key, value FROM settings WHERE key IN ('business_name','daily_report_enabled','weekly_report_enabled',
         'monthly_report_enabled','daily_report_hour_wib','daily_report_chat_id','daily_report_chat_title','feature_stock')`,
    )
    .all<{ key: string; value: string }>();
  const m = new Map(results.map((r) => [r.key, r.value]));
  const chatId = m.get("daily_report_chat_id");
  const hour = Number(m.get("daily_report_hour_wib") ?? "21");
  return {
    business_name: m.get("business_name") ?? "Usaha Saya",
    daily_report_enabled: (m.get("daily_report_enabled") ?? "1") === "1",
    weekly_report_enabled: (m.get("weekly_report_enabled") ?? "1") === "1",
    monthly_report_enabled: (m.get("monthly_report_enabled") ?? "1") === "1",
    report_hour: Number.isInteger(hour) && hour >= 0 && hour <= 23 ? hour : 21,
    report_target: chatId
      ? { type: "group", chatId: Number(chatId), title: m.get("daily_report_chat_title") ?? null }
      : { type: "owner", chatId: null, title: null },
    feature_stock: m.get("feature_stock") === "1",
  };
}

export interface SettingsPatch {
  business_name?: string;
  daily_report_enabled?: boolean;
  weekly_report_enabled?: boolean;
  monthly_report_enabled?: boolean;
  report_hour?: number;
  /** Hanya bisa dikembalikan ke "owner"; grup dipilih lewat /jadwal grup di grup itu. */
  report_target?: "owner";
  feature_stock?: boolean;
}

export async function updateAppSettings(db: D1Database, patch: SettingsPatch, actor: { id: number; role: string }): Promise<AppSettings> {
  if (actor.role !== "owner") throw new AppError("FORBIDDEN", "Hanya owner yang bisa mengubah pengaturan usaha.", 403);
  const stmts: D1PreparedStatement[] = [];
  if (patch.business_name !== undefined) {
    const name = patch.business_name.trim().replace(/\s+/g, " ");
    if (name.length < 1 || name.length > 60) throw new AppError("INVALID_NAME", "Nama usaha 1–60 karakter.");
    stmts.push(setSettingStmt(db, "business_name", name));
  }
  for (const k of BOOL_KEYS) {
    const v = patch[k];
    if (v !== undefined) stmts.push(setSettingStmt(db, k, v ? "1" : "0"));
  }
  if (patch.report_hour !== undefined) {
    if (!Number.isInteger(patch.report_hour) || patch.report_hour < 0 || patch.report_hour > 23) {
      throw new AppError("INVALID_HOUR", "Jam laporan 0–23.");
    }
    stmts.push(setSettingStmt(db, "daily_report_hour_wib", String(patch.report_hour)));
  }
  if (patch.report_target === "owner") {
    stmts.push(db.prepare("DELETE FROM settings WHERE key IN ('daily_report_chat_id','daily_report_chat_title')"));
  }
  if (!stmts.length) return getAppSettings(db);
  stmts.push(
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'settings.update', 'settings', NULL, ?2)")
      .bind(actor.id, JSON.stringify(patch)),
  );
  await db.batch(stmts);
  return getAppSettings(db);
}

/** Jadikan grup ini tujuan laporan otomatis (dipanggil dari /jadwal grup). */
export async function setReportGroup(db: D1Database, chatId: number, title: string, actor: { id: number; role: string }): Promise<void> {
  if (actor.role !== "owner") throw new AppError("FORBIDDEN", "Hanya owner yang bisa mengatur tujuan laporan.", 403);
  await db.batch([
    setSettingStmt(db, "daily_report_chat_id", String(chatId)),
    setSettingStmt(db, "daily_report_chat_title", title.slice(0, 80)),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'settings.report_group', 'settings', NULL, ?2)")
      .bind(actor.id, JSON.stringify({ chat_id: chatId, title })),
  ]);
}
