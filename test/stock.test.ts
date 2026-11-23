import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Api } from "grammy/web";
import type { Actor } from "../worker/services/cash";
import { createProduct, getProduct, updateProduct } from "../worker/services/products";
import { lowStock, listMovements, setStockCount } from "../worker/services/stock";
import { createPurchase, voidPurchase } from "../worker/services/purchases";
import { createSale } from "../worker/services/sales";
import { cashflow, profitLoss } from "../worker/services/reports";
import { getWebhookSecret, setSetting, updateAppSettings } from "../worker/services/settings";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { runScheduled } from "../worker/bot/scheduled";
import { BOT_INFO, buttonsOf, callbackQuery, mockTelegram, privateMessage, useFreshDb } from "./helpers";

const owner: Actor = { id: 1, role: "owner" };
const staff: Actor = { id: 2, role: "staff" };
const DAY = "2026-11-17";

async function seedUsers() {
  await env.DB.batch([
    env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')"),
    env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (2, 222, 'Sari', 'staff')"),
  ]);
}

async function count(sql: string, ...b: unknown[]): Promise<number> {
  return (await env.DB.prepare(sql).bind(...b).first<{ n: number }>())!.n;
}

describe("modul stok (service)", () => {
  useFreshDb();
  beforeEach(seedUsers);

  it("modul mati → opname & restock ditolak; penjualan tidak menyentuh stok", async () => {
    const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000 }, owner);
    await expect(setStockCount(env.DB, p.id, 5, { tanggal: DAY }, owner)).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
    await expect(
      createPurchase(env.DB, { tanggal: DAY, items: [{ productId: p.id, qty: 1, unitCost: 1 }], accountId: 1, source: "miniapp" }, owner),
    ).rejects.toMatchObject({ code: "FEATURE_DISABLED" });
  });

  describe("modul aktif", () => {
    beforeEach(async () => {
      await setSetting(env.DB, "feature_stock", "1");
    });

    it("stok awal lalu opname: tipe mutasi 'opening' kemudian 'adjustment'; selisih dihitung benar", async () => {
      const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000 }, owner);
      const a = await setStockCount(env.DB, p.id, 10, { tanggal: DAY, note: "Stok awal" }, owner);
      expect(a).toMatchObject({ change: 10, product: { stock: 10 } });
      const b = await setStockCount(env.DB, p.id, 8, { tanggal: DAY, note: "rusak 2" }, owner);
      expect(b.change).toBe(-2);
      // jumlah sama → tidak ada mutasi baru
      await setStockCount(env.DB, p.id, 8, { tanggal: DAY }, owner);
      const moves = await listMovements(env.DB, p.id);
      expect(moves.map((m) => [m.type, m.qty_change])).toEqual([
        ["adjustment", -2],
        ["opening", 10],
      ]);
      await expect(setStockCount(env.DB, p.id, 1, { tanggal: DAY }, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });

    it("restock HPP rata-rata: (10×10.000 + 10×13.000)/20 = 11.500; stok, kas Belanja Stok, riwayat harga", async () => {
      const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000 }, owner);
      await setStockCount(env.DB, p.id, 10, { tanggal: DAY }, owner);
      const r = await createPurchase(
        env.DB,
        { tanggal: DAY, supplier: "Toko ABC", items: [{ productId: p.id, qty: 10, unitCost: 13_000 }], accountId: 1, updateCost: "average", source: "miniapp" },
        owner,
      );
      expect(r).toMatchObject({ total: 130_000, status: "posted", supplier: "Toko ABC" });
      expect(r.hppChanges).toEqual([{ product_id: p.id, name: "Salep", before: 10_000, after: 11_500 }]);
      expect(await getProduct(env.DB, p.id)).toMatchObject({ stock: 20, cost_price: 11_500 });

      const cash = await env.DB.prepare("SELECT c.kind, t.amount, t.direction, t.ref_type FROM cash_transactions t JOIN categories c ON c.id = t.category_id").first();
      expect(cash).toEqual({ kind: "stock_purchase", amount: 130_000, direction: "out", ref_type: "purchase" });
      expect(await count("SELECT COUNT(*) AS n FROM product_price_history WHERE product_id = ?1 AND reason = 'purchase'", p.id)).toBe(1);

      // Belanja stok tidak masuk laba rugi, tapi ada di arus kas
      expect((await profitLoss(env.DB, DAY, DAY)).biaya).toBe(0);
      expect((await cashflow(env.DB, DAY, DAY)).totalKeluar).toBe(130_000);

      // Penjualan berikutnya memakai HPP baru
      const s = await createSale(env.DB, { tanggal: DAY, items: [{ productId: p.id, qty: 2 }], accountId: 1, source: "miniapp" }, owner);
      expect(s.total_cost).toBe(23_000);
      expect((await getProduct(env.DB, p.id))!.stock).toBe(18);
    });

    it("stok 0 → HPP = harga beli; 'last' & 'none'; baris produk sama digabung", async () => {
      const a = await createProduct(env.DB, { name: "A", costPrice: 5_000, sellPrice: 9_000 }, owner);
      const b = await createProduct(env.DB, { name: "B", costPrice: 5_000, sellPrice: 9_000 }, owner);
      const c = await createProduct(env.DB, { name: "C", costPrice: 5_000, sellPrice: 9_000 }, owner);
      await setStockCount(env.DB, b.id, 4, { tanggal: DAY }, owner);
      await setStockCount(env.DB, c.id, 4, { tanggal: DAY }, owner);

      // stok A = 0 → rata-rata pembelian ini saja: (2×6.000 + 2×7.000)/4 = 6.500
      await createPurchase(env.DB, { tanggal: DAY, items: [{ productId: a.id, qty: 2, unitCost: 6_000 }, { productId: a.id, qty: 2, unitCost: 7_000 }], accountId: 1, source: "miniapp" }, owner);
      expect(await getProduct(env.DB, a.id)).toMatchObject({ cost_price: 6_500, stock: 4 });
      expect(await count("SELECT COUNT(*) AS n FROM stock_movements WHERE product_id = ?1 AND type = 'purchase'", a.id)).toBe(1);

      await createPurchase(env.DB, { tanggal: DAY, items: [{ productId: b.id, qty: 1, unitCost: 8_000 }], accountId: 1, updateCost: "last", source: "miniapp" }, owner);
      expect((await getProduct(env.DB, b.id))!.cost_price).toBe(8_000);

      await createPurchase(env.DB, { tanggal: DAY, items: [{ productId: c.id, qty: 1, unitCost: 8_000 }], accountId: 1, updateCost: "none", source: "miniapp" }, owner);
      expect(await getProduct(env.DB, c.id)).toMatchObject({ cost_price: 5_000, stock: 5 });
    });

    it("produk tanpa lacak stok: tidak ada mutasi, HPP tetap diperbarui", async () => {
      const jasa = await createProduct(env.DB, { name: "Jasa Pasang", costPrice: 0, sellPrice: 50_000, trackStock: false }, owner);
      await createPurchase(env.DB, { tanggal: DAY, items: [{ productId: jasa.id, qty: 1, unitCost: 15_000 }], accountId: 1, source: "miniapp" }, owner);
      expect(await getProduct(env.DB, jasa.id)).toMatchObject({ stock: 0, cost_price: 15_000 });
      expect(await count("SELECT COUNT(*) AS n FROM stock_movements")).toBe(0);
      await expect(setStockCount(env.DB, jasa.id, 3, { tanggal: DAY }, owner)).rejects.toMatchObject({ code: "NOT_TRACKED" });
    });

    it("void pembelian: stok kembali, kas di-void, HPP tidak berubah + peringatan; tidak bisa dua kali", async () => {
      const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000 }, owner);
      await setStockCount(env.DB, p.id, 10, { tanggal: DAY }, owner);
      const r = await createPurchase(env.DB, { tanggal: DAY, items: [{ productId: p.id, qty: 10, unitCost: 13_000 }], accountId: 1, source: "miniapp" }, owner);
      const v = await voidPurchase(env.DB, r.id, "salah input", owner, { voidDate: DAY });
      expect(v.status).toBe("void");
      expect(v.warnings[0]).toContain("HPP produk tidak dihitung ulang");
      expect(await getProduct(env.DB, p.id)).toMatchObject({ stock: 10, cost_price: 11_500 });
      expect(await count("SELECT COUNT(*) AS n FROM cash_transactions WHERE status = 'void'")).toBe(1);
      expect(await count("SELECT COUNT(*) AS n FROM stock_movements WHERE type = 'purchase_void'")).toBe(1);
      await expect(voidPurchase(env.DB, r.id, "x", owner, { voidDate: DAY })).rejects.toMatchObject({ code: "ALREADY_VOID" });
      expect(await count("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'purchase.void'")).toBe(1);
    });

    it("staff tidak bisa restock; uid sama tidak dobel; stok menipis terdeteksi", async () => {
      const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000, minStock: 5 }, owner);
      await expect(
        createPurchase(env.DB, { tanggal: DAY, items: [{ productId: p.id, qty: 1, unitCost: 1 }], accountId: 1, source: "miniapp" }, staff),
      ).rejects.toMatchObject({ code: "FORBIDDEN" });
      const input = { uid: "restock-1", tanggal: DAY, items: [{ productId: p.id, qty: 3, unitCost: 10_000 }], accountId: 1, source: "miniapp" as const };
      const a = await createPurchase(env.DB, input, owner);
      const b = await createPurchase(env.DB, input, owner);
      expect(b.id).toBe(a.id);
      expect((await getProduct(env.DB, p.id))!.stock).toBe(3);
      expect((await lowStock(env.DB)).map((x) => [x.name, x.stock, x.min_stock])).toEqual([["Salep", 3, 5]]);

      await updateProduct(env.DB, p.id, { minStock: 2 }, owner);
      expect(await lowStock(env.DB)).toEqual([]);
    });

    it("modul dimatikan lagi: data tetap, penjualan berhenti menulis mutasi", async () => {
      const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000 }, owner);
      await setStockCount(env.DB, p.id, 10, { tanggal: DAY }, owner);
      await updateAppSettings(env.DB, { feature_stock: false }, owner);
      await createSale(env.DB, { tanggal: DAY, items: [{ productId: p.id, qty: 2 }], accountId: 1, source: "miniapp" }, owner);
      expect((await getProduct(env.DB, p.id))!.stock).toBe(10);
      expect(await count("SELECT COUNT(*) AS n FROM stock_movements")).toBe(1);
    });
  });
});

