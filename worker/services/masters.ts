/**
 * Data master yang bisa dikelola user: kategori kas, akun kas (rekening/sumber kas), channel penjualan.
 * "Hapus" selalu berarti menonaktifkan (is_active = 0) karena transaksi lama masih merujuknya.
 * Setiap perubahan menulis audit_log.
 */
import { AppError } from "../lib/errors";
import { MAX_AMOUNT } from "../bot/parsers/amount";
import { accountBalance, type Account, type AccountType, type Actor, type Category, type CategoryKind, type Direction } from "./cash";

function assertAdmin(actor: Actor): void {
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("FORBIDDEN", "Hanya owner/admin yang bisa mengubah pengaturan ini.", 403);
}

function assertOwner(actor: Actor): void {
  if (actor.role !== "owner") throw new AppError("FORBIDDEN", "Hanya owner yang bisa mengubah akun kas.", 403);
}

function cleanName(name: string, max: number, label: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > max) throw new AppError("INVALID_NAME", `Nama ${label} 1–${max} karakter.`);
  return n;
}

function audit(db: D1Database, actor: Actor, action: string, entity: string, entityId: number | null, payload: unknown): D1PreparedStatement {
  return db
    .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, ?2, ?3, ?4, ?5)")
    .bind(actor.id, action, entity, entityId, JSON.stringify(payload));
}

// ---------------------------------------------------------------------------
// Kategori
// ---------------------------------------------------------------------------

/** Jenis yang boleh dipilih user per arah (sales & transfer hanya dibuat sistem). */
export const MANUAL_KINDS: Record<Direction, CategoryKind[]> = {
  in: ["other_income", "capital_in"],
  out: ["expense", "stock_purchase", "capital_out"],
};

async function getCategoryRow(db: D1Database, id: number): Promise<Category | null> {
  return db.prepare("SELECT * FROM categories WHERE id = ?1").bind(id).first<Category>();
}

export async function createCategory(db: D1Database, input: { name: string; direction: Direction; kind: CategoryKind }, actor: Actor): Promise<Category> {
  assertAdmin(actor);
  const name = cleanName(input.name, 40, "kategori");
  if (!MANUAL_KINDS[input.direction]?.includes(input.kind)) throw new AppError("INVALID_KIND", "Jenis kategori tidak sesuai arah kas.");

  const existing = await db
    .prepare("SELECT * FROM categories WHERE name = ?1 COLLATE NOCASE AND direction = ?2")
    .bind(name, input.direction)
    .first<Category>();
  if (existing?.is_active) throw new AppError("DUPLICATE", `Kategori "${name}" sudah ada.`, 409);

  if (existing) {
    // Pernah dihapus → aktifkan lagi dengan jenis yang dipilih sekarang.
    if (existing.is_system && existing.kind !== input.kind) throw new AppError("DUPLICATE", `Nama "${name}" dipakai kategori bawaan.`, 409);
    const r = await db.batch([
      db.prepare("UPDATE categories SET is_active = 1, kind = ?2, name = ?3 WHERE id = ?1").bind(existing.id, input.kind, name),
      audit(db, actor, "category.restore", "categories", existing.id, { name, kind: input.kind }),
      db.prepare("SELECT * FROM categories WHERE id = ?1").bind(existing.id),
    ]);
    return r[2]!.results[0] as Category;
  }

  const r = await db.batch([
    db.prepare("INSERT INTO categories (name, direction, kind) VALUES (?1, ?2, ?3)").bind(name, input.direction, input.kind),
    db
      .prepare(
        "INSERT INTO audit_log (user_id, action, entity, entity_id, payload) SELECT ?1, 'category.create', 'categories', id, ?2 FROM categories WHERE name = ?3 AND direction = ?4",
      )
      .bind(actor.id, JSON.stringify({ name, kind: input.kind }), name, input.direction),
    db.prepare("SELECT * FROM categories WHERE name = ?1 AND direction = ?2").bind(name, input.direction),
  ]);
  return r[2]!.results[0] as Category;
}

/**
 * Ubah nama/jenis. Kategori bawaan hanya boleh ganti nama.
 * Mengganti jenis memengaruhi laporan lama (laporan dihitung ulang dari jenis kategori saat ini).
 */
