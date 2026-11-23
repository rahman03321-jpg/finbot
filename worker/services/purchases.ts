/**
 * Pembelian stok / restock (ARCHITECTURE.md §9.4). Pola batch §9.0:
 * uid dibuat sebelum batch, HPP & stok dihitung di SQL (HPP rata-rata memakai stok LAMA,
 * jadi UPDATE HPP dijalankan sebelum UPDATE stok).
 */
import { AppError } from "../lib/errors";
import { txDateError } from "../lib/date";
import { newUid } from "../lib/crypto";
import { MAX_AMOUNT } from "../bot/parsers/amount";
import { getAccount, type Actor, type Source } from "./cash";
import { requireStock } from "./features";
import type { Product } from "./products";

export type UpdateCost = "average" | "last" | "none";

export interface Purchase {
  id: number;
  uid: string;
  tanggal: string;
  supplier: string | null;
  total: number;
  account_id: number;
  update_cost: UpdateCost;
  status: "posted" | "void";
  note: string | null;
  created_by: number | null;
  created_at: string;
  voided_at: string | null;
  voided_by: number | null;
  void_reason: string | null;
}

export interface PurchaseItem {
  id: number;
  purchase_id: number;
  product_id: number;
  product_name: string;
  qty: number;
  unit_cost: number;
  line_total: number;
}

export interface HppChange {
  product_id: number;
  name: string;
  before: number;
  after: number;
}

export interface PurchaseDetail extends Purchase {
  account_name: string | null;
  items: PurchaseItem[];
  /** Perubahan HPP akibat pembelian ini (hanya terisi saat dibuat). */
  hppChanges: HppChange[];
  warnings: string[];
}

