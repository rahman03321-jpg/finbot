/**
 * Modul stok (ARCHITECTURE.md §9.4): stok awal / opname, mutasi, stok menipis.
 * products.stock adalah cache; sumber kebenaran = stock_movements.
 * Semua fungsi di sini mensyaratkan feature_stock = '1'.
 */
import { AppError } from "../lib/errors";
import { txDateError } from "../lib/date";
import type { Actor } from "./cash";
import { requireStock } from "./features";
import type { Product } from "./products";

export interface StockMovement {
  id: number;
  product_id: number;
  tanggal: string;
  type: "sale" | "sale_void" | "purchase" | "purchase_void" | "adjustment" | "opening";
  qty_change: number;
  ref_type: string | null;
  ref_id: number | null;
  note: string | null;
  created_by_name: string | null;
  created_at: string;
}

const MAX_STOCK = 1_000_000_000;

function assertAdmin(actor: Actor): void {
  if (actor.role !== "owner" && actor.role !== "admin") throw new AppError("FORBIDDEN", "Hanya owner/admin yang bisa mengubah stok.", 403);
}

/**
 * Stok opname: set stok ke jumlah fisik sebenarnya. Selisihnya dicatat sebagai mutasi
 * 'opening' (bila produk belum punya mutasi sama sekali) atau 'adjustment'.
 * Selisih dihitung di SQL (bukan dari nilai yang dibaca JS) agar aman dari balapan.
 */
export async function setStockCount(
  db: D1Database,
  productId: number,
  actual: number,
  input: { tanggal: string; note?: string | null },
  actor: Actor,
): Promise<{ product: Product; change: number }> {
  assertAdmin(actor);
  await requireStock(db);
  if (!Number.isSafeInteger(actual) || Math.abs(actual) > MAX_STOCK) throw new AppError("INVALID_QTY", "Jumlah stok harus bilangan bulat.");
  const dateErr = txDateError(input.tanggal);
  if (dateErr) throw new AppError("INVALID_DATE", dateErr);
  const p = await db.prepare("SELECT * FROM products WHERE id = ?1 AND is_active = 1").bind(productId).first<Product>();
  if (!p) throw new AppError("NOT_FOUND", "Produk tidak ditemukan.", 404);
  if (!p.track_stock) throw new AppError("NOT_TRACKED", "Produk ini tidak dilacak stoknya (jasa). Aktifkan \"Lacak stok\" dulu.", 409);
  const note = input.note?.trim().slice(0, 200) || null;

  const r = await db.batch([
    db
      .prepare(
        `INSERT INTO stock_movements (product_id, tanggal, type, qty_change, ref_type, note, created_by)
         SELECT id, ?2,
                CASE WHEN EXISTS (SELECT 1 FROM stock_movements WHERE product_id = ?1) THEN 'adjustment' ELSE 'opening' END,
                ?3 - stock, 'adjustment', ?4, ?5
         FROM products WHERE id = ?1 AND ?3 <> stock`,
      )
      .bind(productId, input.tanggal, actual, note, actor.id),
    db.prepare("UPDATE products SET stock = ?2, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(productId, actual),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'stock.set', 'products', ?2, ?3)")
      .bind(actor.id, productId, JSON.stringify({ before: p.stock, after: actual, note })),
    db.prepare("SELECT * FROM products WHERE id = ?1").bind(productId),
  ]);
  return { product: r[3]!.results[0] as Product, change: actual - p.stock };
}

export async function listMovements(db: D1Database, productId: number, limit = 100): Promise<StockMovement[]> {
  await requireStock(db);
  const { results } = await db
    .prepare(
      `SELECT m.*, u.full_name AS created_by_name FROM stock_movements m LEFT JOIN users u ON u.id = m.created_by
       WHERE m.product_id = ?1 ORDER BY m.id DESC LIMIT ?2`,
    )
    .bind(productId, Math.min(limit, 500))
    .all<StockMovement>();
  return results;
}

export interface LowStockRow {
  id: number;
  name: string;
  unit: string;
  stock: number;
  min_stock: number;
}

/** Produk aktif yang dilacak dan stoknya ≤ minimum (stok 0 dengan minimum 0 = habis, ikut). */
export async function lowStock(db: D1Database, limit = 50): Promise<LowStockRow[]> {
  const { results } = await db
    .prepare(
      `SELECT id, name, unit, stock, min_stock FROM products
       WHERE is_active = 1 AND track_stock = 1 AND stock <= min_stock
       ORDER BY stock - min_stock, name LIMIT ?1`,
    )
    .bind(limit)
    .all<LowStockRow>();
  return results;
}