export async function updateCategory(db: D1Database, id: number, input: { name?: string; kind?: CategoryKind }, actor: Actor): Promise<Category> {
  assertAdmin(actor);
  const before = await getCategoryRow(db, id);
  if (!before || !before.is_active) throw new AppError("NOT_FOUND", "Kategori tidak ditemukan.", 404);
  if (before.kind === "sales" || before.kind === "transfer") throw new AppError("SYSTEM", "Kategori ini dikelola sistem.", 409);

  const name = input.name !== undefined ? cleanName(input.name, 40, "kategori") : before.name;
  const kind = input.kind ?? before.kind;
  if (kind !== before.kind) {
    if (before.is_system) throw new AppError("SYSTEM", "Jenis kategori bawaan tidak bisa diubah.", 409);
    if (!MANUAL_KINDS[before.direction].includes(kind)) throw new AppError("INVALID_KIND", "Jenis kategori tidak sesuai arah kas.");
  }
  if (name.toLowerCase() !== before.name.toLowerCase()) {
    const dup = await db.prepare("SELECT 1 FROM categories WHERE name = ?1 COLLATE NOCASE AND direction = ?2 AND id <> ?3").bind(name, before.direction, id).first();
    if (dup) throw new AppError("DUPLICATE", `Kategori "${name}" sudah ada.`, 409);
  }
  const r = await db.batch([
    db.prepare("UPDATE categories SET name = ?2, kind = ?3 WHERE id = ?1").bind(id, name, kind),
    audit(db, actor, "category.update", "categories", id, { before: { name: before.name, kind: before.kind }, after: { name, kind } }),
    db.prepare("SELECT * FROM categories WHERE id = ?1").bind(id),
  ]);
  return r[2]!.results[0] as Category;
}

export async function deleteCategory(db: D1Database, id: number, actor: Actor): Promise<void> {
  assertAdmin(actor);
  const c = await getCategoryRow(db, id);
  if (!c || !c.is_active) throw new AppError("NOT_FOUND", "Kategori tidak ditemukan.", 404);
  if (c.is_system) throw new AppError("SYSTEM", "Kategori bawaan tidak bisa dihapus.", 409);
  await db.batch([db.prepare("UPDATE categories SET is_active = 0 WHERE id = ?1").bind(id), audit(db, actor, "category.delete", "categories", id, { name: c.name })]);
}

// ---------------------------------------------------------------------------
// Akun kas (rekening / sumber kas)
// ---------------------------------------------------------------------------

export const ACCOUNT_TYPES: AccountType[] = ["cash", "bank", "ewallet", "marketplace"];

async function getAccountRow(db: D1Database, id: number): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id).first<Account>();
}

function assertOpening(n: number): void {
  if (!Number.isSafeInteger(n) || Math.abs(n) > MAX_AMOUNT) throw new AppError("INVALID_AMOUNT", "Saldo awal harus bilangan bulat rupiah.");
}

/** Tambah akun; nama yang pernah dihapus diaktifkan lagi. (createAccount di cash.ts tetap dipakai /akun tambah.) */
export async function addAccount(db: D1Database, input: { name: string; type: AccountType; openingBalance: number }, actor: Actor): Promise<Account> {
  assertOwner(actor);
  const name = cleanName(input.name, 40, "akun");
  if (!ACCOUNT_TYPES.includes(input.type)) throw new AppError("INVALID_TYPE", "Tipe akun tidak dikenal.");
  assertOpening(input.openingBalance);
  const existing = await db.prepare("SELECT * FROM accounts WHERE name = ?1 COLLATE NOCASE").bind(name).first<Account>();
  if (existing?.is_active) throw new AppError("DUPLICATE", `Akun "${name}" sudah ada.`, 409);

  if (existing) {
    const r = await db.batch([
      db.prepare("UPDATE accounts SET is_active = 1, type = ?2, name = ?3 WHERE id = ?1").bind(existing.id, input.type, name),
      audit(db, actor, "account.restore", "accounts", existing.id, { name, type: input.type }),
      db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(existing.id),
    ]);
    return r[2]!.results[0] as Account;
  }
  const r = await db.batch([
    db.prepare("INSERT INTO accounts (name, type, opening_balance) VALUES (?1, ?2, ?3)").bind(name, input.type, input.openingBalance),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) SELECT ?1, 'account.create', 'accounts', id, ?2 FROM accounts WHERE name = ?3")
      .bind(actor.id, JSON.stringify({ type: input.type, opening_balance: input.openingBalance }), name),
    db.prepare("SELECT * FROM accounts WHERE name = ?1").bind(name),
  ]);
  return r[2]!.results[0] as Account;
}

