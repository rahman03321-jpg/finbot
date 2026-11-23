import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { accountBalances, createCashTransaction, listCategories, listManualCategories, type Actor } from "../worker/services/cash";
import {
  addAccount,
  createCategory,
  createChannel,
  deleteAccount,
  deleteCategory,
  deleteChannel,
  listChannels,
  updateAccount,
  updateCategory,
  updateChannel,
} from "../worker/services/masters";
import { createSale } from "../worker/services/sales";
import { cashflow, profitLoss } from "../worker/services/reports";
import { buildPdfReport } from "../worker/services/pdfReport";
import { fit, PdfDoc, textWidth } from "../worker/lib/pdf";
import { useFreshDb } from "./helpers";

const owner: Actor = { id: 1, role: "owner" };
const admin: Actor = { id: 2, role: "admin" };
const staff: Actor = { id: 3, role: "staff" };
const DAY = "2026-11-17";

async function auditCount(prefix: string): Promise<number> {
  return (await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action LIKE ?1").bind(`${prefix}%`).first<{ n: number }>())!.n;
}

describe("data master", () => {
  useFreshDb();
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (2, 222, 'Ani', 'admin')"),
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (3, 333, 'Sari', 'staff')"),
    ]);
  });

  describe("kategori", () => {
    it("tambah, ubah, hapus (nonaktif); jenis dipakai laporan", async () => {
      const sewa = await createCategory(env.DB, { name: "Sewa Tempat", direction: "out", kind: "expense" }, admin);
      expect(sewa).toMatchObject({ name: "Sewa Tempat", kind: "expense", is_active: 1, is_system: 0 });
      await createCashTransaction(env.DB, { tanggal: DAY, direction: "out", amount: 500_000, categoryId: sewa.id, accountId: 1, source: "miniapp" }, owner);
      expect((await profitLoss(env.DB, DAY, DAY)).biaya).toBe(500_000);

      // Ganti jenis → laporan ikut berubah (dicatat di audit)
      await updateCategory(env.DB, sewa.id, { name: "Sewa Ruko", kind: "capital_out" }, admin);
      expect((await profitLoss(env.DB, DAY, DAY)).biaya).toBe(0);

      await deleteCategory(env.DB, sewa.id, admin);
      expect((await listManualCategories(env.DB, "out")).map((c) => c.name)).not.toContain("Sewa Ruko");
      // Transaksi lama tetap ada di arus kas
      expect((await cashflow(env.DB, DAY, DAY)).keluarPerKategori.map((c) => c.name)).toContain("Sewa Ruko");
      expect(await auditCount("category.")).toBe(3);
    });

    it("nama dobel ditolak; nama yang pernah dihapus diaktifkan lagi", async () => {
      await expect(createCategory(env.DB, { name: "iklan", direction: "out", kind: "expense" }, owner)).rejects.toMatchObject({ code: "DUPLICATE" });
      const x = await createCategory(env.DB, { name: "Bensin", direction: "out", kind: "expense" }, owner);
      await deleteCategory(env.DB, x.id, owner);
      const again = await createCategory(env.DB, { name: "bensin", direction: "out", kind: "expense" }, owner);
      expect(again.id).toBe(x.id);
      expect(again.is_active).toBe(1);
    });

    it("bawaan: tidak bisa dihapus / diganti jenis; Penjualan & Transfer tidak bisa diubah; jenis harus sesuai arah; staff ditolak", async () => {
      const cats = await listCategories(env.DB);
      const modal = cats.find((c) => c.name === "Modal Masuk")!;
      const penjualan = cats.find((c) => c.kind === "sales")!;
      await expect(deleteCategory(env.DB, modal.id, owner)).rejects.toMatchObject({ code: "SYSTEM" });
      await expect(updateCategory(env.DB, modal.id, { kind: "other_income" }, owner)).rejects.toMatchObject({ code: "SYSTEM" });
      expect((await updateCategory(env.DB, modal.id, { name: "Setoran Modal" }, owner)).name).toBe("Setoran Modal");
      await expect(updateCategory(env.DB, penjualan.id, { name: "Jualan" }, owner)).rejects.toMatchObject({ code: "SYSTEM" });
      await expect(createCategory(env.DB, { name: "X", direction: "in", kind: "expense" }, owner)).rejects.toMatchObject({ code: "INVALID_KIND" });
      await expect(createCategory(env.DB, { name: "X", direction: "out", kind: "expense" }, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
    });
  });

  describe("akun kas", () => {
    it("tambah, ubah saldo awal, hapus hanya bila saldo 0", async () => {
      const bca = await addAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 1_000_000 }, owner);
      await updateAccount(env.DB, 1, { openingBalance: 250_000 }, owner); // saldo awal Tunai
      let bal = await accountBalances(env.DB);
      expect(bal.map((b) => [b.name, b.opening_balance, b.balance])).toEqual([
        ["Tunai", 250_000, 250_000],
        ["BCA", 1_000_000, 1_000_000],
      ]);

      await expect(deleteAccount(env.DB, bca.id, owner)).rejects.toMatchObject({ code: "NOT_EMPTY" });
      await updateAccount(env.DB, bca.id, { openingBalance: 0, name: "BCA Lama" }, owner);
      await deleteAccount(env.DB, bca.id, owner);
      bal = await accountBalances(env.DB);
      expect(bal.map((b) => b.name)).toEqual(["Tunai"]);
      await expect(deleteAccount(env.DB, 1, owner)).rejects.toMatchObject({ code: "LAST_ACCOUNT" });
      // create, ubah Tunai, ubah BCA, hapus BCA (penolakan tidak menulis audit)
      expect(await auditCount("account.")).toBe(4);
    });

    it("akun yang dihapus tetap tampil di arus kas periode yang punya transaksinya", async () => {
      const dana = await addAccount(env.DB, { name: "Dana", type: "ewallet", openingBalance: 0 }, owner);
      const modal = (await listCategories(env.DB)).find((c) => c.name === "Modal Masuk")!;
      const gaji = (await listCategories(env.DB)).find((c) => c.name === "Gaji")!;
      await createCashTransaction(env.DB, { tanggal: DAY, direction: "in", amount: 100_000, categoryId: modal.id, accountId: dana.id, source: "miniapp" }, owner);
      await createCashTransaction(env.DB, { tanggal: DAY, direction: "out", amount: 100_000, categoryId: gaji.id, accountId: dana.id, source: "miniapp" }, owner);
      await deleteAccount(env.DB, dana.id, owner);
      const cf = await cashflow(env.DB, DAY, DAY);
      expect(cf.akun.find((a) => a.name === "Dana")).toMatchObject({ masuk: 100_000, keluar: 100_000, saldoAkhir: 0 });
      expect(cf.totalMasuk).toBe(100_000);
    });

    it("hanya owner; nama dobel ditolak", async () => {
      await expect(addAccount(env.DB, { name: "BRI", type: "bank", openingBalance: 0 }, admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
      await expect(addAccount(env.DB, { name: "tunai", type: "cash", openingBalance: 0 }, owner)).rejects.toMatchObject({ code: "DUPLICATE" });
    });
  });

  describe("channel", () => {
    it("bawaan ada; tambah (code otomatis), ganti nama (code tetap), hapus; penjualan ke channel terhapus ditolak", async () => {
      const codes = (await listChannels(env.DB)).map((c) => c.code);
      expect(codes).toEqual(expect.arrayContaining(["offline", "shopee", "tokopedia", "whatsapp"]));

      const pp = await createChannel(env.DB, { name: "Pasar Pagi" }, admin);
      expect(pp).toMatchObject({ code: "pasarpagi", name: "Pasar Pagi" });
      const sale = await createSale(env.DB, { tanggal: DAY, channel: "pasarpagi", items: [{ itemName: "X", qty: 1, sellPrice: 10_000 }], accountId: 1, source: "miniapp" }, owner);
      expect(sale.channel).toBe("pasarpagi");

      const renamed = await updateChannel(env.DB, pp.id, { name: "Pasar Minggu" }, admin);
      expect(renamed.code).toBe("pasarpagi");

      await deleteChannel(env.DB, pp.id, admin);
      await expect(
        createSale(env.DB, { tanggal: DAY, channel: "pasarpagi", items: [{ itemName: "X", qty: 1, sellPrice: 10_000 }], accountId: 1, source: "miniapp" }, owner),
      ).rejects.toMatchObject({ code: "INVALID_CHANNEL" });

      const offline = (await listChannels(env.DB)).find((c) => c.code === "offline")!;
      await expect(deleteChannel(env.DB, offline.id, owner)).rejects.toMatchObject({ code: "SYSTEM" });
      await expect(createChannel(env.DB, { name: "shopee" }, owner)).rejects.toMatchObject({ code: "DUPLICATE" });
      await expect(createChannel(env.DB, { name: "Y" }, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
      expect(await auditCount("channel.")).toBe(3);
    });

    it("channel terhapus dengan kode sama diaktifkan lagi; yang masih aktif dianggap dobel", async () => {
      const a = await createChannel(env.DB, { name: "Toko A" }, owner);
      await deleteChannel(env.DB, a.id, owner);
      const b = await createChannel(env.DB, { name: "Toko-A" }, owner); // kode sama "tokoa" → aktifkan lagi
      expect(b).toMatchObject({ id: a.id, name: "Toko-A", is_active: 1 });
      await expect(createChannel(env.DB, { name: "Toko-A!" }, owner)).rejects.toMatchObject({ code: "DUPLICATE" });
    });
  });
});

describe("PDF", () => {
  useFreshDb();

  it("lebar teks Helvetica & pemotongan", () => {
    expect(textWidth("0123456789", 10)).toBeCloseTo(55.6, 1);
    expect(textWidth("1.250.000", 10, "bold")).toBeCloseTo(7 * 5.56 + 2 * 2.78, 1);
    const cut = fit("Nama produk yang sangat panjang sekali", 60, 9);
    expect(cut.endsWith("...")).toBe(true);
    expect(textWidth(cut, 9)).toBeLessThanOrEqual(60);
  });

  it("struktur PDF valid: header, xref, offset objek tepat, karakter non-ASCII aman", () => {
    const doc = new PdfDoc();
    const p = doc.addPage();
    doc.text(p, 40, 60, "Halo (dunia) \\ — café 🙂");
    doc.addPage();
    const bytes = doc.build({ title: "Uji" });
    const s = new TextDecoder("latin1").decode(bytes);
    expect(s.startsWith("%PDF-1.4")).toBe(true);
    expect(s.trimEnd().endsWith("%%EOF")).toBe(true);
    expect(s).toContain("/Count 2");
    expect(s).toContain("(Halo \\(dunia\\) \\\\ \\227 caf\\351 )");
    // setiap entri xref menunjuk ke "N 0 obj"
    const xrefAt = Number(/startxref\n(\d+)/.exec(s)![1]);
    const lines = s.slice(xrefAt).split("\n");
    const count = Number(lines[1]!.split(" ")[1]);
    for (let id = 1; id < count; id++) {
      const off = Number(lines[2 + id]!.slice(0, 10));
      expect(s.slice(off, off + `${id} 0 obj`.length)).toBe(`${id} 0 obj`);
    }
    // semua byte ASCII
    expect([...bytes].every((b) => b < 128)).toBe(true);
  });

  it("laporan lengkap: banyak halaman bila transaksi banyak", async () => {
    await env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')").run();
    const stmts = [];
    for (let i = 0; i < 120; i++) {
      stmts.push(createSale(env.DB, { tanggal: DAY, channel: "shopee", items: [{ itemName: `Item ${i % 7}`, qty: 1, sellPrice: 10_000 + i, costPrice: 6_000 }], accountId: 1, source: "miniapp" }, owner));
    }
    await Promise.all(stmts);
    const r = await buildPdfReport(env.DB, { from: DAY, to: DAY, label: "Hari ini" }, "17 Nov 2026 10:00 WIB");
    const s = new TextDecoder("latin1").decode(r.bytes);
    const pages = Number(/\/Count (\d+)/.exec(s)![1]);
    expect(pages).toBeGreaterThanOrEqual(3);
    expect(s).toContain("(Laba Rugi)");
    expect(s).toContain("(Daftar Penjualan)");
    expect(s).toContain(`(Halaman ${pages} dari ${pages})`);
    expect(r.filename).toBe("laporan_2026-11-17.pdf");
    expect(r.truncated).toBe(false);
  });
});
