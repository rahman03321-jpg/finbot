/**
 * Simulasi acak (seed tetap): ratusan operasi lewat service — kas, penjualan, transfer, restock,
 * opname, pembatalan, ubah HPP — sebagian dijalankan bersamaan. Lalu setiap angka laporan dicocokkan
 * dengan perhitungan independen langsung dari data mentah, plus invarian integritas data.
 */
import { env } from "cloudflare:test";
import { beforeAll, describe, expect, it } from "vitest";
import { AppError } from "../worker/lib/errors";
import { addDays, wibDate } from "../worker/lib/date";
import {
  accountBalances,
  createCashTransaction,
  createTransfer,
  listManualCategories,
  voidCashTransaction,
  type Actor,
} from "../worker/services/cash";
import { addAccount } from "../worker/services/masters";
import { createProduct, updateProduct } from "../worker/services/products";
import { createSale, voidSale } from "../worker/services/sales";
import { createPurchase, voidPurchase } from "../worker/services/purchases";
import { setStockCount } from "../worker/services/stock";
import { cashByAccount, cashflow, daily, itemsSold, profitLoss, summary } from "../worker/services/reports";
import { setSetting } from "../worker/services/settings";
import { migrate } from "../worker/db/migrate";

// PRNG deterministik (mulberry32)
function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const owner: Actor = { id: 1, role: "owner" };
const admin: Actor = { id: 2, role: "admin" };
const staff: Actor = { id: 3, role: "staff" };
const TODAY = wibDate();
const START = addDays(TODAY, -60);

async function one<T>(sql: string, ...b: unknown[]): Promise<T> {
  return (await env.DB.prepare(sql).bind(...b).first<T>())!;
}
async function all<T>(sql: string, ...b: unknown[]): Promise<T[]> {
  return (await env.DB.prepare(sql).bind(...b).all<T>()).results;
}

const stats = { ops: 0, rejected: 0 } as Record<string, number>;

