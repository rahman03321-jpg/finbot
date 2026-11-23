/**
 * Penjualan (ARCHITECTURE.md §9.1 & §9.2). Pola batch §9.0: uid dibuat sebelum batch,
 * baris anak merujuk induk lewat (SELECT id FROM sales WHERE uid = ?), invoice & HPP dihitung di SQL.
 */
import { AppError } from "../lib/errors";
import { txDateError } from "../lib/date";
import { newUid } from "../lib/crypto";
import { MAX_AMOUNT } from "../bot/parsers/amount";
import { getAccount, type Actor, type Source } from "./cash";
import { getFeatures } from "./features";
import { getActiveChannel } from "./masters";
import type { Product } from "./products";

export interface Sale {
  id: number;
  uid: string;
  invoice_no: string;
  tanggal: string;
  channel: string;
  customer_name: string | null;
  subtotal: number;
  discount: number;
  total: number;
  total_cost: number;
  account_id: number;
  source: "bot" | "miniapp";
  status: "posted" | "void";
  note: string | null;
  created_by: number | null;
  created_at: string;
  voided_at: string | null;
  voided_by: number | null;
  void_reason: string | null;
}

export interface SaleItem {
  id: number;
  sale_id: number;
  product_id: number | null;
  item_name: string;
  qty: number;
  sell_price: number;
  cost_price: number;
  line_total: number;
}

export interface SaleWithItems extends Sale {
  items: SaleItem[];
  /** Peringatan non-fatal, mis. stok jadi minus. */
  warnings: string[];
}

/** Item dari master produk: nama & HPP di-snapshot dari produk; harga jual boleh di-override. */
export interface ProductItemInput {
  productId: number;
  qty: number;
  sellPrice?: number;
}

/** Item cepat (tanpa master produk): semua diisi user. */
export interface QuickItemInput {
  itemName: string;
  qty: number;
  sellPrice: number;
  costPrice?: number;
}

export type SaleItemInput = ProductItemInput | QuickItemInput;

export interface NewSaleInput {
  uid?: string;
  tanggal: string;
  channel?: string;
  customerName?: string | null;
  items: SaleItemInput[];
  discount?: number;
  accountId: number;
  note?: string | null;
  source: Exclude<Source, "system">;
}

const YMD = /^\d{4}-\d{2}-\d{2}$/;
const MAX_ITEMS = 50;
const MAX_QTY = 1_000_000;
const STAFF_VOID_WINDOW_MS = 24 * 60 * 60 * 1000;

function isProductItem(i: SaleItemInput): i is ProductItemInput {
  return "productId" in i;
}

function money(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_AMOUNT) throw new AppError("INVALID_AMOUNT", `${label} harus bilangan bulat rupiah ≥ 0.`);
}

export async function getSaleByUid(db: D1Database, uid: string): Promise<SaleWithItems | null> {
  const sale = await db.prepare("SELECT * FROM sales WHERE uid = ?1").bind(uid).first<Sale>();
  return sale ? withItems(db, sale) : null;
}

export async function getSale(db: D1Database, id: number): Promise<SaleWithItems | null> {
  const sale = await db.prepare("SELECT * FROM sales WHERE id = ?1").bind(id).first<Sale>();
  return sale ? withItems(db, sale) : null;
}

async function withItems(db: D1Database, sale: Sale, warnings: string[] = []): Promise<SaleWithItems> {
  const { results } = await db.prepare("SELECT * FROM sale_items WHERE sale_id = ?1 ORDER BY id").bind(sale.id).all<SaleItem>();
  return { ...sale, items: results, warnings };
}

function isUniqueSaleUid(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed: sales\.uid/i.test(e.message);
}

