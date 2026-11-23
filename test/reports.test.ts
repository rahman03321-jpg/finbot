import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { addDays, parsePeriod, periodRange } from "../worker/lib/date";
import { toCsv } from "../worker/lib/csv";
import { createAccount, createCashTransaction, createTransfer, voidCashTransaction, type Actor } from "../worker/services/cash";
import { createProduct } from "../worker/services/products";
import { createSale, voidSale } from "../worker/services/sales";
import { cashflow, daily, exportSales, itemsSold, profitLoss } from "../worker/services/reports";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { getWebhookSecret, setSetting } from "../worker/services/settings";
import { BOT_INFO, groupMessage, mockTelegram, privateMessage, useFreshDb } from "./helpers";

// Selasa, 17 Nov 2026 10:00 WIB
const NOW = new Date("2026-11-17T03:00:00Z");

describe("periode (WIB)", () => {
  it("kode siap pakai", () => {
    expect(periodRange("hari", NOW)).toMatchObject({ from: "2026-11-17", to: "2026-11-17" });
    expect(periodRange("kemarin", NOW)).toMatchObject({ from: "2026-11-16", to: "2026-11-16" });
    expect(periodRange("minggu", NOW)).toMatchObject({ from: "2026-11-16", to: "2026-11-17" }); // Senin–hari ini
    expect(periodRange("minggulalu", NOW)).toMatchObject({ from: "2026-11-09", to: "2026-11-15" });
    expect(periodRange("bulan", NOW)).toMatchObject({ from: "2026-11-01", to: "2026-11-17" });
    expect(periodRange("bulanlalu", NOW)).toMatchObject({ from: "2026-10-01", to: "2026-10-31" });
    expect(periodRange("bulanlalu", new Date("2026-03-10T03:00:00Z"))).toMatchObject({ from: "2026-02-01", to: "2026-02-28" });
    expect(periodRange("bulanlalu", new Date("2027-01-05T03:00:00Z"))).toMatchObject({ from: "2026-12-01", to: "2026-12-31" });
  });

  it("pukul 23:30 WIB hari Minggu masih minggu yang sama", () => {
    const minggu = new Date("2026-11-22T16:30:00Z"); // 22 Nov 23:30 WIB, Minggu
    expect(periodRange("minggu", minggu)).toMatchObject({ from: "2026-11-16", to: "2026-11-22" });
    const senin = new Date("2026-11-22T17:30:00Z"); // 23 Nov 00:30 WIB, Senin
    expect(periodRange("minggu", senin)).toMatchObject({ from: "2026-11-23", to: "2026-11-23" });
    expect(periodRange("minggulalu", senin)).toMatchObject({ from: "2026-11-16", to: "2026-11-22" });
  });

  it("parsePeriod: alias, tanggal tunggal, rentang, dan yang tidak valid", () => {
    expect(parsePeriod("", NOW)).toMatchObject({ code: "hari" });
    expect(parsePeriod("Bulan Lalu", NOW)).toMatchObject({ code: "bulanlalu" });
    expect(parsePeriod("minggu lalu", NOW)).toMatchObject({ code: "minggulalu" });
    expect(parsePeriod("17/11", NOW)).toMatchObject({ from: "2026-11-17", to: "2026-11-17" });
    expect(parsePeriod("1/11 15/11", NOW)).toMatchObject({ from: "2026-11-01", to: "2026-11-15" });
    expect(parsePeriod("1/11/2026 s.d. 15/11/2026", NOW)).toMatchObject({ from: "2026-11-01", to: "2026-11-15" });
    expect(parsePeriod("2026-11-01 - 2026-11-30", NOW)).toMatchObject({ from: "2026-11-01", to: "2026-11-30" });
    expect(parsePeriod("17-11-26", NOW)).toMatchObject({ from: "2026-11-17" });
    expect(parsePeriod("31/2", NOW)).toBeNull();
    expect(parsePeriod("15/11 1/11", NOW)).toBeNull();
    expect(parsePeriod("1/1/2025 1/1/2027", NOW)).toBeNull();
    expect(parsePeriod("tahun", NOW)).toBeNull();
    expect(addDays("2026-12-31", 1)).toBe("2027-01-01");
  });
});

