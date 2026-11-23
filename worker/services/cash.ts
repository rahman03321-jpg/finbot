/**
 * Buku kas: kas masuk/keluar manual, transfer antar akun, void, saldo, akun kas.
 * Aturan: ARCHITECTURE.md §9.0 (pola batch) & §9.3 (kas manual).
 */
import { AppError } from "../lib/errors";
import { txDateError } from "../lib/date";
import { newUid } from "../lib/crypto";
import { MAX_AMOUNT } from "../bot/parsers/amount";
import type { Role } from "./users";

export type Direction = "in" | "out";
export type CategoryKind = "sales" | "other_income" | "capital_in" | "expense" | "stock_purchase" | "capital_out" | "transfer";
export type AccountType = "cash" | "bank" | "ewallet" | "marketplace";
export type Source = "bot" | "miniapp" | "system";

export interface Actor {
  id: number;
  role: Role;
}

export interface Category {
  id: number;
  name: string;
  direction: Direction;
  kind: CategoryKind;
  is_system: number;
  is_active: number;
}

export interface Account {
  id: number;
  name: string;
  type: AccountType;
  opening_balance: number;
  is_active: number;
}

export interface CashTransaction {
  id: number;
  uid: string;
  tanggal: string;
  direction: Direction;
  amount: number;
  category_id: number;
  account_id: number;
  description: string | null;
  ref_type: "sale" | "purchase" | "transfer" | "manual";
  ref_id: number | null;
  source: Source;
  status: "posted" | "void";
  created_by: number | null;
  created_at: string;
  voided_at: string | null;
  voided_by: number | null;
  void_reason: string | null;
}

/** Kind yang tidak boleh dipilih untuk kas manual (dibuat sistem / lewat alur transfer). */
const NON_MANUAL_KINDS: ReadonlySet<CategoryKind> = new Set(["sales", "transfer"]);

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const STAFF_VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

function isAdmin(actor: Actor): boolean {
  return actor.role === "owner" || actor.role === "admin";
}

function assertAmount(amount: number): void {
  if (!Number.isSafeInteger(amount) || amount <= 0 || amount > MAX_AMOUNT) {
    throw new AppError("INVALID_AMOUNT", "Nominal harus bilangan bulat rupiah lebih dari 0.");
  }
}

function assertTxDate(tanggal: string): void {
  const err = txDateError(tanggal);
  if (err) throw new AppError("INVALID_DATE", err);
}

function assertDate(tanggal: string): void {
  if (!YMD.test(tanggal)) throw new AppError("INVALID_DATE", "Format tanggal harus YYYY-MM-DD.");
}

// ---------------------------------------------------------------------------
// Kategori & akun
// ---------------------------------------------------------------------------

/** Kategori aktif yang boleh dipakai untuk kas manual pada arah tertentu. */
export async function listManualCategories(db: D1Database, direction: Direction): Promise<Category[]> {
  const { results } = await db
    .prepare("SELECT * FROM categories WHERE direction = ?1 AND is_active = 1 AND kind NOT IN ('sales','transfer') ORDER BY id")
    .bind(direction)
    .all<Category>();
  return results;
}

export async function getCategory(db: D1Database, id: number): Promise<Category | null> {
  return db.prepare("SELECT * FROM categories WHERE id = ?1").bind(id).first<Category>();
}

export async function listAccounts(db: D1Database, activeOnly = true): Promise<Account[]> {
  const sql = activeOnly ? "SELECT * FROM accounts WHERE is_active = 1 ORDER BY id" : "SELECT * FROM accounts ORDER BY id";
  return (await db.prepare(sql).all<Account>()).results;
}

export async function getAccount(db: D1Database, id: number): Promise<Account | null> {
  return db.prepare("SELECT * FROM accounts WHERE id = ?1").bind(id).first<Account>();
}

