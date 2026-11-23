import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { addDays, txDateError, wibDate } from "../worker/lib/date";
import { createCashTransaction, type Actor } from "../worker/services/cash";
import { createProduct, deleteProduct, listProducts } from "../worker/services/products";
import { createSale } from "../worker/services/sales";
import { createPurchase } from "../worker/services/purchases";
import { setStockCount } from "../worker/services/stock";
import { setSetting } from "../worker/services/settings";
import { FAIL_DELAY_MS, MAX_FAILS_PER_HOUR } from "../worker/routes/setup";
import { useFreshDb } from "./helpers";

const owner: Actor = { id: 1, role: "owner" };
const staff: Actor = { id: 2, role: "staff" };
const TODAY = wibDate();
const TOMORROW = addDays(TODAY, 1);

describe("validasi tanggal transaksi", () => {
  it("txDateError", () => {
    const now = new Date("2026-11-19T03:00:00Z");
    expect(txDateError("2026-11-19", now)).toBeNull();
    expect(txDateError("2026-11-20", now)).toContain("melewati hari ini");
    expect(txDateError("2026-02-31", now)).toContain("tidak valid");
    expect(txDateError("19-11-2026", now)).toContain("tidak valid");
    expect(txDateError("1999-12-31", now)).toContain("terlalu lama");
  });

  describe("di service", () => {
    useFreshDb();
    beforeEach(async () => {
      await env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')").run();
      await setSetting(env.DB, "feature_stock", "1");
    });

    it("tanggal masa depan / tidak ada di kalender ditolak di kas, penjualan, restock, opname", async () => {
      const p = await createProduct(env.DB, { name: "Salep", costPrice: 1, sellPrice: 2 }, owner);
      for (const tanggal of [TOMORROW, "2026-02-30"]) {
        await expect(createCashTransaction(env.DB, { tanggal, direction: "out", amount: 1000, categoryId: 7, accountId: 1, source: "bot" }, owner)).rejects.toMatchObject({ code: "INVALID_DATE" });
        await expect(createSale(env.DB, { tanggal, items: [{ productId: p.id, qty: 1 }], accountId: 1, source: "bot" }, owner)).rejects.toMatchObject({ code: "INVALID_DATE" });
        await expect(createPurchase(env.DB, { tanggal, items: [{ productId: p.id, qty: 1, unitCost: 1 }], accountId: 1, source: "bot" }, owner)).rejects.toMatchObject({ code: "INVALID_DATE" });
        await expect(setStockCount(env.DB, p.id, 3, { tanggal }, owner)).rejects.toMatchObject({ code: "INVALID_DATE" });
      }
      const n = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM sales) + (SELECT COUNT(*) FROM cash_transactions) + (SELECT COUNT(*) FROM purchases) AS n").first<{ n: number }>();
      expect(n!.n).toBe(0);
      // hari ini tetap boleh
      await createSale(env.DB, { tanggal: TODAY, items: [{ productId: p.id, qty: 1 }], accountId: 1, source: "bot" }, owner);
    });
  });
});

describe("hapus produk", () => {
  useFreshDb();
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')").run();
  });

  it("produk dinonaktifkan: hilang dari daftar, penjualan lama utuh, tidak bisa dijual lagi, nama boleh dipakai ulang", async () => {
    const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000 }, owner);
    const s = await createSale(env.DB, { tanggal: TODAY, items: [{ productId: p.id, qty: 2 }], accountId: 1, source: "bot" }, owner);
    await expect(deleteProduct(env.DB, p.id, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await deleteProduct(env.DB, p.id, owner);
    expect((await listProducts(env.DB)).map((x) => x.name)).toEqual([]);
    const item = await env.DB.prepare("SELECT item_name, qty FROM sale_items WHERE sale_id = ?1").bind(s.id).first();
    expect(item).toEqual({ item_name: "Salep", qty: 2 });
    await expect(createSale(env.DB, { tanggal: TODAY, items: [{ productId: p.id, qty: 1 }], accountId: 1, source: "bot" }, owner)).rejects.toMatchObject({ code: "INVALID_PRODUCT" });
    await expect(deleteProduct(env.DB, p.id, owner)).rejects.toMatchObject({ code: "NOT_FOUND" });
    const again = await createProduct(env.DB, { name: "Salep", costPrice: 11_000, sellPrice: 21_000 }, owner);
    expect(again.id).not.toBe(p.id);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'product.delete'").first<{ n: number }>();
    expect(audit!.n).toBe(1);
  });
});

describe("/setup: pembatas tebakan password", () => {
  useFreshDb();
  const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
  const post = (key: string) =>
    worker.fetch(
      new Request("https://x.workers.dev/setup", { method: "POST", body: new URLSearchParams({ key }), headers: { "content-type": "application/x-www-form-urlencoded" } }),
      env,
      ctx,
    );

  it(`password salah diperlambat; setelah ${MAX_FAILS_PER_HOUR} kali salah dalam satu jam, dikunci (password benar pun ditolak)`, async () => {
    const t0 = Date.now();
    expect((await post("salah-salah-salah")).status).toBe(401);
    expect(Date.now() - t0).toBeGreaterThanOrEqual(FAIL_DELAY_MS - 50);

    const hour = new Date().toISOString().slice(0, 13);
    await env.DB.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('setup_fail', ?1)").bind(`${hour}|${MAX_FAILS_PER_HOUR - 1}`).run();
    expect((await post("salah-lagi-salah")).status).toBe(401);
    const locked = await post(env.SETUP_KEY!);
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Terlalu banyak percobaan");

    // jam berikutnya terbuka lagi
    await env.DB.prepare("UPDATE settings SET value = '2000-01-01T00|99' WHERE key = 'setup_fail'").run();
    expect((await post("salah-salah-salah")).status).toBe(401);
    const v = await env.DB.prepare("SELECT value FROM settings WHERE key = 'setup_fail'").first<{ value: string }>();
    expect(v!.value).toBe(`${hour}|1`);
  }, 20_000);
});