/** Ubah nama, tipe, atau saldo awal (saldo awal berubah → semua saldo ikut bergeser; tercatat di audit). */
export async function updateAccount(
  db: D1Database,
  id: number,
  input: { name?: string; type?: AccountType; openingBalance?: number },
  actor: Actor,
): Promise<Account> {
  assertOwner(actor);
  const before = await getAccountRow(db, id);
  if (!before || !before.is_active) throw new AppError("NOT_FOUND", "Akun tidak ditemukan.", 404);
  const name = input.name !== undefined ? cleanName(input.name, 40, "akun") : before.name;
  const type = input.type ?? before.type;
  if (!ACCOUNT_TYPES.includes(type)) throw new AppError("INVALID_TYPE", "Tipe akun tidak dikenal.");
  const opening = input.openingBalance ?? before.opening_balance;
  assertOpening(opening);
  if (name.toLowerCase() !== before.name.toLowerCase()) {
    const dup = await db.prepare("SELECT 1 FROM accounts WHERE name = ?1 COLLATE NOCASE AND id <> ?2").bind(name, id).first();
    if (dup) throw new AppError("DUPLICATE", `Akun "${name}" sudah ada.`, 409);
  }
  const r = await db.batch([
    db.prepare("UPDATE accounts SET name = ?2, type = ?3, opening_balance = ?4 WHERE id = ?1").bind(id, name, type, opening),
    audit(db, actor, "account.update", "accounts", id, {
      before: { name: before.name, type: before.type, opening_balance: before.opening_balance },
      after: { name, type, opening_balance: opening },
    }),
    db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id),
  ]);
  return r[2]!.results[0] as Account;
}

/** Nonaktifkan akun. Saldo harus 0 (pindahkan dulu lewat transfer) dan minimal satu akun tetap aktif. */
export async function deleteAccount(db: D1Database, id: number, actor: Actor): Promise<void> {
  assertOwner(actor);
  const a = await getAccountRow(db, id);
  if (!a || !a.is_active) throw new AppError("NOT_FOUND", "Akun tidak ditemukan.", 404);
  const active = await db.prepare("SELECT COUNT(*) AS n FROM accounts WHERE is_active = 1").first<{ n: number }>();
  if ((active?.n ?? 0) <= 1) throw new AppError("LAST_ACCOUNT", "Minimal harus ada satu akun kas aktif.", 409);
  const balance = await accountBalance(db, id);
  if (balance !== 0) {
    throw new AppError("NOT_EMPTY", `Saldo ${a.name} masih ${balance.toLocaleString("id-ID")}. Pindahkan dulu lewat transfer sampai saldonya 0.`, 409);
  }
  await db.batch([db.prepare("UPDATE accounts SET is_active = 0 WHERE id = ?1").bind(id), audit(db, actor, "account.delete", "accounts", id, { name: a.name })]);
}

// ---------------------------------------------------------------------------
// Channel penjualan
// ---------------------------------------------------------------------------

export interface Channel {
  id: number;
  code: string;
  name: string;
  is_system: number;
  is_active: number;
  sort: number;
}

/** Singkatan yang dikenali bot → code channel bawaan. */
export const CHANNEL_ALIASES: Record<string, string> = {
  toko: "offline",
  tokped: "tokopedia",
  wa: "whatsapp",
  ig: "instagram",
  fb: "facebook",
  tiktokshop: "tiktok",
};

