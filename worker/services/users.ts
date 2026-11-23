import { AppError } from "../lib/errors";
import { randomHex, safeEqual } from "../lib/crypto";
import { getSetting } from "./settings";

export type Role = "owner" | "admin" | "staff";

export interface User {
  id: number;
  telegram_id: number;
  username: string | null;
  full_name: string;
  role: Role;
  is_active: number;
}

export interface TelegramIdentity {
  telegramId: number;
  username?: string | undefined;
  fullName: string;
}

export async function findActiveUser(db: D1Database, telegramId: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE telegram_id = ?1 AND is_active = 1").bind(telegramId).first<User>();
}

export async function hasOwner(db: D1Database): Promise<boolean> {
  const row = await db.prepare("SELECT 1 AS x FROM users WHERE role = 'owner' AND is_active = 1 LIMIT 1").first();
  return row !== null;
}

/**
 * Buat kode klaim owner bila belum ada owner. Kode lama dipakai ulang supaya
 * membuka /setup berkali-kali tidak membatalkan tautan yang sudah dibagikan.
 * Mengembalikan null bila owner sudah ada.
 */
export async function ensureOwnerClaimCode(db: D1Database): Promise<string | null> {
  if (await hasOwner(db)) return null;
  await db
    .prepare("INSERT OR IGNORE INTO settings (key, value) VALUES ('owner_claim_code', ?1)")
    .bind(randomHex(16))
    .run();
  return getSetting(db, "owner_claim_code");
}

/**
 * Klaim owner dengan kode dari /setup. Atomik: hanya berhasil bila kode cocok dan
 * belum ada owner, sehingga dua klaim bersamaan tidak bisa sama-sama menang.
 */
export async function claimOwner(db: D1Database, code: string, who: TelegramIdentity): Promise<User> {
  const stored = await getSetting(db, "owner_claim_code");
  if (!stored || !(await safeEqual(stored, code))) {
    throw new AppError("CLAIM_INVALID", "Kode klaim tidak valid atau sudah dipakai.", 403);
  }

  const guard = `EXISTS (SELECT 1 FROM settings WHERE key = 'owner_claim_code' AND value = ?4)
                 AND NOT EXISTS (SELECT 1 FROM users WHERE role = 'owner' AND is_active = 1)`;

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO users (telegram_id, username, full_name, role)
         SELECT ?1, ?2, ?3, 'owner' WHERE ${guard}
         ON CONFLICT(telegram_id) DO UPDATE SET role = 'owner', is_active = 1,
           username = excluded.username, full_name = excluded.full_name,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .bind(who.telegramId, who.username ?? null, who.fullName, stored),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT id, 'user.claim_owner', 'users', id, NULL FROM users
         WHERE telegram_id = ?1 AND role = 'owner'
           AND EXISTS (SELECT 1 FROM settings WHERE key = 'owner_claim_code' AND value = ?2)`,
      )
      .bind(who.telegramId, stored),
    db
      .prepare(
        `DELETE FROM settings WHERE key = 'owner_claim_code' AND value = ?2
           AND EXISTS (SELECT 1 FROM users WHERE telegram_id = ?1 AND role = 'owner')`,
      )
      .bind(who.telegramId, stored),
    db.prepare("SELECT * FROM users WHERE telegram_id = ?1").bind(who.telegramId),
  ]);

  const user = (results[3]?.results[0] ?? null) as User | null;
  if (!user || user.role !== "owner") {
    throw new AppError("CLAIM_INVALID", "Kode klaim tidak valid atau sudah dipakai.", 403);
  }
  return user;
}

// ---------------------------------------------------------------------------
// Kelola user (owner saja): undangan, tambah langsung, ubah peran, aktif/nonaktif
// ---------------------------------------------------------------------------

export type MemberRole = Exclude<Role, "owner">;

export const INVITE_TTL_MS = 24 * 60 * 60 * 1000;

interface ActorLike {
  id: number;
  role: Role;
}

function assertOwner(actor: ActorLike): void {
  if (actor.role !== "owner") throw new AppError("FORBIDDEN", "Hanya owner yang bisa mengelola user.", 403);
}

export async function listUsers(db: D1Database): Promise<User[]> {
  const { results } = await db
    .prepare("SELECT * FROM users ORDER BY is_active DESC, CASE role WHEN 'owner' THEN 0 WHEN 'admin' THEN 1 ELSE 2 END, full_name COLLATE NOCASE")
    .all<User>();
  return results;
}

export interface Invite {
  code: string;
  role: MemberRole;
  expires_at: string;
}

/** Buat tautan undangan sekali pakai (24 jam). */
export async function createInvite(db: D1Database, role: MemberRole, actor: ActorLike, now: Date = new Date()): Promise<Invite> {
  assertOwner(actor);
  const code = randomHex(12);
  const expires = new Date(now.getTime() + INVITE_TTL_MS).toISOString();
  await db.batch([
    db.prepare("INSERT INTO user_invites (code, role, created_by, expires_at) VALUES (?1, ?2, ?3, ?4)").bind(code, role, actor.id, expires),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'user.invite', 'user_invites', NULL, ?2)")
      .bind(actor.id, JSON.stringify({ role, expires_at: expires })),
  ]);
  return { code, role, expires_at: expires };
}

/**
 * Pakai undangan. Atomik & sekali pakai: undangan "diklaim" dulu dengan penanda waktu,
 * lalu user dibuat/diaktifkan hanya bila klaim itu milik batch ini. Owner tidak bisa
 * turun peran lewat undangan.
 */
export async function acceptInvite(db: D1Database, code: string, who: TelegramIdentity, now: Date = new Date()): Promise<User> {
  const marker = now.toISOString() + "#" + randomHex(4);
  const claimed = "EXISTS (SELECT 1 FROM user_invites WHERE code = ?1 AND used_at = ?2)";
  const results = await db.batch([
    db
      .prepare("UPDATE user_invites SET used_at = ?2 WHERE code = ?1 AND used_at IS NULL AND expires_at > ?3")
      .bind(code, marker, now.toISOString()),
    db
      .prepare(
        `INSERT INTO users (telegram_id, username, full_name, role)
         SELECT ?3, ?4, ?5, (SELECT role FROM user_invites WHERE code = ?1) WHERE ${claimed}
         ON CONFLICT(telegram_id) DO UPDATE SET role = excluded.role, is_active = 1,
           username = excluded.username, full_name = excluded.full_name,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE users.role <> 'owner'`,
      )
      .bind(code, marker, who.telegramId, who.username ?? null, who.fullName),
    db
      .prepare(`UPDATE user_invites SET used_by = (SELECT id FROM users WHERE telegram_id = ?3) WHERE code = ?1 AND used_at = ?2`)
      .bind(code, marker, who.telegramId),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT id, 'user.join', 'users', id, json_object('role', role) FROM users WHERE telegram_id = ?3 AND ${claimed}`,
      )
      .bind(code, marker, who.telegramId),
  ]);
  if ((results[0]!.meta.changes ?? 0) === 0) {
    throw new AppError("INVITE_INVALID", "Tautan undangan tidak valid, sudah dipakai, atau kedaluwarsa. Minta owner membuat tautan baru.", 403);
  }
  const user = await db.prepare("SELECT * FROM users WHERE telegram_id = ?1").bind(who.telegramId).first<User>();
  return user!;
}