export async function createSale(db: D1Database, input: NewSaleInput, actor: Actor): Promise<SaleWithItems> {
  const uid = input.uid ?? newUid();
  const existing = await getSaleByUid(db, uid);
  if (existing) return existing;

  // ---- validasi ----
  const dateErr = txDateError(input.tanggal);
  if (dateErr) throw new AppError("INVALID_DATE", dateErr);
  if (input.items.length < 1 || input.items.length > MAX_ITEMS) throw new AppError("INVALID_ITEMS", `Penjualan harus berisi 1–${MAX_ITEMS} item.`);
  const discount = input.discount ?? 0;
  money(discount, "Diskon");
  const channel = (input.channel?.trim().toLowerCase() || "offline").slice(0, 30);
  const note = input.note?.trim().slice(0, 200) || null;
  const customer = input.customerName?.trim().slice(0, 80) || null;

  if (!(await getActiveChannel(db, channel))) throw new AppError("INVALID_CHANNEL", "Channel tidak dikenal atau sudah dihapus.");
  const account = await getAccount(db, input.accountId);
  if (!account || !account.is_active) throw new AppError("INVALID_ACCOUNT", "Akun kas tidak ditemukan.");

  const productIds = [...new Set(input.items.filter(isProductItem).map((i) => i.productId))];
  const products = new Map<number, Product>();
  if (productIds.length) {
    const { results } = await db
      .prepare(`SELECT * FROM products WHERE id IN (${productIds.map((_, i) => `?${i + 1}`).join(",")})`)
      .bind(...productIds)
      .all<Product>();
    for (const p of results) products.set(p.id, p);
  }

  let estSubtotal = 0;
  for (const it of input.items) {
    if (!Number.isSafeInteger(it.qty) || it.qty <= 0 || it.qty > MAX_QTY) throw new AppError("INVALID_QTY", "Jumlah (qty) harus bilangan bulat > 0.");
    if (isProductItem(it)) {
      const p = products.get(it.productId);
      if (!p || !p.is_active) throw new AppError("INVALID_PRODUCT", "Produk tidak ditemukan atau sudah nonaktif.");
      if (it.sellPrice !== undefined) money(it.sellPrice, "Harga jual");
      estSubtotal += it.qty * (it.sellPrice ?? p.sell_price);
    } else {
      const name = it.itemName.trim();
      if (name.length < 1 || name.length > 80) throw new AppError("INVALID_ITEM", "Nama item 1–80 karakter.");
      money(it.sellPrice, "Harga jual");
      money(it.costPrice ?? 0, "HPP");
      estSubtotal += it.qty * it.sellPrice;
    }
  }
  if (!Number.isSafeInteger(estSubtotal) || estSubtotal > MAX_AMOUNT) throw new AppError("INVALID_AMOUNT", "Total penjualan terlalu besar.");
  if (discount > estSubtotal) throw new AppError("INVALID_DISCOUNT", "Diskon tidak boleh melebihi subtotal.");

  const features = await getFeatures(db);
  const ymd = input.tanggal.replaceAll("-", "");
  const saleId = "(SELECT id FROM sales WHERE uid = ?1)";

  // ---- batch atomik ----
  const stmts: D1PreparedStatement[] = [
    // 1. header; invoice_no = INV-YYYYMMDD-NNNN berurutan per hari, dihitung di SQL
    db
      .prepare(
        `INSERT INTO sales (uid, invoice_no, tanggal, channel, customer_name, subtotal, discount, total, total_cost, account_id, source, note, created_by)
         SELECT ?1, 'INV-' || ?2 || '-' || printf('%04d', COALESCE(MAX(CAST(substr(invoice_no, 14) AS INTEGER)), 0) + 1),
                ?3, ?4, ?5, 0, ?6, 0, 0, ?7, ?8, ?9, ?10
         FROM sales WHERE tanggal = ?3`,
      )
      .bind(uid, ymd, input.tanggal, channel, customer, discount, account.id, input.source, note, actor.id),
  ];

  // 2. item (snapshot)
  for (const it of input.items) {
    if (isProductItem(it)) {
      stmts.push(
        db
          .prepare(
            `INSERT INTO sale_items (sale_id, product_id, item_name, qty, sell_price, cost_price, line_total)
             SELECT ${saleId}, p.id, p.name, ?2, COALESCE(?3, p.sell_price), p.cost_price, ?2 * COALESCE(?3, p.sell_price)
             FROM products p WHERE p.id = ?4`,
          )
          .bind(uid, it.qty, it.sellPrice ?? null, it.productId),
      );
    } else {
      stmts.push(
        db
          .prepare(
            `INSERT INTO sale_items (sale_id, product_id, item_name, qty, sell_price, cost_price, line_total)
             VALUES (${saleId}, NULL, ?2, ?3, ?4, ?5, ?3 * ?4)`,
          )
          .bind(uid, it.itemName.trim(), it.qty, it.sellPrice, it.costPrice ?? 0),
      );
    }
  }

  // 3. total dari item (subquery diulang: SET memakai nilai lama kolom lain)
  stmts.push(
    db
      .prepare(
        `UPDATE sales SET
           subtotal   = (SELECT COALESCE(SUM(line_total), 0) FROM sale_items WHERE sale_id = sales.id),
           total      = (SELECT COALESCE(SUM(line_total), 0) FROM sale_items WHERE sale_id = sales.id) - discount,
           total_cost = (SELECT COALESCE(SUM(qty * cost_price), 0) FROM sale_items WHERE sale_id = sales.id)
         WHERE uid = ?1`,
      )
      .bind(uid),
  );

  // 4. stok (hanya bila modul stok aktif)
  if (features.stock) {
    stmts.push(
      db
        .prepare(
          `INSERT INTO stock_movements (product_id, tanggal, type, qty_change, ref_type, ref_id, created_by)
           SELECT i.product_id, s.tanggal, 'sale', -i.qty, 'sale', s.id, ?2
           FROM sale_items i JOIN sales s ON s.id = i.sale_id JOIN products p ON p.id = i.product_id
           WHERE s.uid = ?1 AND p.track_stock = 1`,
        )
        .bind(uid, actor.id),
      db
        .prepare(
          `UPDATE products SET
             stock = stock - (SELECT SUM(i.qty) FROM sale_items i WHERE i.sale_id = ${saleId} AND i.product_id = products.id),
             updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
           WHERE track_stock = 1 AND id IN (SELECT product_id FROM sale_items WHERE sale_id = ${saleId})`,
        )
        .bind(uid),
    );
  }

  // 5. kas masuk otomatis (kategori sistem Penjualan); dilewati bila total 0
  stmts.push(
    db
      .prepare(
        `INSERT INTO cash_transactions (uid, tanggal, direction, amount, category_id, account_id, description, ref_type, ref_id, source, created_by)
         SELECT ?1 || ':cash', s.tanggal, 'in', s.total,
                (SELECT id FROM categories WHERE kind = 'sales' AND is_system = 1 ORDER BY id LIMIT 1),
                s.account_id, 'Penjualan ' || s.invoice_no, 'sale', s.id, 'system', ?2
         FROM sales s WHERE s.uid = ?1 AND s.total > 0`,
      )
      .bind(uid, actor.id),
  );

  // 6. audit
  stmts.push(
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT ?2, 'sale.create', 'sales', id, json_object('invoice_no', invoice_no, 'total', total, 'total_cost', total_cost, 'items', ?3)
         FROM sales WHERE uid = ?1`,
      )
      .bind(uid, actor.id, input.items.length),
  );

  try {
    await db.batch(stmts);
  } catch (e) {
    if (isUniqueSaleUid(e)) {
      const again = await getSaleByUid(db, uid);
      if (again) return again;
    }
    throw e;
  }

  const sale = (await getSaleByUid(db, uid))!;
  const warnings: string[] = [];
  if (features.stock) {
    const { results } = await db
      .prepare(
        `SELECT DISTINCT p.name, p.stock FROM sale_items i JOIN products p ON p.id = i.product_id
         WHERE i.sale_id = ?1 AND p.track_stock = 1 AND p.stock < 0`,
      )
      .bind(sale.id)
      .all<{ name: string; stock: number }>();
    for (const r of results) warnings.push(`Stok ${r.name} sekarang ${r.stock} (minus).`);
  }
  return { ...sale, warnings };
}

/**
 * Batalkan penjualan: status void, kas terkait di-void, stok dikembalikan sesuai mutasi
 * yang benar-benar tercatat (bukan flag fitur saat ini). Semua dalam satu batch.
 */
export async function voidSale(
  db: D1Database,
  id: number,
  reason: string,
  actor: Actor,
  opts: { now?: Date; voidDate: string },
): Promise<SaleWithItems> {
  const now = opts.now ?? new Date();
  const sale = await db.prepare("SELECT * FROM sales WHERE id = ?1").bind(id).first<Sale>();
  if (!sale) throw new AppError("NOT_FOUND", "Penjualan tidak ditemukan.", 404);
  if (sale.status === "void") throw new AppError("ALREADY_VOID", "Penjualan ini sudah dibatalkan.", 409);
  if (actor.role === "staff") {
    const age = now.getTime() - Date.parse(sale.created_at);
    if (sale.created_by !== actor.id || age > STAFF_VOID_WINDOW_MS) {
      throw new AppError("FORBIDDEN", "Staff hanya bisa membatalkan penjualannya sendiri dalam 24 jam.", 403);
    }
  }

  const cleanReason = reason.trim().slice(0, 200) || "Dibatalkan";
  const voidedAt = now.toISOString();
  // Langkah 2+ hanya berjalan bila langkah 1 benar-benar mem-void penjualan ini di batch ini.
  const mine = "EXISTS (SELECT 1 FROM sales WHERE id = ?1 AND status = 'void' AND voided_at = ?2 AND voided_by = ?3)";

  const results = await db.batch([
    db
      .prepare("UPDATE sales SET status = 'void', voided_at = ?2, voided_by = ?3, void_reason = ?4 WHERE id = ?1 AND status = 'posted'")
      .bind(id, voidedAt, actor.id, cleanReason),
    db
      .prepare(
        `UPDATE cash_transactions SET status = 'void', voided_at = ?2, voided_by = ?3, void_reason = ?4
         WHERE ref_type = 'sale' AND ref_id = ?1 AND status = 'posted' AND ${mine}`,
      )
      .bind(id, voidedAt, actor.id, cleanReason),
    db
      .prepare(
        `INSERT INTO stock_movements (product_id, tanggal, type, qty_change, ref_type, ref_id, note, created_by)
         SELECT product_id, ?4, 'sale_void', -qty_change, 'sale', ref_id, 'Void penjualan', ?3
         FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?1 AND type = 'sale' AND ${mine}`,
      )
      .bind(id, voidedAt, actor.id, opts.voidDate),
    db
      .prepare(
        `UPDATE products SET
           stock = stock - (SELECT SUM(m.qty_change) FROM stock_movements m
                            WHERE m.ref_type = 'sale' AND m.ref_id = ?1 AND m.type = 'sale' AND m.product_id = products.id),
           updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now')
         WHERE id IN (SELECT product_id FROM stock_movements WHERE ref_type = 'sale' AND ref_id = ?1 AND type = 'sale') AND ${mine}`,
      )
      .bind(id, voidedAt, actor.id),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT ?3, 'sale.void', 'sales', ?1, ?4 WHERE ${mine}`,
      )
      .bind(id, voidedAt, actor.id, JSON.stringify({ invoice_no: sale.invoice_no, reason: cleanReason })),
  ]);
  if ((results[0]!.meta.changes ?? 0) === 0) throw new AppError("ALREADY_VOID", "Penjualan ini sudah dibatalkan.", 409);
  return (await getSale(db, id))!;
}

