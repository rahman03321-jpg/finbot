/**
 * Master produk: HPP & harga jual (ARCHITECTURE.md §9.5).
 * Perubahan harga TIDAK mengubah transaksi lama (laporan memakai snapshot di sale_items).
 */
import { AppError } from "../lib/errors";
import { MAX_AMOUNT } from "../bot/parsers/amount";
import type { Actor } from "./cash";

export interface Product {
  id: number;
  sku: string | null;
  name: string;
  unit: string;
  cost_price: number;
  sell_price: number;
  stock: number;
  min_stock: number;
  track_stock: number;
  is_active: number;
  created_at: string;
  updated_at: string;
}

function assertAdmin(actor: Actor): void {
  if (actor.role !== "owner" && actor.role !== "admin") {
    throw new AppError("FORBIDDEN", "Hanya owner/admin yang bisa mengelola produk.", 403);
  }
}

function assertPrice(n: number, label: string): void {
  if (!Number.isSafeInteger(n) || n < 0 || n > MAX_AMOUNT) {
    throw new AppError("INVALID_PRICE", `${label} harus bilangan bulat rupiah ≥ 0.`);
  }
}

function cleanName(name: string): string {
  const n = name.trim().replace(/\s+/g, " ");
  if (n.length < 1 || n.length > 80) throw new AppError("INVALID_NAME", "Nama produk 1–80 karakter.");
  return n;
}

export async function getProduct(db: D1Database, id: number): Promise<Product | null> {
  return db.prepare("SELECT * FROM products WHERE id = ?1").bind(id).first<Product>();
}

export async function listProducts(db: D1Database, opts: { q?: string; activeOnly?: boolean } = {}): Promise<Product[]> {
  const activeOnly = opts.activeOnly ?? true;
  const q = opts.q?.trim();
  const { results } = await db
    .prepare(
      `SELECT * FROM products
       WHERE (?1 = 0 OR is_active = 1) AND (?2 IS NULL OR name LIKE '%' || ?2 || '%' OR sku = ?2)
       ORDER BY name COLLATE NOCASE LIMIT 200`,
    )
    .bind(activeOnly ? 1 : 0, q || null)
    .all<Product>();
  return results;
}

export interface NewProductInput {
  name: string;
  costPrice: number;
  sellPrice: number;
  unit?: string;
  sku?: string | null;
  trackStock?: boolean;
  minStock?: number;
}

export async function createProduct(db: D1Database, input: NewProductInput, actor: Actor): Promise<Product> {
  assertAdmin(actor);
  const name = cleanName(input.name);
  assertPrice(input.costPrice, "HPP");
  assertPrice(input.sellPrice, "Harga jual");
  const dup = await db.prepare("SELECT 1 FROM products WHERE name = ?1 COLLATE NOCASE AND is_active = 1").bind(name).first();
  if (dup) throw new AppError("DUPLICATE", `Produk "${name}" sudah ada.`, 409);

  const results = await db.batch([
    db
      .prepare(
        `INSERT INTO products (sku, name, unit, cost_price, sell_price, track_stock, min_stock)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)`,
      )
      .bind(input.sku?.trim() || null, name, input.unit?.trim() || "pcs", input.costPrice, input.sellPrice, input.trackStock === false ? 0 : 1, input.minStock ?? 0),
    db
      .prepare(
        `INSERT INTO product_price_history (product_id, cost_price, sell_price, reason, changed_by)
         VALUES (last_insert_rowid(), ?1, ?2, 'manual', ?3)`,
      )
      .bind(input.costPrice, input.sellPrice, actor.id),
    db
      .prepare(
        `INSERT INTO audit_log (user_id, action, entity, entity_id, payload)
         SELECT ?1, 'product.create', 'products', product_id, ?2 FROM product_price_history WHERE id = last_insert_rowid()`,
      )
      .bind(actor.id, JSON.stringify({ name, cost_price: input.costPrice, sell_price: input.sellPrice })),
    db.prepare("SELECT * FROM products WHERE id = (SELECT MAX(id) FROM products WHERE name = ?1)").bind(name),
  ]);
  return results[3]!.results[0] as Product;
}