describe("simulasi acak + cocok silang angka", () => {
  beforeAll(async () => {
    await migrate(env.DB);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Owner', 'owner')"),
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (2, 222, 'Admin', 'admin')"),
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (3, 333, 'Staff', 'staff')"),
    ]);
    await setSetting(env.DB, "feature_stock", "1");
    await env.DB.prepare("UPDATE accounts SET opening_balance = 1000000 WHERE id = 1").run();
    await addAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 2_000_000 }, owner);
    await addAccount(env.DB, { name: "Dana", type: "ewallet", openingBalance: 0 }, owner);

    const R = rng(20261119);
    const pick = <T,>(xs: T[]): T => xs[Math.floor(R() * xs.length)]!;
    const int = (lo: number, hi: number) => lo + Math.floor(R() * (hi - lo + 1));
    const date = () => addDays(START, int(0, 60));
    const accounts = [1, 2, 3];
    const channels = ["offline", "shopee", "tokopedia", "whatsapp", "tiktok"];
    const catsIn = await listManualCategories(env.DB, "in");
    const catsOut = await listManualCategories(env.DB, "out");

    const products: number[] = [];
    for (const [name, cost, sell, track] of [
      ["Salep", 12_000, 20_000, true],
      ["Sabun", 3_000, 5_000, true],
      ["Masker", 8_000, 15_000, true],
      ["Serum", 45_000, 79_000, true],
      ["Jasa Konsultasi", 0, 50_000, false],
    ] as const) {
      const p = await createProduct(env.DB, { name, costPrice: cost, sellPrice: sell, trackStock: track, minStock: 5 }, owner);
      products.push(p.id);
      if (track) await setStockCount(env.DB, p.id, int(10, 40), { tanggal: START }, owner);
    }

    const sales: number[] = [];
    const cashIds: number[] = [];
    const purchases: number[] = [];

    const op = async (): Promise<void> => {
      const r = R();
      const actor = pick([owner, admin, staff, staff]);
      stats.ops!++;
      try {
        if (r < 0.32) {
          // penjualan produk / cepat
          const quick = R() < 0.3;
          const items = quick
            ? [{ itemName: "Penjualan cepat", qty: 1, sellPrice: int(10, 500) * 1000, costPrice: R() < 0.2 ? 0 : int(5, 200) * 1000 }]
            : Array.from({ length: int(1, 3) }, () => ({ productId: pick(products), qty: int(1, 5), ...(R() < 0.2 ? { sellPrice: int(5, 90) * 1000 } : {}) }));
          const s = await createSale(env.DB, { tanggal: date(), channel: pick(channels), items, discount: R() < 0.2 ? int(0, 5) * 1000 : 0, accountId: pick(accounts), source: "miniapp" }, actor);
          sales.push(s.id);
        } else if (r < 0.55) {
          const dir = R() < 0.4 ? "in" : "out";
          const c = pick(dir === "in" ? catsIn : catsOut);
          const tx = await createCashTransaction(env.DB, { tanggal: date(), direction: dir, amount: int(1, 3000) * 1000, categoryId: c.id, accountId: pick(accounts), source: "bot" }, actor);
          cashIds.push(tx.id);
        } else if (r < 0.63) {
          const from = pick(accounts);
          const to = pick(accounts.filter((a) => a !== from));
          const t = await createTransfer(env.DB, { tanggal: date(), amount: int(1, 1000) * 1000, fromAccountId: from, toAccountId: to, source: "miniapp" }, actor);
          cashIds.push(t.out.id);
        } else if (r < 0.71) {
          const p = await createPurchase(
            env.DB,
            {
              tanggal: date(),
              items: Array.from({ length: int(1, 2) }, () => ({ productId: pick(products), qty: int(1, 20), unitCost: int(1, 60) * 1000 })),
              accountId: pick(accounts),
              updateCost: pick(["average", "average", "last", "none"] as const),
              source: "miniapp",
            },
            actor,
          );
          purchases.push(p.id);
        } else if (r < 0.75) {
          await setStockCount(env.DB, pick(products.slice(0, 4)), int(0, 50), { tanggal: date(), note: "opname" }, actor);
        } else if (r < 0.78) {
          await updateProduct(env.DB, pick(products), { costPrice: int(1, 60) * 1000 }, actor);
        } else if (r < 0.88 && sales.length) {
          await voidSale(env.DB, pick(sales), "sim", actor, { voidDate: date() });
        } else if (r < 0.96 && cashIds.length) {
          await voidCashTransaction(env.DB, pick(cashIds), "sim", actor);
        } else if (purchases.length) {
          await voidPurchase(env.DB, pick(purchases), "sim", actor, { voidDate: date() });
        }
      } catch (e) {
        // Penolakan yang SAH (izin, sudah void, staff > 24 jam, dll.) boleh; selain itu = bug.
        if (!(e instanceof AppError)) throw e;
        stats.rejected!++;
        stats[e.code] = (stats[e.code] ?? 0) + 1;
      }
    };

    // 300 operasi berurutan + 20 gelombang × 5 operasi bersamaan
    for (let i = 0; i < 300; i++) await op();
    for (let w = 0; w < 20; w++) await Promise.all(Array.from({ length: 5 }, op));
  }, 120_000);

  it("simulasi benar-benar berjalan (bukan kosong)", async () => {
    const n = await one<{ s: number; c: number; p: number; v: number }>(
      `SELECT (SELECT COUNT(*) FROM sales) AS s, (SELECT COUNT(*) FROM cash_transactions) AS c,
              (SELECT COUNT(*) FROM purchases) AS p, (SELECT COUNT(*) FROM sales WHERE status='void') AS v`,
    );
    expect(n.s).toBeGreaterThan(80);
    expect(n.c).toBeGreaterThan(150);
    expect(n.p).toBeGreaterThan(5);
    expect(n.v).toBeGreaterThan(3);
    // Penolakan yang terjadi hanya jenis yang sah
    const unexpected = Object.keys(stats).filter((k) => !["ops", "rejected", "FORBIDDEN", "ALREADY_VOID", "USE_PARENT"].includes(k));
    expect(unexpected).toEqual([]);
  });

  it("header penjualan konsisten dengan item (subtotal, total, HPP, diskon)", async () => {
    const bad = await all(
      `SELECT s.id FROM sales s
       WHERE s.subtotal <> (SELECT SUM(line_total) FROM sale_items WHERE sale_id = s.id)
          OR s.total <> s.subtotal - s.discount
          OR s.total_cost <> (SELECT SUM(qty * cost_price) FROM sale_items WHERE sale_id = s.id)
          OR s.total < 0
          OR EXISTS (SELECT 1 FROM sale_items WHERE sale_id = s.id AND line_total <> qty * sell_price)`,
    );
    expect(bad).toEqual([]);
  });

  it("nomor invoice unik & berurutan tanpa celah per hari (termasuk saat bersamaan)", async () => {
    const days = await all<{ tanggal: string; n: number; mx: number; dist: number }>(
      `SELECT tanggal, COUNT(*) AS n, MAX(CAST(substr(invoice_no, 14) AS INTEGER)) AS mx, COUNT(DISTINCT invoice_no) AS dist
       FROM sales GROUP BY tanggal`,
    );
    for (const d of days) {
      expect(d.dist).toBe(d.n);
      expect(d.mx).toBe(d.n);
    }
  });

  it("setiap penjualan/pembelian punya tepat satu kas dengan status & nominal yang cocok", async () => {
    const sales = await all(
      `SELECT s.id FROM sales s
       WHERE (s.total > 0 AND (SELECT COUNT(*) FROM cash_transactions WHERE ref_type='sale' AND ref_id=s.id) <> 1)
          OR (s.total = 0 AND EXISTS (SELECT 1 FROM cash_transactions WHERE ref_type='sale' AND ref_id=s.id))
          OR EXISTS (SELECT 1 FROM cash_transactions t WHERE t.ref_type='sale' AND t.ref_id=s.id
                     AND (t.status <> s.status OR t.amount <> s.total OR t.direction <> 'in' OR t.account_id <> s.account_id))`,
    );
    expect(sales).toEqual([]);
    const pur = await all(
      `SELECT p.id FROM purchases p
       WHERE (SELECT COUNT(*) FROM cash_transactions WHERE ref_type='purchase' AND ref_id=p.id) <> CASE WHEN p.total > 0 THEN 1 ELSE 0 END
          OR EXISTS (SELECT 1 FROM cash_transactions t WHERE t.ref_type='purchase' AND t.ref_id=p.id
                     AND (t.status <> p.status OR t.amount <> p.total OR t.direction <> 'out'))`,
    );
    expect(pur).toEqual([]);
  });

  it("pasangan transfer selalu lengkap, saling merujuk, dan statusnya sama", async () => {
    const bad = await all(
      `SELECT t.id FROM cash_transactions t LEFT JOIN cash_transactions p ON p.id = t.ref_id
       WHERE t.ref_type = 'transfer'
         AND (p.id IS NULL OR p.ref_id <> t.id OR p.status <> t.status OR p.amount <> t.amount
              OR p.direction = t.direction OR p.account_id = t.account_id)`,
    );
    expect(bad).toEqual([]);
  });

  it("stok tiap produk = jumlah semua mutasinya; HPP produk = riwayat harga terakhir", async () => {
    const bad = await all(
      `SELECT p.id, p.stock, COALESCE((SELECT SUM(qty_change) FROM stock_movements WHERE product_id = p.id), 0) AS m
       FROM products p WHERE p.track_stock = 1 AND p.stock <> COALESCE((SELECT SUM(qty_change) FROM stock_movements WHERE product_id = p.id), 0)`,
    );
    expect(bad).toEqual([]);
    const jasa = await one<{ n: number }>("SELECT COUNT(*) AS n FROM stock_movements m JOIN products p ON p.id = m.product_id WHERE p.track_stock = 0");
    expect(jasa.n).toBe(0);
    const hpp = await all(
      `SELECT p.id FROM products p
       WHERE p.cost_price <> (SELECT cost_price FROM product_price_history WHERE product_id = p.id ORDER BY id DESC LIMIT 1)`,
    );
    expect(hpp).toEqual([]);
  });

  it("setiap transaksi tercatat di audit log", async () => {
    const a = await one<{ s: number; c: number; p: number; sv: number; svoid: number }>(
      `SELECT (SELECT COUNT(*) FROM audit_log WHERE action='sale.create') AS s,
              (SELECT COUNT(*) FROM sales) AS svoid,
              (SELECT COUNT(*) FROM audit_log WHERE action='sale.void') AS sv,
              (SELECT COUNT(*) FROM audit_log WHERE action='purchase.create') AS p,
              (SELECT COUNT(*) FROM audit_log WHERE action='cash.create') AS c`,
    );
    expect(a.s).toBe(a.svoid);
    expect(a.sv).toBe((await one<{ n: number }>("SELECT COUNT(*) AS n FROM sales WHERE status='void'")).n);
    expect(a.p).toBe((await one<{ n: number }>("SELECT COUNT(*) AS n FROM purchases")).n);
    expect(a.c).toBe((await one<{ n: number }>("SELECT COUNT(*) AS n FROM cash_transactions WHERE ref_type='manual'")).n);
  });

  it("saldo: semua cara menghitung memberi angka yang sama", async () => {
    const direct = await one<{ v: number }>(
      `SELECT (SELECT SUM(opening_balance) FROM accounts) +
              COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END) FROM cash_transactions WHERE status='posted'), 0) AS v`,
    );
    const bal = (await accountBalances(env.DB)).reduce((n, b) => n + b.balance, 0);
    const sum = await summary(env.DB, TODAY, { stock: true });
    const cba = await cashByAccount(env.DB, START, TODAY);
    const cf = await cashflow(env.DB, START, TODAY);
    expect(bal).toBe(direct.v);
    expect(sum.saldoKas).toBe(direct.v);
    expect(cba.totalSaldo).toBe(direct.v);
    expect(cf.totalSaldoAkhir).toBe(direct.v);
  });

  it("laporan per periode cocok dengan hitungan langsung dari data mentah", async () => {
    const R = rng(7);
    const ranges: [string, string][] = [
      [START, TODAY],
      [`${TODAY.slice(0, 8)}01`, TODAY],
      [START, addDays(START, 0)],
    ];
    for (let i = 0; i < 6; i++) {
      const a = addDays(START, Math.floor(R() * 60));
      const b = addDays(a, Math.floor(R() * 30));
      ranges.push([a, b > TODAY ? TODAY : b]);
    }

    for (const [from, to] of ranges) {
      const pl = await profitLoss(env.DB, from, to);
      const s = await one<{ omzet: number; hpp: number; diskon: number; n: number; gross: number }>(
        `SELECT COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(total_cost),0) AS hpp, COALESCE(SUM(discount),0) AS diskon, COUNT(*) AS n,
                COALESCE((SELECT SUM(i.line_total) FROM sale_items i JOIN sales x ON x.id = i.sale_id WHERE x.status='posted' AND x.tanggal BETWEEN ?1 AND ?2),0) AS gross
         FROM sales WHERE status='posted' AND tanggal BETWEEN ?1 AND ?2`,
        from,
        to,
      );
      const k = await one<{ biaya: number; lain: number }>(
        `SELECT COALESCE(SUM(CASE WHEN c.kind='expense' THEN t.amount END),0) AS biaya,
                COALESCE(SUM(CASE WHEN c.kind='other_income' THEN t.amount END),0) AS lain
         FROM cash_transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.status='posted' AND t.tanggal BETWEEN ?1 AND ?2`,
        from,
        to,
      );
      const ctx = `${from}..${to}`;
      expect([ctx, pl.omzet, pl.hpp, pl.diskon, pl.jmlTransaksi]).toEqual([ctx, s.omzet, s.hpp, s.diskon, s.n]);
      expect([ctx, pl.biaya, pl.pendapatanLain]).toEqual([ctx, k.biaya, k.lain]);
      expect(pl.labaBersih).toBe(s.omzet - s.hpp + k.lain - k.biaya);

      // Harian dijumlah = laba rugi
      const d = await daily(env.DB, from, to);
      const sumD = d.reduce(
        (acc, r) => ({ omzet: acc.omzet + r.omzet, hpp: acc.hpp + r.hpp, biaya: acc.biaya + r.biaya, laba: acc.laba + r.labaBersih }),
        { omzet: 0, hpp: 0, biaya: 0, laba: 0 },
      );
      expect([ctx, sumD.omzet, sumD.hpp, sumD.biaya, sumD.laba]).toEqual([ctx, pl.omzet, pl.hpp, pl.biaya, pl.labaBersih]);

      // Per item (sebelum diskon) = omzet + diskon
      const items = await itemsSold(env.DB, from, to, 10_000);
      expect([ctx, items.reduce((n, r) => n + r.omzet, 0)]).toEqual([ctx, s.gross]);
      expect(s.gross).toBe(pl.omzet + pl.diskon);

      // Arus kas per akun: awal + masuk − keluar = akhir; kategori menjumlah ke total
      const cf = await cashflow(env.DB, from, to);
      for (const a of cf.akun) expect(a.saldoAkhir).toBe(a.saldoAwal + a.masuk - a.keluar);
      expect(cf.masukPerKategori.reduce((n, c) => n + c.total, 0)).toBe(cf.totalMasuk);
      expect(cf.keluarPerKategori.reduce((n, c) => n + c.total, 0)).toBe(cf.totalKeluar);

      // Kartu per akun (tanpa transfer)
      const cba = await cashByAccount(env.DB, from, to);
      const nt = await one<{ i: number; o: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount END),0) AS i, COALESCE(SUM(CASE WHEN direction='out' THEN amount END),0) AS o
         FROM cash_transactions WHERE status='posted' AND ref_type <> 'transfer' AND tanggal BETWEEN ?1 AND ?2`,
        from,
        to,
      );
      expect([ctx, cba.totalMasuk, cba.totalKeluar]).toEqual([ctx, nt.i, nt.o]);
      expect(cba.akun.reduce((n, a) => n + a.masuk, 0)).toBe(cba.totalMasuk);
      expect(cba.totalSaldo).toBe(cf.totalSaldoAkhir);
      // Transfer tidak mengubah total kas
      const tr = await one<{ i: number; o: number }>(
        `SELECT COALESCE(SUM(CASE WHEN direction='in' THEN amount END),0) AS i, COALESCE(SUM(CASE WHEN direction='out' THEN amount END),0) AS o
         FROM cash_transactions WHERE status='posted' AND ref_type = 'transfer' AND tanggal BETWEEN ?1 AND ?2`,
        from,
        to,
      );
      expect(tr.i).toBe(tr.o);
    }
  });

  it("tidak ada data keuangan yang terhapus (hanya void)", async () => {
    const n = await one<{ sales: number; items: number; cash: number }>(
      `SELECT (SELECT MAX(id) FROM sales) - (SELECT COUNT(*) FROM sales) AS sales,
              (SELECT MAX(id) FROM sale_items) - (SELECT COUNT(*) FROM sale_items) AS items,
              (SELECT MAX(id) FROM cash_transactions) - (SELECT COUNT(*) FROM cash_transactions) AS cash`,
    );
    expect(n).toEqual({ sales: 0, items: 0, cash: 0 });
  });
});