describe("CSV", () => {
  it("pemisah ;, BOM, escape kutip/pemisah, cegah formula", () => {
    const csv = toCsv(["A", "B"], [["x;y", 'say "hi"'], ["=SUM(A1)", 1500]]);
    expect(csv.startsWith("﻿")).toBe(true);
    expect(csv).toBe('﻿A;B\r\n"x;y";"say ""hi"""\r\n\'=SUM(A1);1500\r\n');
  });
});

describe("laporan (angka cocok dengan hitungan manual)", () => {
  useFreshDb();
  let owner: Actor;

  beforeEach(async () => {
    const r = await env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (111, 'Budi', 'owner') RETURNING id").first<{ id: number }>();
    owner = { id: r!.id, role: "owner" };
    const bca = await createAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 1_000_000 }, owner);
    const salep = await createProduct(env.DB, { name: "Salep", costPrice: 12_000, sellPrice: 20_000 }, owner);
    const cat = async (n: string) => (await env.DB.prepare("SELECT id FROM categories WHERE name = ?1").bind(n).first<{ id: number }>())!.id;
    const cash = async (tanggal: string, direction: "in" | "out", amount: number, name: string, accountId = 1) =>
      createCashTransaction(env.DB, { tanggal, direction, amount, categoryId: await cat(name), accountId, source: "bot" }, owner);

    // --- Sebelum periode (31 Okt) ---
    await cash("2026-10-31", "in", 500_000, "Modal Masuk");
    await createSale(env.DB, { tanggal: "2026-10-31", items: [{ productId: salep.id, qty: 1 }], accountId: 1, source: "bot" }, owner);

    // --- Dalam periode (1–17 Nov) ---
    // 1 Nov: jual salep 3 (60.000, HPP 36.000) diskon 5.000 → omzet 55.000
    await createSale(env.DB, { tanggal: "2026-11-01", items: [{ productId: salep.id, qty: 3 }], discount: 5_000, accountId: 1, source: "bot" }, owner);
    // 5 Nov: penjualan cepat 1.500.000 HPP 900.000 ke BCA
    await createSale(env.DB, { tanggal: "2026-11-05", items: [{ itemName: "Penjualan cepat", qty: 1, sellPrice: 1_500_000, costPrice: 900_000 }], accountId: bca.id, source: "bot" }, owner);
    // 5 Nov: penjualan cepat tanpa HPP 100.000
    await createSale(env.DB, { tanggal: "2026-11-05", items: [{ itemName: "Penjualan cepat", qty: 1, sellPrice: 100_000 }], accountId: 1, source: "bot" }, owner);
    // 6 Nov: penjualan yang di-void (tidak dihitung)
    const batal = await createSale(env.DB, { tanggal: "2026-11-06", items: [{ productId: salep.id, qty: 10 }], accountId: 1, source: "bot" }, owner);
    await voidSale(env.DB, batal.id, "x", owner, { voidDate: "2026-11-06" });
    // Biaya: gaji 300.000 (tunai), ongkir 25.000 (tunai), iklan 50.000 (di-void)
    await cash("2026-11-02", "out", 300_000, "Gaji");
    await cash("2026-11-03", "out", 25_000, "Ongkir");
    const iklan = await cash("2026-11-03", "out", 50_000, "Iklan");
    await voidCashTransaction(env.DB, iklan.id, "x", owner);
    // Pendapatan lain 10.000; modal masuk 200.000 (bukan L/R); belanja stok 400.000 (bukan L/R); prive 100.000 (bukan L/R)
    await cash("2026-11-04", "in", 10_000, "Pendapatan Lain");
    await cash("2026-11-04", "in", 200_000, "Modal Masuk");
    await cash("2026-11-04", "out", 400_000, "Belanja Stok");
    await cash("2026-11-04", "out", 100_000, "Prive / Ambil Modal");
    // Transfer tunai → BCA 50.000 (bukan L/R, total kas tetap)
    await createTransfer(env.DB, { tanggal: "2026-11-07", amount: 50_000, fromAccountId: 1, toAccountId: bca.id, source: "bot" }, owner);

    // --- Setelah periode (18 Nov) ---
    await cash("2026-11-18", "out", 999_000, "Gaji");
  });

  it("laba rugi 1–17 Nov", async () => {
    const pl = await profitLoss(env.DB, "2026-11-01", "2026-11-17");
    // omzet = 55.000 + 1.500.000 + 100.000
    expect(pl.omzet).toBe(1_655_000);
    // hpp = 36.000 + 900.000 + 0
    expect(pl.hpp).toBe(936_000);
    expect(pl.diskon).toBe(5_000);
    expect(pl.jmlTransaksi).toBe(3);
    expect(pl.labaKotor).toBe(719_000);
    expect(pl.pendapatanLain).toBe(10_000);
    expect(pl.biaya).toBe(325_000);
    expect(pl.biayaPerKategori.map((c) => [c.name, c.total])).toEqual([["Gaji", 300_000], ["Ongkir", 25_000]]);
    expect(pl.labaBersih).toBe(719_000 + 10_000 - 325_000);
    expect(pl.penjualanTanpaHpp).toBe(1);
  });

  it("arus kas 1–17 Nov per akun", async () => {
    const cf = await cashflow(env.DB, "2026-11-01", "2026-11-17");
    const tunai = cf.akun.find((a) => a.name === "Tunai")!;
    const bca = cf.akun.find((a) => a.name === "BCA")!;
    // Tunai saldo awal: modal 500.000 + jual 20.000 (31 Okt)
    expect(tunai.saldoAwal).toBe(520_000);
    // Tunai masuk: 55.000 + 100.000 + 10.000 + 200.000 = 365.000
    expect(tunai.masuk).toBe(365_000);
    // Tunai keluar: 300.000 + 25.000 + 400.000 + 100.000 + 50.000 (transfer) = 875.000
    expect(tunai.keluar).toBe(875_000);
    expect(tunai.saldoAkhir).toBe(10_000);
    expect(bca).toMatchObject({ saldoAwal: 1_000_000, masuk: 1_550_000, keluar: 0, saldoAkhir: 2_550_000 });
    expect(cf.totalSaldoAkhir).toBe(2_560_000);
    expect(cf.keluarPerKategori.map((c) => c.name)).toContain("Transfer Keluar");
  });

  it("per hari & per item", async () => {
    const d = await daily(env.DB, "2026-11-01", "2026-11-17");
    expect(d.map((r) => r.tanggal)).toEqual(["2026-11-01", "2026-11-02", "2026-11-03", "2026-11-04", "2026-11-05"]);
    expect(d.find((r) => r.tanggal === "2026-11-05")).toMatchObject({ omzet: 1_600_000, hpp: 900_000, labaBersih: 700_000 });
    expect(d.find((r) => r.tanggal === "2026-11-04")).toMatchObject({ pendapatanLain: 10_000, biaya: 0, labaBersih: 10_000 });

    const items = await itemsSold(env.DB, "2026-11-01", "2026-11-17");
    expect(items.map((i) => [i.name, i.qty, i.omzet, i.hpp])).toEqual([
      ["Penjualan cepat", 2, 1_600_000, 900_000],
      ["Salep", 3, 60_000, 36_000],
    ]);
  });

  it("ekspor penjualan: satu baris per item, void tidak ikut", async () => {
    const rows = await exportSales(env.DB, "2026-11-01", "2026-11-17");
    expect(rows).toHaveLength(3);
    expect(rows[0]).toMatchObject({ invoice_no: "INV-20261101-0001", qty: 3, discount: 5_000, total: 55_000, hpp: 36_000 });
  });

  it("rentang tidak valid ditolak", async () => {
    await expect(profitLoss(env.DB, "2026-11-17", "2026-11-01")).rejects.toMatchObject({ code: "INVALID_RANGE" });
    await expect(profitLoss(env.DB, "2026-13-01", "2026-13-02")).rejects.toMatchObject({ code: "INVALID_DATE" });
  });
});