/** Akun default = akun aktif pertama (ARCHITECTURE.md §8). */
export async function defaultAccount(db: D1Database): Promise<Account> {
  const acc = await db.prepare("SELECT * FROM accounts WHERE is_active = 1 ORDER BY id LIMIT 1").first<Account>();
  if (!acc) throw new AppError("NO_ACCOUNT", "Belum ada akun kas aktif. Tambahkan akun dulu.");
  return acc;
}

export interface NewAccountInput {
  name: string;
  type: AccountType;
  openingBalance: number;
}

export async function createAccount(db: D1Database, input: NewAccountInput, actor: Actor): Promise<Account> {
  if (actor.role !== "owner") throw new AppError("FORBIDDEN", "Hanya owner yang bisa menambah akun kas.", 403);
  const name = input.name.trim();
  if (name.length < 1 || name.length > 40) throw new AppError("INVALID_NAME", "Nama akun 1–40 karakter.");
  if (!Number.isSafeInteger(input.openingBalance) || Math.abs(input.openingBalance) > MAX_AMOUNT) {
    throw new AppError("INVALID_AMOUNT", "Saldo awal harus bilangan bulat rupiah.");
  }
  const exists = await db.prepare("SELECT 1 FROM accounts WHERE name = ?1 COLLATE NOCASE").bind(name).first();
  if (exists) throw new AppError("DUPLICATE", `Akun "${name}" sudah ada.`, 409);

  const results = await db.batch([
    db.prepare("INSERT INTO accounts (name, type, opening_balance) VALUES (?1, ?2, ?3)").bind(name, input.type, input.openingBalance),
    db
      .prepare(
        "INSERT INTO audit_log (user_id, action, entity, entity_id, payload) SELECT ?1, 'account.create', 'accounts', id, ?2 FROM accounts WHERE name = ?3",
      )
      .bind(actor.id, JSON.stringify({ type: input.type, opening_balance: input.openingBalance }), name),
    db.prepare("SELECT * FROM accounts WHERE name = ?1").bind(name),
  ]);
  return results[2]!.results[0] as Account;
}

export interface AccountBalance {
  id: number;
  name: string;
  type: AccountType;
  opening_balance: number;
  balance: number;
}