export interface UpdateProductInput {
  name?: string;
  costPrice?: number;
  sellPrice?: number;
  unit?: string;
  trackStock?: boolean;
  minStock?: number;
}

/** Ubah nama/HPP/harga jual/satuan/lacak stok/stok minimum. Riwayat harga dicatat bila HPP atau harga berubah. */
export async function updateProduct(db: D1Database, id: number, input: UpdateProductInput, actor: Actor): Promise<Product> {
  assertAdmin(actor);
  const before = await getProduct(db, id);
  if (!before || !before.is_active) throw new AppError("NOT_FOUND", "Produk tidak ditemukan.", 404);

  const name = input.name !== undefined ? cleanName(input.name) : before.name;
  const cost = input.costPrice ?? before.cost_price;
  const sell = input.sellPrice ?? before.sell_price;
  assertPrice(cost, "HPP");
  assertPrice(sell, "Harga jual");
  if (name.toLowerCase() !== before.name.toLowerCase()) {
    const dup = await db.prepare("SELECT 1 FROM products WHERE name = ?1 COLLATE NOCASE AND is_active = 1 AND id <> ?2").bind(name, id).first();
    if (dup) throw new AppError("DUPLICATE", `Produk "${name}" sudah ada.`, 409);
  }

  const unit = input.unit !== undefined ? input.unit.trim().slice(0, 20) || "pcs" : before.unit;
  const track = input.trackStock === undefined ? before.track_stock : input.trackStock ? 1 : 0;
  const minStock = input.minStock ?? before.min_stock;
  if (!Number.isSafeInteger(minStock) || minStock < 0 || minStock > 1_000_000_000) throw new AppError("INVALID_QTY", "Stok minimum harus bilangan bulat ≥ 0.");

  const priceChanged = cost !== before.cost_price || sell !== before.sell_price;
  const otherChanged = name !== before.name || unit !== before.unit || track !== before.track_stock || minStock !== before.min_stock;
  if (!priceChanged && !otherChanged) return before;

  const stmts: D1PreparedStatement[] = [
    db
      .prepare(
        "UPDATE products SET name = ?2, cost_price = ?3, sell_price = ?4, unit = ?5, track_stock = ?6, min_stock = ?7, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1",
      )
      .bind(id, name, cost, sell, unit, track, minStock),
  ];
  if (priceChanged) {
    stmts.push(
      db
        .prepare("INSERT INTO product_price_history (product_id, cost_price, sell_price, reason, changed_by) VALUES (?1, ?2, ?3, 'manual', ?4)")
        .bind(id, cost, sell, actor.id),
    );
  }
  stmts.push(
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'product.update', 'products', ?2, ?3)")
      .bind(
        actor.id,
        id,
        JSON.stringify({
          before: { name: before.name, cost_price: before.cost_price, sell_price: before.sell_price, unit: before.unit, track_stock: before.track_stock, min_stock: before.min_stock },
          after: { name, cost_price: cost, sell_price: sell, unit, track_stock: track, min_stock: minStock },
        }),
      ),
  );
  stmts.push(db.prepare("SELECT * FROM products WHERE id = ?1").bind(id));
  const results = await db.batch(stmts);
  return results[results.length - 1]!.results[0] as Product;
}

/**
 * Hapus produk = nonaktifkan (penjualan & riwayat lama tetap merujuknya).
 * Produk nonaktif tidak muncul di daftar, /jual, maupun restock; namanya boleh dipakai lagi.
 */
export async function deleteProduct(db: D1Database, id: number, actor: Actor): Promise<void> {
  assertAdmin(actor);
  const p = await getProduct(db, id);
  if (!p || !p.is_active) throw new AppError("NOT_FOUND", "Produk tidak ditemukan.", 404);
  await db.batch([
    db.prepare("UPDATE products SET is_active = 0, updated_at = strftime('%Y-%m-%dT%H:%M:%fZ','now') WHERE id = ?1").bind(id),
    db
      .prepare("INSERT INTO audit_log (user_id, action, entity, entity_id, payload) VALUES (?1, 'product.delete', 'products', ?2, ?3)")
      .bind(actor.id, id, JSON.stringify({ name: p.name, stock: p.stock })),
  ]);
}