describe("bot: /laporan & /export", () => {
  useFreshDb();
  let secret = "";

  beforeEach(async () => {
    await setSetting(env.DB, "bot_info", JSON.stringify(BOT_INFO));
    secret = await getWebhookSecret(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (222, 'Sari', 'staff')"),
    ]);
    const owner = { id: 1, role: "owner" as const };
    const today = periodRange("hari").from;
    await createSale(env.DB, { tanggal: today, items: [{ itemName: "Penjualan cepat", qty: 1, sellPrice: 1_500_000, costPrice: 900_000 }], accountId: 1, source: "bot" }, owner);
    const gaji = (await env.DB.prepare("SELECT id FROM categories WHERE name='Gaji'").first<{ id: number }>())!.id;
    await createCashTransaction(env.DB, { tanggal: today, direction: "out", amount: 200_000, categoryId: gaji, accountId: 1, source: "bot" }, owner);
  });

  async function send(update: unknown) {
    const tg = mockTelegram();
    const req = new Request("https://finbot.contoh.workers.dev/webhook/tg", {
      method: "POST",
      body: JSON.stringify(update),
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    });
    await handleTelegramWebhook(req, env, { apiTransformer: tg.transformer });
    return tg;
  }
  const texts = (tg: ReturnType<typeof mockTelegram>) => tg.replies().join("\n---\n");

  it("owner di chat pribadi: lengkap dengan HPP & laba", async () => {
    const t = texts(await send(privateMessage(111, "/laporan")));
    expect(t).toContain("Laporan Hari ini");
    expect(t).toContain("Omzet: <b>Rp 1.500.000</b> · 1 transaksi");
    expect(t).toContain("HPP: Rp 900.000");
    expect(t).toContain("Laba kotor: <b>Rp 600.000</b> (40%)");
    expect(t).toContain("• Gaji: Rp 200.000");
    expect(t).toContain("Laba bersih: Rp 400.000");
    expect(t).toContain("Saldo akhir: <b>Rp 1.300.000</b>");
  });

  it("di grup: tanpa HPP & laba", async () => {
    const t = texts(await send(groupMessage(111, "/laporan bulan")));
    expect(t).toContain("Laporan Bulan ini");
    expect(t).toContain("Omzet: <b>Rp 1.500.000</b>");
    expect(t).not.toContain("HPP:");
    expect(t).not.toContain("Laba");
    expect(t).toContain("hanya ditampilkan untuk owner/admin di chat pribadi");
  });

  it("staff ditolak; periode salah diberi bantuan", async () => {
    expect(texts(await send(privateMessage(222, "/laporan", "Sari")))).toContain("hanya untuk owner/admin");
    expect(texts(await send(privateMessage(111, "/laporan tahun")))).toContain("Periode tidak dikenali");
  });

  it("/export → 1 PDF; /export bulan csv → 3 CSV; di grup ditolak", async () => {
    const names = (tg: ReturnType<typeof mockTelegram>) =>
      tg.calls.filter((c) => c.method === "sendDocument").map((c) => (c.payload["document"] as { filename?: string }).filename);
    const pdf = names(await send(privateMessage(111, "/export")));
    expect(pdf).toHaveLength(1);
    expect(pdf[0]).toMatch(/^laporan_\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.pdf$/);

    const docs = names(await send(privateMessage(111, "/export bulan csv")));
    expect(docs).toHaveLength(3);
    expect(docs[0]).toMatch(/^labarugi_\d{4}-\d{2}-01_\d{4}-\d{2}-\d{2}\.csv$/);
    expect(docs[1]).toMatch(/^penjualan_/);
    expect(docs[2]).toMatch(/^kas_/);

    const g = await send(groupMessage(111, "/export"));
    expect(g.calls.filter((c) => c.method === "sendDocument")).toHaveLength(0);
    expect(texts(g)).toContain("chat pribadi");
  });
});