describe("modul stok (bot & cron)", () => {
  useFreshDb();
  let secret = "";
  beforeEach(async () => {
    await seedUsers();
    await setSetting(env.DB, "bot_info", JSON.stringify(BOT_INFO));
    secret = await getWebhookSecret(env);
  });

  async function send(update: unknown) {
    const tg = mockTelegram();
    await handleTelegramWebhook(
      new Request("https://x.workers.dev/webhook/tg", { method: "POST", body: JSON.stringify(update), headers: { "X-Telegram-Bot-Api-Secret-Token": secret } }),
      env,
      { apiTransformer: tg.transformer },
    );
    return tg;
  }
  const last = (tg: ReturnType<typeof mockTelegram>) => {
    const c = [...tg.calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText")!;
    return { text: String(c.payload["text"]), buttons: buttonsOf(c.payload) };
  };

  it("modul mati → /stok & /restock memberi petunjuk", async () => {
    expect(last(await send(privateMessage(111, "/stok"))).text).toContain("belum diaktifkan");
    expect(last(await send(privateMessage(111, "/restock salep 10 12rb"))).text).toContain("belum diaktifkan");
  });

  it("/restock salep 10 12rb → ringkasan (stok & HPP) → Simpan → /stok", async () => {
    await setSetting(env.DB, "feature_stock", "1");
    const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000, minStock: 25 }, owner);
    await setStockCount(env.DB, p.id, 10, { tanggal: DAY }, owner);

    const t1 = await send(privateMessage(111, "/restock salep 10 12rb toko abc"));
    const d = last(t1);
    expect(d.text).toContain("10 pcs × Rp 12.000 = <b>Rp 120.000</b>");
    expect(d.text).toContain("Stok: 10 → <b>20</b>");
    expect(d.text).toContain("HPP rata-rata: Rp 10.000 → <b>Rp 11.000</b>");
    expect(d.text).toContain("Supplier: toko abc");

    const save = d.buttons.find((b) => b.text.includes("Simpan"))!.data;
    const t2 = await send(callbackQuery(111, save));
    expect(last(t2).text).toContain("Restock</b> tersimpan");
    expect(await getProduct(env.DB, p.id)).toMatchObject({ stock: 20, cost_price: 11_000 });

    const s = last(await send(privateMessage(222, "/stok", "Sari"))).text;
    expect(s).toContain("Salep: <b>20</b> pcs ⚠️ (min 25)");
    expect(last(await send(privateMessage(222, "/restock salep 1 1rb", "Sari"))).text).toContain("Hanya owner/admin");
  });

  it("cron: peringatan stok menipis sekali sehari ke owner", async () => {
    await setSetting(env.DB, "feature_stock", "1");
    const p = await createProduct(env.DB, { name: "Salep", costPrice: 10_000, sellPrice: 20_000, minStock: 5 }, owner);
    await setStockCount(env.DB, p.id, 2, { tanggal: DAY }, owner);
    await updateAppSettings(env.DB, { daily_report_enabled: false }, owner);
    const at = new Date("2026-11-18T14:05:00Z"); // Rabu 21:05 WIB
    const tg = mockTelegram();
    const api = new Api(env.BOT_TOKEN);
    api.config.use(tg.transformer);
    expect((await runScheduled(env, api, at)).sent).toEqual(["lowstock"]);
    const msg = tg.calls.find((c) => c.method === "sendMessage")!;
    expect(msg.payload["chat_id"]).toBe(111);
    expect(String(msg.payload["text"])).toContain("Salep: <b>2</b> pcs (min 5)");
    expect((await runScheduled(env, api, new Date(at.getTime() + 600_000))).sent).toEqual([]);
  });
});