export interface NewPurchaseInput {
  uid?: string;
  tanggal: string;
  supplier?: string | null;
  items: { productId: number; qty: number; unitCost: number }[];
  accountId: number;
  updateCost?: UpdateCost;
  note?: string | null;
  source: Exclude<Source, "system">;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;

function assertAdmin(actor: Actor): void {
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("FORBIDDEN", "Hanya owner/admin yang bisa mencatat pembelian stok.", 403);
}

async function detail(db: D1Database, p: Purchase, hppChanges: HppChange[] = [], warnings: string[] = []): Promise<PurchaseDetail> {
  const [items, acc] = await Promise.all([
    db
      .prepare(
        `SELECT i.*, p.name AS product_name FROM purchase_items i JOIN products p ON p.id = i.product_id
         WHERE i.purchase_id = ?1 ORDER BY i.id`,
      )
      .bind(p.id)
      .all<PurchaseItem>(),
    db.prepare("SELECT name FROM accounts WHERE id = ?1").bind(p.account_id).first<{ name: string }>(),
  ]);
  return { ...p, account_name: acc?.name ?? null, items: items.results, hppChanges, warnings };
}

export async function getPurchase(db: D1Database, id: number): Promise<PurchaseDetail | null> {
  const p = await db.prepare("SELECT * FROM purchases WHERE id = ?1").bind(id).first<Purchase>();
  return p ? detail(db, p) : null;
}

export async function createPurchase(db: D1Database, input: NewPurchaseInput, actor: Actor): Promise<PurchaseDetail> {
  assertAdmin(actor);
  await requireStock(db);
  const uid = input.uid ?? newUid();
  const existing = await db.prepare("SELECT * FROM purchases WHERE uid = ?1").bind(uid).first<Purchase>();
  if (existing) return detail(db, existing);

  const dateErr = txDateError(input.tanggal);
  if (dateErr) throw new AppError("INVALID_DATE", dateErr);
  if (input.items.length < 1 || input.items.length > 50) throw new AppError("INVALID_ITEMS", "Pembelian harus berisi 1–50 item.");
  const updateCost: UpdateCost = input.updateCost ?? "average";
  if (!["average", "last", "none"].includes(updateCost)) throw new AppError("INVALID_UPDATE_COST", "Cara update HPP tidak dikenal.");
  const account = await getAccount(db, input.accountId);
  if (!account || !account.is_active) throw new AppError("INVALID_ACCOUNT", "Akun kas tidak ditemukan.");

  // Gabungkan baris produk yang sama: HPP dihitung sekali per produk.
  const groups = new Map<number, { qty: number; total: number; lastUnit: number }>();
  for (const it of input.items) {
    if (!Number.isSafeInteger(it.qty) || it.qty <= 0 || it.qty > 1_000_000) throw new AppError("INVALID_QTY", "Jumlah (qty) harus bilangan bulat > 0.");
    if (!Number.isSafeInteger(it.unitCost) || it.unitCost < 0 || it.unitCost > MAX_AMOUNT) throw new AppError("INVALID_AMOUNT", "Harga beli harus bilangan bulat rupiah ≥ 0.");
    const g = groups.get(it.productId) ?? { qty: 0, total: 0, lastUnit: 0 };
    g.qty += it.qty;
    g.total += it.qty * it.unitCost;
    g.lastUnit = it.unitCost;
    groups.set(it.productId, g);
  }
  const ids = [...groups.keys()];
  const { results: prods } = await db
    .prepare(`SELECT * FROM products WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...ids)
    .all<Product>();
  const byId = new Map(prods.map((p) => [p.id, p]));
  for (const id of ids) {
    const p = byId.get(id);
    if (!p || !p.is_active) throw new AppError("INVALID_PRODUCT", "Produk tidak ditemukan atau sudah nonaktif.");
  }
  const total = [...groups.values()].reduce((n, g) => n + g.total, 0);
  if (!Number.isSafeInteger(total) || total > MAX_AMOUNT) throw new AppError("INVALID_AMOUNT", "Total pembelian terlalu besar.");

  const supplier = input.supplier?.trim().slice(0, 80) || null;
  const note = input.note?.trim().slice(0, 200) || null;
  const pid = "(SELECT id FROM purchases WHERE uid = ?1)";

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        `INSERT INTO purchases (uid, tanggal, supplier, total, account_id, update_cost, note, created_by)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)`,
      )
      .bind(uid, input.tanggal, supplier, total, account.id, updateCost, note, actor.id),
  ];
  for (const it of input.items) {
    stmts.push(
      db
        .prepare(`INSERT INTO purchase_items (purchase_id, product_id, qty, unit_cost, line_total) VALUES (${pid}, ?2, ?3, ?4, ?3 * ?4)`)
        .bind(uid, it.productId, it.qty, it.unitCost),
    );
  }
  for (const [productId, g] of groups) {
    const before = byId.get(productId)!.cost_price;
    if (updateCost !== "none") {
      // D1 menuntut jumlah nilai bind = jumlah parameter di SQL, jadi tiap mode punya statement sendiri.
      const hppStmt =
        updateCost === "last"
          ? db
              .prepare("UPDATE products SET cost_price = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1")
              .bind(productId, g.lastUnit)
          : // rata-rata tertimbang dengan stok LAMA; stok ≤ 0 atau produk tanpa stok → pakai rata-rata pembelian ini
            db
              .prepare(
                `UPDATE products SET cost_price =
                   CASE WHEN track_stock = 1 AND stock > 0
                        THEN CAST(ROUND((stock * cost_price + ?2) * 1.0 / (stock + ?3)) AS INTEGER)
                        ELSE CAST(ROUND(?2 * 1.0 / ?3) AS INTEGER) END,
                   updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
                 WHERE id = ?1`,
              )
              .bind(productId, g.total, g.qty);
      stmts.push(
        hppStmt,
        db
          .prepare(
            `INSERT INTO product_price_history (product_id, cost_price, sell_price, reason, changed_by)
             SELECT id, cost_price, sell_price, 'purchase', ?3 FROM products WHERE id = ?1 AND cost_price <> ?2`,
          )
          .bind(productId, before, actor.id),
      );
    }
    stmts.push(
      db
        .prepare(
          `INSERT INTO stock_movements (product_id, tanggal, type, qty_change, ref_type, ref_id, created_by)
           SELECT id, ?3, 'purchase', ?4, 'purchase', ${pid.replace("?1", "?2")}, ?5 FROM products WHERE id = ?1 AND track_stock = 1`,
        )
        .bind(productId, uid, input.tanggal, g.qty, actor.id),
      db
        .prepare("UPDATE products SET stock = stock + ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1 AND track_stock = 1")
        .bind(productId, g.qty),
    );
  }
  stmts.push(
    db
      .prepare(
        `INSERT INTO cash_transactions (uid, tanggal, direction, amount, category_id, account_id, description, ref_type, ref_id, source, created_by)
         SELECT ?1 || ':cash', tanggal, 'out', total,
                (SELECT id FROM categories WHERE kind = 'stock_purchase' AND is_system = 1 ORDER BY id LIMIT 1),
                account_id, 'Belanja stok' || COALESCE(' - ' || supplier, ''), 'purchase', id, 'system', ?2
         FROM purchases WHERE uid = ?1 AND total > 0`,
      )
      .bind(uid, actor.id),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT ?2, 'purchase.create', 'purchases', id, json_object('total', total, 'items', ?3, 'update_cost', update_cost) FROM purchases WHERE uid = ?1`,
      )
      .bind(uid, actor.id, input.items.length),
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    if (e instanceof Error && /UNIQUE constraint failed: purchases\.uid/i.test(e.message)) {
      const again = await db.prepare("SELECT * FROM purchases WHERE uid = ?1").bind(uid).first<Purchase>();
      if (again) return detail(db, again);
    }
    throw e;
  }

  const p = (await db.prepare("SELECT * FROM purchases WHERE uid = ?1").bind(uid).first<Purchase>())!;
  const { results: after } = await db
    .prepare(`SELECT id, name, cost_price FROM products WHERE id IN (${ids.map((_, i) => `?${i + 1}`).join(",")})`)
    .bind(...ids)
    .all<{ id: number; name: string; cost_price: number }>();
  const hppChanges = after
    .filter((a) => a.cost_price !== byId.get(a.id)!.cost_price)
    .map((a) => ({ product_id: a.id, name: a.name, before: byId.get(a.id)!.cost_price, after: a.cost_price }));
  return detail(db, p, hppChanges);
}