// ---------------------------------------------------------------------------
// Daftar penjualan (Mini App)
// ---------------------------------------------------------------------------

export interface SaleListRow extends Sale {
  account_name: string | null;
  item_count: number;
  first_item: string | null;
}

export async function listSales(
  db: D1Database,
  f: { from: string; to: string; page?: number; limit?: number },
): Promise<{ items: SaleListRow[]; hasMore: boolean }> {
  if (!YMD.test(f.from) || !YMD.test(f.to)) throw new AppError("INVALID_DATE", "Format tanggal harus YYYY-MM-DD.");
  const limit = Math.min(f.limit ?? 50, 100);
  const offset = ((f.page ?? 1) - 1) * limit;
  const { results } = await db
    .prepare(
      `SELECT s.*, a.name AS account_name,
              (SELECT COUNT(*) FROM sale_items WHERE sale_id = s.id) AS item_count,
              (SELECT item_name FROM sale_items WHERE sale_id = s.id ORDER BY id LIMIT 1) AS first_item
       FROM sales s LEFT JOIN accounts a ON a.id = s.account_id
       WHERE s.status IN ('posted','void') AND s.tanggal BETWEEN ?1 AND ?2
       ORDER BY s.tanggal DESC, s.id DESC
       LIMIT ?3 OFFSET ?4`,
    )
    .bind(f.from, f.to, limit + 1, offset)
    .all<SaleListRow>();
  return { items: results.slice(0, limit), hasMore: results.length > limit };
}