/** Tambah (atau aktifkan ulang) user langsung, mis. dari balasan pesan di grup. */
export async function addUser(db: D1Database, who: TelegramIdentity, role: MemberRole, actor: ActorLike): Promise<User> {
  assertOwner(actor);
  const existing = await db.prepare("SELECT * FROM users WHERE telegram_id = ?1").bind(who.telegramId).first<User>();
  if (existing?.role === "owner") throw new AppError("IS_OWNER", "Orang ini adalah owner.", 409);
  await db.batch([
    db
      .prepare(
        `INSERT INTO users (telegram_id, username, full_name, role) VALUES (?1, ?2, ?3, ?4)
         ON CONFLICT(telegram_id) DO UPDATE SET role = excluded.role, is_active = 1,
           username = excluded.username, full_name = excluded.full_name,
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')`,
      )
      .bind(who.telegramId, who.username ?? null, who.fullName, role),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT ?1, 'user.add', 'users', id, json_object('role', ?3) FROM users WHERE telegram_id = ?2`,
      )
      .bind(actor.id, who.telegramId, role),
  ]);
  return (await db.prepare("SELECT * FROM users WHERE telegram_id = ?1").bind(who.telegramId).first<User>())!;
}

export interface UserChange {
  role?: MemberRole;
  isActive?: boolean;
}

/** Ubah peran / status aktif user lain. Owner tidak bisa diubah lewat sini. */
export async function updateUser(db: D1Database, userId: number, change: UserChange, actor: ActorLike): Promise<User> {
  assertOwner(actor);
  const before = await db.prepare("SELECT * FROM users WHERE id = ?1").bind(userId).first<User>();
  if (!before) throw new AppError("NOT_FOUND", "User tidak ditemukan.", 404);
  if (before.role === "owner") throw new AppError("IS_OWNER", "Peran dan status owner tidak bisa diubah.", 409);
  const role = change.role ?? before.role;
  const active = change.isActive === undefined ? before.is_active : change.isActive ? 1 : 0;
  const results = await db.batch([
    db
      .prepare("UPDATE users SET role = ?2, is_active = ?3, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
      .bind(userId, role, active),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'user.update', 'users', ?2, ?3)")
      .bind(actor.id, userId, JSON.stringify({ before: { role: before.role, is_active: before.is_active }, after: { role, is_active: active } })),
    db.prepare("SELECT * FROM users WHERE id = ?1").bind(userId),
  ]);
  return results[2]!.results[0] as User;
}

export async function getActiveUserById(db: D1Database, id: number): Promise<User | null> {
  return db.prepare("SELECT * FROM users WHERE id = ?1 AND is_active = 1").bind(id).first<User>();
}