/** Saldo per akun aktif = saldo awal + Σ masuk − Σ keluar (posted), sampai `untilDate` (inklusif) bila diisi. */
export async function accountBalances(db: D1Database, untilDate?: string): Promise<AccountBalance[]> {
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name, a.type, a.opening_balance,
              a.opening_balance + COALESCE(SUM(CASE t.direction WHEN 'in' THEN t.amount ELSE -t.amount END), 0) AS balance
       FROM accounts a
       LEFT JOIN cash_transactions t
         ON t.account_id = a.id AND t.status = 'posted' AND (?1 IS NULL OR t.tanggal <= ?1)
       WHERE a.is_active = 1
       GROUP BY a.id ORDER BY a.id`,
    )
    .bind(untilDate ?? null)
    .all<AccountBalance>();
  return results;
}

/** Saldo saat ini satu akun (saldo awal + Σ masuk − Σ keluar, posted). */
export async function accountBalance(db: D1Database, accountId: number): Promise<number> {
  const row = await db
    .prepare(
      `SELECT a.opening_balance + COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END)
                                              FROM cash_transactions WHERE account_id = a.id AND status = 'posted'), 0) AS balance
       FROM accounts a WHERE a.id = ?1`,
    )
    .bind(accountId)
    .first<{ balance: number }>();
  return row?.balance ?? 0;
}

// ---------------------------------------------------------------------------
// Kas manual
// ---------------------------------------------------------------------------

export interface NewCashInput {
  uid?: string;
  tanggal: string;
  direction: Direction;
  amount: number;
  categoryId: number;
  accountId: number;
  description?: string | null;
  source: Exclude<Source, "system">;
}

export async function getCashByUid(db: D1Database, uid: string): Promise<CashTransaction | null> {
  return db.prepare("SELECT * FROM cash_transactions WHERE uid = ?1").bind(uid).first<CashTransaction>();
}

export async function getCash(db: D1Database, id: number): Promise<CashTransaction | null> {
  return db.prepare("SELECT * FROM cash_transactions WHERE id = ?1").bind(id).first<CashTransaction>();
}

function isUniqueUidError(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: cash_transactions\.uid/i.test(e.message);
}

/**
 * Catat kas masuk/keluar manual. Idempoten terhadap `uid`: pemanggilan ulang dengan uid
 * yang sama mengembalikan transaksi yang sudah tersimpan.
 */
export async function createCashTransaction(db: D1Database, input: NewCashInput, actor: Actor): Promise<CashTransaction> {
  const uid = input.uid ?? newUid();
  const existing = await getCashByUid(db, uid);
  if (existing) return existing;

  assertAmount(input.amount);
  assertTxDate(input.tanggal);
  const description = input.description?.trim() || null;
  if (description && description.length > 200) throw new AppError("INVALID_NOTE", "Catatan maksimal 200 karakter.");

  const [category, account] = await Promise.all([getCategory(db, input.categoryId), getAccount(db, input.accountId)]);
  if (!category || !category.is_active) throw new AppError("INVALID_CATEGORY", "Kategori tidak ditemukan.");
  if (category.direction !== input.direction) throw new AppError("INVALID_CATEGORY", "Kategori tidak sesuai arah kas (masuk/keluar).");
  if (NON_MANUAL_KINDS.has(category.kind)) {
    throw new AppError("INVALID_CATEGORY", `Kategori "${category.name}" tidak bisa dipilih manual.`);
  }
  if (!account || !account.is_active) throw new AppError("INVALID_ACCOUNT", "Akun kas tidak ditemukan.");

  try {
    const results = await db.batch([
      db
        .prepare(
          `INSERT INTO cash_transactions (uid, tanggal, direction, amount, category_id, account_id, description, ref_type, source, created_by)
           VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'manual', ?8, ?9)`,
        )
        .bind(uid, input.tanggal, input.direction, input.amount, category.id, account.id, description, input.source, actor.id),
      db
        .prepare(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
           SELECT ?1, 'cash.create', 'cash_transactions', id, ?2 FROM cash_transactions WHERE uid = ?3`,
        )
        .bind(actor.id, JSON.stringify({ direction: input.direction, amount: input.amount, category_id: category.id, account_id: account.id }), uid),
      db.prepare("SELECT * FROM cash_transactions WHERE uid = ?1").bind(uid),
    ]);
    return results[2]!.results[0] as CashTransaction;
  } catch (e) {
    if (isUniqueUidError(e)) {
      const again = await getCashByUid(db, uid);
      if (again) return again;
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Transfer antar akun
// ---------------------------------------------------------------------------

export interface NewTransferInput {
  uid?: string;
  tanggal: string;
  amount: number;
  fromAccountId: number;
  toAccountId: number;
  description?: string | null;
  source: Exclude<Source, "system">;
}

export interface Transfer {
  out: CashTransaction;
  in: CashTransaction;
}

async function transferCategoryIds(db: D1Database): Promise<{ out: number; in: number }> {
  const { results } = await db
    .prepare("SELECT id, direction FROM categories WHERE kind = 'transfer' AND is_system = 1 ORDER BY id")
    .all<{ id: number; direction: Direction }>();
  const out = results.find((r) => r.direction === "out");
  const inn = results.find((r) => r.direction === "in");
  if (!out || !inn) throw new AppError("NO_TRANSFER_CATEGORY", "Kategori transfer bawaan tidak ditemukan.", 500);
  return { out: out.id, in: inn.id };
}

/** Pindah dana antar akun: 2 baris kas yang saling merujuk (§9.3). Admin ke atas. */
export async function createTransfer(db: D1Database, input: NewTransferInput, actor: Actor): Promise<Transfer> {
  if (!isAdmin(actor)) throw new AppError("FORBIDDEN", "Hanya owner/admin yang bisa transfer antar akun.", 403);
  const uidOut = input.uid ?? newUid();
  const uidIn = `${uidOut}:in`;

  const existingOut = await getCashByUid(db, uidOut);
  if (existingOut) {
    const existingIn = await getCashByUid(db, uidIn);
    if (existingIn) return { out: existingOut, in: existingIn };
  }

  assertAmount(input.amount);
  assertTxDate(input.tanggal);
  if (input.fromAccountId === input.toAccountId) throw new AppError("SAME_ACCOUNT", "Akun asal dan tujuan tidak boleh sama.");
  const [from, to] = await Promise.all([getAccount(db, input.fromAccountId), getAccount(db, input.toAccountId)]);
  if (!from || !from.is_active || !to || !to.is_active) throw new AppError("INVALID_ACCOUNT", "Akun kas tidak ditemukan.");
  const cat = await transferCategoryIds(db);
  const description = input.description?.trim() || `Transfer ${from.name} → ${to.name}`;

  const insert = `INSERT INTO cash_transactions (uid, tanggal, direction, amount, category_id, account_id, description, ref_type, ref_id, source, created_by)
                  VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, 'transfer', ?8, ?9, ?10)`;
  try {
    const results = await db.batch([
      db.prepare(insert).bind(uidOut, input.tanggal, "out", input.amount, cat.out, from.id, description, null, input.source, actor.id),
      db
        .prepare(insert.replace("?8", "(SELECT id FROM cash_transactions WHERE uid = ?8)"))
        .bind(uidIn, input.tanggal, "in", input.amount, cat.in, to.id, description, uidOut, input.source, actor.id),
      db
        .prepare("UPDATE cash_transactions SET ref_id = (SELECT id FROM cash_transactions WHERE uid = ?2) WHERE uid = ?1")
        .bind(uidOut, uidIn),
      db
        .prepare(
          `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
           SELECT ?1, 'cash.transfer', 'cash_transactions', id, ?2 FROM cash_transactions WHERE uid = ?3`,
        )
        .bind(actor.id, JSON.stringify({ amount: input.amount, from: from.id, to: to.id }), uidOut),
      db.prepare("SELECT * FROM cash_transactions WHERE uid IN (?1, ?2)").bind(uidOut, uidIn),
    ]);
    const rows = results[4]!.results as CashTransaction[];
    return { out: rows.find((r) => r.direction === "out")!, in: rows.find((r) => r.direction === "in")! };
  } catch (e) {
    if (isUniqueUidError(e)) {
      const [o, i] = await Promise.all([getCashByUid(db, uidOut), getCashByUid(db, uidIn)]);
      if (o && i) return { out: o, in: i };
    }
    throw e;
  }
}

// ---------------------------------------------------------------------------
// Void
// ---------------------------------------------------------------------------

/**
 * Batalkan transaksi kas (bukan DELETE). Transfer: kedua baris ikut di-void.
 * Kas dari penjualan/pembelian harus dibatalkan lewat transaksi induknya.
 * Staff hanya boleh membatalkan miliknya sendiri dan < 24 jam.
 */
export async function voidCashTransaction(
  db: D1Database,
  id: number,
  reason: string,
  actor: Actor,
  now: Date = new Date(),
): Promise<CashTransaction[]> {
  const tx = await getCash(db, id);
  if (!tx) throw new AppError("NOT_FOUND", "Transaksi tidak ditemukan.", 404);
  if (tx.status === "void") throw new AppError("ALREADY_VOID", "Transaksi ini sudah dibatalkan.", 409);
  if (tx.ref_type === "sale") throw new AppError("USE_PARENT", "Kas ini dari penjualan. Batalkan penjualannya.", 409);
  if (tx.ref_type === "purchase") throw new AppError("USE_PARENT", "Kas ini dari pembelian stok. Batalkan pembeliannya.", 409);

  if (!isAdmin(actor)) {
    const age = now.getTime() - Date.parse(tx.created_at);
    if (tx.created_by !== actor.id || tx.ref_type === "transfer" || age > STAFF_VOID_WINDOW_MS) {
      throw new AppError("FORBIDDEN", "Staff hanya bisa membatalkan transaksinya sendiri dalam 24 jam.", 403);
    }
  }

  const ids = tx.ref_type === "transfer" && tx.ref_id !== null ? [tx.id, tx.ref_id] : [tx.id];
  const cleanReason = reason.trim().slice(0, 200) || "Dibatalkan";
  const voidedAt = now.toISOString();

  const stmts: D1PreparedStatement[] = ids.map((txId) =>
    db
      .prepare(
        "UPDATE cash_transactions SET status = 'void', voided_at = ?2, voided_by = ?3, void_reason = ?4 WHERE id = ?1 AND status = 'posted'",
      )
      .bind(txId, voidedAt, actor.id, cleanReason),
  );
  // Audit hanya bila void benar-benar terjadi di batch ini (bukan kalah balapan dengan void lain).
  stmts.push(
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT ?1, 'cash.void', 'cash_transactions', ?2, ?3
         WHERE EXISTS (SELECT 1 FROM cash_transactions WHERE id = ?2 AND status = 'void' AND voided_at = ?4 AND voided_by = ?1)`,
      )
      .bind(actor.id, tx.id, JSON.stringify({ ids, reason: cleanReason }), voidedAt),
  );
  stmts.push(db.prepare(`SELECT * FROM cash_transactions WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")}) ORDER BY id`).bind(...ids));

  const results = await db.batch(stmts);
  const changed = results.slice(0, ids.length).reduce((n, r) => n + (r.meta.changes ?? 0), 0);
  if (changed === 0) throw new AppError("ALREADY_VOID", "Transaksi ini sudah dibatalkan.", 409);
  return results[results.length - 1]!.results as CashTransaction[];
}

// ---------------------------------------------------------------------------
// Daftar transaksi (Mini App)
// ---------------------------------------------------------------------------

export interface CashListRow extends CashTransaction {
  category_name: string;
  category_kind: CategoryKind;
  account_name: string;
  created_by_name: string | null;
}

export interface CashListFilter {
  from: string;
  to: string;
  direction?: Direction;
  accountId?: number;
  categoryId?: number;
  page?: number;
  limit?: number;
}

/** Transaksi kas dalam rentang tanggal (termasuk yang void, ditandai statusnya), terbaru dulu. */
export async function listCash(db: D1Database, f: CashListFilter): Promise<{ items: CashListRow[]; hasMore: boolean }> {
  assertDate(f.from);
  assertDate(f.to);
  const limit = Math.min(f.limit ?? 50, 100);
  const offset = ((f.page ?? 1) - 1) * limit;
  const { results } = await db
    .prepare(
      `SELECT t.*, c.name AS category_name, c.kind AS category_kind, a.name AS account_name, u.full_name AS created_by_name
       FROM cash_transactions t
       JOIN categories c ON c.id = t.category_id
       JOIN accounts a ON a.id = t.account_id
       LEFT JOIN users u ON u.id = t.created_by
       WHERE t.status IN ('posted','void') AND t.tanggal BETWEEN ?1 AND ?2
         AND (?3 IS NULL OR t.direction = ?3)
         AND (?4 IS NULL OR t.account_id = ?4)
         AND (?5 IS NULL OR t.category_id = ?5)
       ORDER BY t.tanggal DESC, t.id DESC
       LIMIT ?6 OFFSET ?7`,
    )
    .bind(f.from, f.to, f.direction ?? null, f.accountId ?? null, f.categoryId ?? null, limit + 1, offset)
    .all<CashListRow>();
  return { items: results.slice(0, limit), hasMore: results.length > limit };
}

/** Semua kategori aktif (untuk meta Mini App). */
export async function listCategories(db: D1Database): Promise<Category[]> {
  return (await db.prepare("SELECT * FROM categories WHERE is_active = 1 ORDER BY direction, id").all<Category>()).results;
}