export async function listChannels(db: D1Database, activeOnly = true): Promise<Channel[]> {
  const sql = `SELECT * FROM channels ${activeOnly ? "WHERE is_active = 1" : ""} ORDER BY sort, name COLLATE NOCASE`;
  return (await db.prepare(sql).all<Channel>()).results;
}

export async function getActiveChannel(db: D1Database, code: string): Promise<Channel | null> {
  return db.prepare("SELECT * FROM channels WHERE code = ?1 AND is_active = 1").bind(code).first<Channel>();
}

function slug(name: string): string {
  return (
    name
      .toLowerCase()
      .normalize("NFKD")
      .replace(/[^a-z0-9]+/g, "")
      .slice(0, 24) || "channel"
  );
}

export async function createChannel(db: D1Database, input: { name: string }, actor: Actor): Promise<Channel> {
  assertAdmin(actor);
  const name = cleanName(input.name, 30, "channel");
  const existing = await db.prepare("SELECT * FROM channels WHERE name = ?1 COLLATE NOCASE OR code = ?2").bind(name, slug(name)).first<Channel>();
  if (existing?.is_active) throw new AppError("DUPLICATE", `Channel "${existing.name}" sudah ada.`, 409);
  if (existing) {
    const r = await db.batch([
      db.prepare("UPDATE channels SET is_active = 1, name = ?2 WHERE id = ?1").bind(existing.id, name),
      audit(db, actor, "channel.restore", "channels", existing.id, { name }),
      db.prepare("SELECT * FROM channels WHERE id = ?1").bind(existing.id),
    ]);
    return r[2]!.results[0] as Channel;
  }
  // code unik: slug, lalu slug2, slug3, ...
  const base = slug(name);
  let code = base;
  for (let i = 2; await db.prepare("SELECT 1 FROM channels WHERE code = ?1").bind(code).first(); i++) code = `${base}${i}`;
  const r = await db.batch([
    db.prepare("INSERT INTO channels (code, name, sort) VALUES (?1, ?2, (SELECT COALESCE(MAX(sort), 0) + 10 FROM channels))").bind(code, name),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) SELECT ?1, 'channel.create', 'channels', id, ?2 FROM channels WHERE code = ?3")
      .bind(actor.id, JSON.stringify({ code, name }), code),
    db.prepare("SELECT * FROM channels WHERE code = ?1").bind(code),
  ]);
  return r[2]!.results[0] as Channel;
}

/** Ganti nama tampilan. `code` tetap supaya penjualan lama tidak berubah. */
export async function updateChannel(db: D1Database, id: number, input: { name: string }, actor: Actor): Promise<Channel> {
  assertAdmin(actor);
  const before = await db.prepare("SELECT * FROM channels WHERE id = ?1 AND is_active = 1").bind(id).first<Channel>();
  if (!before) throw new AppError("NOT_FOUND", "Channel tidak ditemukan.", 404);
  const name = cleanName(input.name, 30, "channel");
  const dup = await db.prepare("SELECT 1 FROM channels WHERE name = ?1 COLLATE NOCASE AND id <> ?2 AND is_active = 1").bind(name, id).first();
  if (dup) throw new AppError("DUPLICATE", `Channel "${name}" sudah ada.`, 409);
  const r = await db.batch([
    db.prepare("UPDATE channels SET name = ?2 WHERE id = ?1").bind(id, name),
    audit(db, actor, "channel.update", "channels", id, { before: before.name, after: name }),
    db.prepare("SELECT * FROM channels WHERE id = ?1").bind(id),
  ]);
  return r[2]!.results[0] as Channel;
}

export async function deleteChannel(db: D1Database, id: number, actor: Actor): Promise<void> {
  assertAdmin(actor);
  const c = await db.prepare("SELECT * FROM channels WHERE id = ?1 AND is_active = 1").bind(id).first<Channel>();
  if (!c) throw new AppError("NOT_FOUND", "Channel tidak ditemukan.", 404);
  if (c.is_system) throw new AppError("SYSTEM", "Channel Offline adalah bawaan dan tidak bisa dihapus.", 409);
  await db.batch([db.prepare("UPDATE channels SET is_active = 0 WHERE id = ?1").bind(id), audit(db, actor, "channel.delete", "channels", id, { code: c.code, name: c.name })]);
}
