import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import type { Actor } from "../worker/services/cash";
import { accountBalances } from "../worker/services/cash";
import { createProduct, updateProduct, type Product } from "../worker/services/products";
import { createSale, voidSale } from "../worker/services/sales";
import { setSetting } from "../worker/services/settings";
import { useFreshDb } from "./helpers";

let owner: Actor;
let staff: Actor;
let salep: Product;
let sabun: Product;

async function addUser(tgId: number, role: string): Promise<Actor> {
  const r = await env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (?1, 'X', ?2) RETURNING id").bind(tgId, role).first<{ id: number }>();
  return { id: r!.id, role: role as Actor["role"] };
}

async function count(sql: string, ...binds: unknown[]): Promise<number> {
  const r = await env.DB.prepare(sql).bind(...binds).first<{ n: number }>();
  return r!.n;
}

const TUNAI = 1;
const DAY = "2026-11-17";

describe("services/products", () => {
  useFreshDb();
  beforeEach(async () => {
    owner = await addUser(1, "owner");
    staff = await addUser(2, "staff");
  });

  it("tambah: riwayat harga & audit; nama dobel ditolak; staff ditolak", async () => {
    const p = await createProduct(env.DB, { name: "Salep Kulit", costPrice: 12_000, sellPrice: 20_000 }, owner);
    expect(p).toMatchObject({ name: "Salep Kulit", cost_price: 12_000, sell_price: 20_000, is_active: 1 });
    expect(await count("SELECT COUNT(*) AS n FROM product_price_history WHERE product_id = ?1", p.id)).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.create' AND entity_id = ?1", p.id)).toBe(1);
    await expect(createProduct(env.DB, { name: "salep kulit", costPrice: 1, sellPrice: 2 }, owner)).rejects.toMatchObject({ code: "DUPLICATE" });
    await expect(createProduct(env.DB, { name: "Lain", costPrice: 1, sellPrice: 2 }, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("ubah harga: riwayat bertambah; tanpa perubahan tidak menulis apa pun", async () => {
    const p = await createProduct(env.DB, { name: "Salep", costPrice: 12_000, sellPrice: 20_000 }, owner);
    const u = await updateProduct(env.DB, p.id, { costPrice: 13_000 }, owner);
    expect(u).toMatchObject({ cost_price: 13_000, sell_price: 20_000 });
    expect(await count("SELECT COUNT(*) AS n FROM product_price_history WHERE product_id = ?1", p.id)).toBe(2);
    await updateProduct(env.DB, p.id, { costPrice: 13_000 }, owner);
    expect(await count("SELECT COUNT(*) AS n FROM product_price_history WHERE product_id = ?1", p.id)).toBe(2);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.update'")).toBe(1);
  });
});

describe("services/sales", () => {
  useFreshDb();
  beforeEach(async () => {
    owner = await addUser(1, "owner");
    staff = await addUser(2, "staff");
    salep = await createProduct(env.DB, { name: "Salep", costPrice: 12_000, sellPrice: 20_000 }, owner);
    sabun = await createProduct(env.DB, { name: "Sabun", costPrice: 3_000, sellPrice: 5_000 }, owner);
  });

  it("penjualan produk: snapshot HPP/harga, total, invoice, kas otomatis, audit", async () => {
    const s = await createSale(
      env.DB,
      { tanggal: DAY, items: [{ productId: salep.id, qty: 3 }, { productId: sabun.id, qty: 2, sellPrice: 4_500 }], discount: 4_000, accountId: TUNAI, source: "bot" },
      staff,
    );
    expect(s).toMatchObject({ invoice_no: "INV-20261117-0001", subtotal: 69_000, discount: 4_000, total: 65_000, total_cost: 42_000, status: "posted", channel: "offline" });
    expect(s.items.map((i) => [i.item_name, i.qty, i.sell_price, i.cost_price, i.line_total])).toEqual([
      ["Salep", 3, 20_000, 12_000, 60_000],
      ["Sabun", 2, 4_500, 3_000, 9_000],
    ]);
    const cash = await env.DB.prepare("SELECT direction, amount, ref_type, ref_id, source, category_id FROM cash_transactions").all();
    expect(cash.results).toEqual([{ direction: "in", amount: 65_000, ref_type: "sale", ref_id: s.id, source: "system", category_id: 1 }]);
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sale.create'")).toBe(1);
  });

  it("HPP diubah setelah penjualan: transaksi lama tetap memakai snapshot", async () => {
    const s = await createSale(env.DB, { tanggal: DAY, items: [{ productId: salep.id, qty: 1 }], accountId: TUNAI, source: "bot" }, owner);
    await updateProduct(env.DB, salep.id, { costPrice: 15_000, sellPrice: 25_000 }, owner);
    const row = await env.DB.prepare("SELECT total, total_cost FROM sales WHERE id = ?1").bind(s.id).first();
    expect(row).toEqual({ total: 20_000, total_cost: 12_000 });
    const s2 = await createSale(env.DB, { tanggal: DAY, items: [{ productId: salep.id, qty: 1 }], accountId: TUNAI, source: "bot" }, owner);
    expect(s2).toMatchObject({ total: 25_000, total_cost: 15_000 });
  });

  it("penjualan cepat tanpa produk", async () => {
    const s = await createSale(
      env.DB,
      { tanggal: DAY, channel: "Shopee", items: [{ itemName: "Penjualan cepat", qty: 1, sellPrice: 1_500_000, costPrice: 900_000 }], accountId: TUNAI, source: "bot" },
      owner,
    );
    expect(s).toMatchObject({ total: 1_500_000, total_cost: 900_000, channel: "shopee" });
    expect(s.items[0]).toMatchObject({ product_id: null, item_name: "Penjualan cepat" });
  });

  it("nomor invoice berurutan per hari dan mulai lagi di hari berikutnya", async () => {
    const mk = (tanggal: string) => createSale(env.DB, { tanggal, items: [{ productId: sabun.id, qty: 1 }], accountId: TUNAI, source: "bot" }, owner);
    expect((await mk(DAY)).invoice_no).toBe("INV-20261117-0001");
    expect((await mk(DAY)).invoice_no).toBe("INV-20261117-0002");
    expect((await mk("2026-11-18")).invoice_no).toBe("INV-20261118-0001");
    const parallel = await Promise.all([mk(DAY), mk(DAY), mk(DAY)]);
    expect(parallel.map((s) => s.invoice_no).sort()).toEqual(["INV-20261117-0003", "INV-20261117-0004", "INV-20261117-0005"]);
  });

  it("uid sama → tidak dobel", async () => {
    const input = { uid: "jual-1", tanggal: DAY, items: [{ productId: sabun.id, qty: 1 }], accountId: TUNAI, source: "bot" as const };
    const a = await createSale(env.DB, input, owner);
    const b = await createSale(env.DB, input, owner);
    expect(b.id).toBe(a.id);
    expect(await count("SELECT COUNT(*) AS n FROM sales")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cash_transactions")).toBe(1);
  });

  it("validasi: diskon > subtotal, produk tidak ada, qty 0, item kosong", async () => {
    const base = { tanggal: DAY, accountId: TUNAI, source: "bot" as const };
    await expect(createSale(env.DB, { ...base, items: [{ productId: sabun.id, qty: 1 }], discount: 6_000 }, owner)).rejects.toMatchObject({ code: "INVALID_DISCOUNT" });
    await expect(createSale(env.DB, { ...base, items: [{ productId: 9999, qty: 1 }] }, owner)).rejects.toMatchObject({ code: "INVALID_PRODUCT" });
    await expect(createSale(env.DB, { ...base, items: [{ productId: sabun.id, qty: 0 }] }, owner)).rejects.toMatchObject({ code: "INVALID_QTY" });
    await expect(createSale(env.DB, { ...base, items: [] }, owner)).rejects.toMatchObject({ code: "INVALID_ITEMS" });
    expect(await count("SELECT COUNT(*) AS n FROM sales")).toBe(0);
  });

  it("total 0 (gratis) → tidak ada kas", async () => {
    await createSale(env.DB, { tanggal: DAY, items: [{ productId: sabun.id, qty: 1, sellPrice: 0 }], accountId: TUNAI, source: "bot" }, owner);
    expect(await count("SELECT COUNT(*) AS n FROM sales")).toBe(1);
    expect(await count("SELECT COUNT(*) AS n FROM cash_transactions")).toBe(0);
  });

  it("modul stok mati: stok tidak berubah, tidak ada mutasi", async () => {
    await createSale(env.DB, { tanggal: DAY, items: [{ productId: salep.id, qty: 2 }], accountId: TUNAI, source: "bot" }, owner);
    expect(await count("SELECT stock AS n FROM products WHERE id = ?1", salep.id)).toBe(0);
    expect(await count("SELECT COUNT(*) AS n FROM stock_movements")).toBe(0);
  });

  it("modul stok aktif: stok berkurang, peringatan minus; void mengembalikan stok", async () => {
    await setSetting(env.DB, "feature_stock", "1");
    await env.DB.prepare("UPDATE products SET stock = 5 WHERE id = ?1").bind(salep.id).run();
    const s = await createSale(env.DB, { tanggal: DAY, items: [{ productId: salep.id, qty: 3 }, { productId: salep.id, qty: 4 }], accountId: TUNAI, source: "bot" }, owner);
    expect(await count("SELECT stock AS n FROM products WHERE id = ?1", salep.id)).toBe(-2);
    expect(s.warnings).toEqual(["Stok Salep sekarang -2 (minus)."]);
    expect(await count("SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'sale'")).toBe(2);

    await voidSale(env.DB, s.id, "salah", owner, { voidDate: DAY });
    expect(await count("SELECT stock AS n FROM products WHERE id = ?1", salep.id)).toBe(5);
    expect(await count("SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'sale_void'")).toBe(2);
  });

  it("void: penjualan & kas di-void, saldo kembali, tidak bisa dua kali, audit sekali", async () => {
    const s = await createSale(env.DB, { tanggal: DAY, items: [{ productId: salep.id, qty: 1 }], accountId: TUNAI, source: "bot" }, owner);
    expect((await accountBalances(env.DB))[0]!.balance).toBe(20_000);
    const v = await voidSale(env.DB, s.id, "batal", owner, { voidDate: DAY });
    expect(v).toMatchObject({ status: "void", void_reason: "batal", voided_by: owner.id });
    expect(await count("SELECT COUNT(*) AS n FROM cash_transactions WHERE status = 'void'")).toBe(1);
    expect((await accountBalances(env.DB))[0]!.balance).toBe(0);
    await expect(voidSale(env.DB, s.id, "lagi", owner, { voidDate: DAY })).rejects.toMatchObject({ code: "ALREADY_VOID" });
    expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'sale.void'")).toBe(1);
  });

  it("void: staff hanya miliknya < 24 jam", async () => {
    const milikOwner = await createSale(env.DB, { tanggal: DAY, items: [{ productId: sabun.id, qty: 1 }], accountId: TUNAI, source: "bot" }, owner);
    await expect(voidSale(env.DB, milikOwner.id, "x", staff, { voidDate: DAY })).rejects.toMatchObject({ code: "FORBIDDEN" });
    const milikStaff = await createSale(env.DB, { tanggal: DAY, items: [{ productId: sabun.id, qty: 1 }], accountId: TUNAI, source: "bot" }, staff);
    const lusa = new Date(Date.parse(milikStaff.created_at) + 25 * 3600_000);
    await expect(voidSale(env.DB, milikStaff.id, "x", staff, { voidDate: DAY, now: lusa })).rejects.toMatchObject({ code: "FORBIDDEN" });
    expect((await voidSale(env.DB, milikStaff.id, "x", staff, { voidDate: DAY })).status).toBe("void");
  });

  it("kas dari penjualan tidak bisa di-void langsung lewat kas", async () => {
    const { voidCashTransaction } = await import("../worker/services/cash");
    const s = await createSale(env.DB, { tanggal: DAY, items: [{ productId: sabun.id, qty: 1 }], accountId: TUNAI, source: "bot" }, owner);
    const cash = await env.DB.prepare("SELECT id FROM cash_transactions WHERE ref_id = ?1").bind(s.id).first<{ id: number }>();
    await expect(voidCashTransaction(env.DB, cash!.id, "x", owner)).rejects.toMatchObject({ code: "USE_PARENT" });
  });
});