/**
 * Batalkan pembelian: void + kas dibatalkan + stok dikurangi sesuai mutasi yang tercatat.
 * HPP TIDAK dihitung ulang otomatis (rata-rata tidak bisa dibalik dengan pasti) → diberi peringatan.
 */
export async function voidPurchase(
  db: D1Database,
  id: number,
  reason: string,
  actor: Actor,
  opts: { voidDate: string; now?: Date },
): Promise<PurchaseDetail> {
  assertAdmin(actor);
  const p = await db.prepare("SELECT * FROM purchases WHERE id = ?1").bind(id).first<Purchase>();
  if (!p) throw new AppError("NOT_FOUND", "Pembelian tidak ditemukan.", 404);
  if (p.status === "void") throw new AppError("ALREADY_VOID", "Pembelian ini sudah dibatalkan.", 409);
  const voidedAt = (opts.now ?? new Date()).toISOString();
  const cleanReason = reason.trim().slice(0, 200) || "Dibatalkan";
  const mine = "EXISTS (SELECT 1 FROM purchases WHERE id = ?1 AND status = 'void' AND voided_at = ?2 AND voided_by = ?3)";

  const r = await db.batch([
    db
      .prepare("UPDATE purchases SET status = 'void', voided_at = ?2, voided_by = ?3, void_reason = ?4 WHERE id = ?1 AND status = 'posted'")
      .bind(id, voidedAt, actor.id, cleanReason),
    db
      .prepare(
        `UPDATE cash_transactions SET status = 'void', voided_at = ?2, voided_by = ?3, void_reason = ?4
         WHERE ref_type = 'purchase' AND ref_id = ?1 AND status = 'posted' AND ${mine}`,
      )
      .bind(id, voidedAt, actor.id, cleanReason),
    db
      .prepare(
        `INSERT INTO stock_movements (product_id, tanggal, type, qty_change, ref_type, ref_id, note, created_by)
         SELECT product_id, ?4, 'purchase_void', -qty_change, 'purchase', ref_id, 'Void pembelian', ?3
         FROM stock_movements WHERE ref_type = 'purchase' AND ref_id = ?1 AND type = 'purchase' AND ${mine}`,
      )
      .bind(id, voidedAt, actor.id, opts.voidDate),
    db
      .prepare(
        `UPDATE products SET
           stock = stock - (SELECT SUM(m.qty_change) FROM stock_movements m
                            WHERE m.ref_type = 'purchase' AND m.ref_id = ?1 AND m.type = 'purchase' AND m.product_id = products.id),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id IN (SELECT product_id FROM stock_movements WHERE ref_type = 'purchase' AND ref_id = ?1 AND type = 'purchase') AND ${mine}`,
      )
      .bind(id, voidedAt, actor.id),
    db
      .prepare(`INSERT INTO audit_log (user_id, action, entity, entity_id, payload) SELECT ?3, 'purchase.void', 'purchases', ?1, ?4 WHERE ${mine}`)
      .bind(id, voidedAt, actor.id, JSON.stringify({ reason: cleanReason })),
  ]);
  if ((r[0]!.meta.changes ?? 0) === 0) throw new AppError("ALREADY_VOID", "Pembelian ini sudah dibatalkan.", 409);
  const after = (await db.prepare("SELECT * FROM purchases WHERE id = ?1").bind(id).first<Purchase>())!;
  const warnings =
    p.update_cost === "none" ? [] : ["HPP produk tidak dihitung ulang otomatis. Periksa HPP produk terkait dan ubah manual bila perlu."];
  return detail(db, after, [], warnings);
}

export interface PurchaseListRow extends Purchase {
  account_name: string | null;
  item_count: number;
  first_item: string | null;
}

export async function listPurchases(db: D1Database, f: { from: string; to: string; page?: number; limit?: number }): Promise<{ items: PurchaseListRow[]; hasMore: boolean }> {
  if (!YMD.test(f.from) || !YMD.test(f.to)) throw new AppError("INVALID_DATE", "Format tanggal harus YYYY-MM-DD.");
  const limit = Math.min(f.limit ?? 50, 100);
  const offset = ((f.page ?? 1) - 1) * limit;
  const { results } = await db
    .prepare(
      `SELECT pu.*, a.name AS account_name,
              (SELECT COUNT(*) FROM purchase_items WHERE purchase_id = pu.id) AS item_count,
              (SELECT p.name FROM purchase_items i JOIN products p ON p.id = i.product_id WHERE i.purchase_id = pu.id ORDER BY i.id LIMIT 1) AS first_item
       FROM purchases pu LEFT JOIN accounts a ON a.id = pu.account_id
       WHERE pu.tanggal BETWEEN ?1 AND ?2
       ORDER BY pu.tanggal DESC, pu.id DESC LIMIT ?3 OFFSET ?4`,
    )
    .bind(f.from, f.to, limit + 1, offset)
    .all<PurchaseListRow>();
  return { items: results.slice(0, limit), hasMore: results.length > limit };
}
