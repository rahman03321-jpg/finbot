/**
 * Laporan keuangan PDF (A4) untuk satu periode: ringkasan, laba rugi, arus kas, penjualan per item,
 * rincian harian, daftar penjualan, dan daftar kas. Dipakai /export (bot) dan tombol di Mini App.
 */
import { A4, fit, PdfDoc, textWidth, type Font, type Rgb } from "../lib/pdf";
import { cashflow, daily, exportCash, exportSales, itemsSold, profitLoss } from "./reports";
import { getSetting } from "./settings";
import { listChannels } from "./masters";

const M = 40; // margin
const W = A4.width - M * 2;
const BOTTOM = A4.height - 48;
const INK: Rgb = [0.1, 0.11, 0.13];
const MUTED: Rgb = [0.42, 0.45, 0.5];
const POS: Rgb = [0.07, 0.48, 0.27];
const NEG: Rgb = [0.75, 0.2, 0.15];
const BAND: Rgb = [0.95, 0.96, 0.97];
const ACCENT: Rgb = [0.16, 0.42, 0.78];

const BULAN = ["Januari", "Februari", "Maret", "April", "Mei", "Juni", "Juli", "Agustus", "September", "Oktober", "November", "Desember"];
const BLN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

export const PDF_LIST_LIMIT = 1500;

function tglPanjang(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${Number(d)} ${BULAN[Number(m) - 1]} ${y}`;
}
function tglPendek(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(d)} ${BLN[Number(m) - 1]}`;
}
function num(n: number): string {
  const s = String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
  return n < 0 ? `-${s}` : s;
}
function rp(n: number): string {
  return n < 0 ? `-Rp ${num(-n)}` : `Rp ${num(n)}`;
}
function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part * 100) / whole)}%` : "-";
}

interface Col {
  title: string;
  width: number;
  align?: "left" | "right";
}
type Cell = string | { text: string; font?: Font; color?: Rgb };

class Layout {
  page = -1;
  y = 0;
  constructor(
    readonly doc: PdfDoc,
    private headerLeft: string,
    private headerRight: string,
  ) {}

  newPage(): void {
    this.page = this.doc.addPage();
    this.doc.text(this.page, M, 30, fit(this.headerLeft, W / 2, 8.5, "bold"), { font: "bold", size: 8.5, color: MUTED });
    this.doc.text(this.page, M + W, 30, this.headerRight, { size: 8.5, align: "right", color: MUTED });
    this.doc.line(this.page, M, 36, M + W, 36);
    this.y = 56;
  }

  ensure(h: number): void {
    if (this.page < 0 || this.y + h > BOTTOM) this.newPage();
  }

  heading(text: string, sub?: string): void {
    this.ensure(52);
    this.y += 16;
    this.doc.text(this.page, M, this.y, text, { font: "bold", size: 12.5, color: INK });
    if (sub) this.doc.text(this.page, M + W, this.y, sub, { size: 8.5, align: "right", color: MUTED });
    this.y += 12;
  }

  note(text: string, color: Rgb = MUTED): void {
    this.ensure(14);
    this.doc.text(this.page, M, this.y + 9, fit(text, W, 8.5), { size: 8.5, color });
    this.y += 14;
  }

  /** Tabel dengan header berulang di setiap halaman baru. */
  table(cols: Col[], rows: Cell[][], opts: { boldLast?: boolean; size?: number } = {}): void {
    const size = opts.size ?? 8.5;
    const rowH = size + 7;
    const header = () => {
      this.doc.rect(this.page, M, this.y, W, rowH + 1, BAND);
      let x = M;
      for (const c of cols) {
        const tx = c.align === "right" ? x + c.width - 4 : x + 4;
        this.doc.text(this.page, tx, this.y + size + 2.5, c.title, { font: "bold", size: size - 0.5, align: c.align === "right" ? "right" : "left", color: MUTED });
        x += c.width;
      }
      this.y += rowH + 1;
    };
    this.ensure(rowH * 3);
    header();
    rows.forEach((row, ri) => {
      if (this.y + rowH > BOTTOM) {
        this.newPage();
        header();
      }
      const last = opts.boldLast && ri === rows.length - 1;
      if (last) this.doc.line(this.page, M, this.y, M + W, this.y, 0.8, [0.6, 0.62, 0.66]);
      let x = M;
      cols.forEach((c, ci) => {
        const cell = row[ci] ?? "";
        const text = typeof cell === "string" ? cell : cell.text;
        const font: Font = last ? "bold" : typeof cell === "string" ? "regular" : (cell.font ?? "regular");
        const color = typeof cell === "string" ? INK : (cell.color ?? INK);
        const shown = fit(text, c.width - 8, size, font);
        const tx = c.align === "right" ? x + c.width - 4 : x + 4;
        this.doc.text(this.page, tx, this.y + size + 2.5, shown, { size, font, color, align: c.align === "right" ? "right" : "left" });
        x += c.width;
      });
      this.y += rowH;
      if (!last && ri < rows.length - 1) this.doc.line(this.page, M, this.y, M + W, this.y, 0.3, [0.9, 0.91, 0.93]);
    });
    this.y += 10;
  }
}

export interface PdfReport {
  bytes: Uint8Array;
  filename: string;
  truncated: boolean;
}

export async function buildPdfReport(
  db: D1Database,
  p: { from: string; to: string; label: string },
  generatedAt: string,
): Promise<PdfReport> {
  const [business, pl, cf, items, days, sales, cash, channels] = await Promise.all([
    getSetting(db, "business_name"),
    profitLoss(db, p.from, p.to),
    cashflow(db, p.from, p.to),
    itemsSold(db, p.from, p.to, 200),
    daily(db, p.from, p.to),
    exportSales(db, p.from, p.to),
    exportCash(db, p.from, p.to),
    listChannels(db, false),
  ]);
  const name = business ?? "Usaha Saya";
  const range = p.from === p.to ? tglPanjang(p.from) : `${tglPanjang(p.from)} - ${tglPanjang(p.to)}`;
  const chName = (code: string) => channels.find((c) => c.code === code)?.name ?? code;

  const doc = new PdfDoc();
  const L = new Layout(doc, name, `Laporan Keuangan · ${range}`);
  L.newPage();

  // --- Judul -----------------------------------------------------------------
  doc.text(L.page, M, L.y + 14, name, { font: "bold", size: 20, color: INK });
  doc.text(L.page, M, L.y + 34, `Laporan Keuangan ${p.label}`, { size: 12, color: ACCENT, font: "bold" });
  doc.text(L.page, M, L.y + 50, range, { size: 10, color: MUTED });
  L.y += 70;

  // --- Kartu ringkasan -------------------------------------------------------
  const cards: [string, number, Rgb][] = [
    ["Omzet", pl.omzet, INK],
    ["Laba kotor", pl.labaKotor, pl.labaKotor < 0 ? NEG : INK],
    ["Biaya operasional", pl.biaya, INK],
    ["Laba bersih", pl.labaBersih, pl.labaBersih < 0 ? NEG : POS],
  ];
  const gap = 8;
  const cw = (W - gap * 3) / 4;
  cards.forEach(([label, value, color], i) => {
    const x = M + i * (cw + gap);
    doc.rect(L.page, x, L.y, cw, 46, BAND);
    doc.text(L.page, x + 9, L.y + 15, label, { size: 8, color: MUTED });
    const v = rp(value);
    const size = textWidth(v, 12, "bold") > cw - 18 ? 10 : 12;
    doc.text(L.page, x + 9, L.y + 34, v, { size, font: "bold", color });
  });
  L.y += 56;
  L.note(`${pl.jmlTransaksi} transaksi penjualan · margin kotor ${pct(pl.labaKotor, pl.omzet)} · saldo kas akhir ${rp(cf.totalSaldoAkhir)}`);
  if (pl.penjualanTanpaHpp > 0) L.note(`Catatan: ${pl.penjualanTanpaHpp} penjualan tanpa HPP, jadi laba bisa terlihat lebih besar dari sebenarnya.`, NEG);

  // --- Laba rugi ---------------------------------------------------------------
  L.heading("Laba Rugi");
  const plRows: Cell[][] = [
    ["Omzet (penjualan bersih)", rp(pl.omzet)],
    ...(pl.diskon > 0 ? [[{ text: "   sudah dikurangi diskon", color: MUTED }, { text: rp(pl.diskon), color: MUTED }] as Cell[]] : []),
    ["Harga pokok penjualan (HPP)", rp(-pl.hpp)],
    [{ text: "Laba kotor", font: "bold" }, { text: rp(pl.labaKotor), font: "bold" }],
    ...pl.pendapatanLainPerKategori.map((c) => [`Pendapatan lain: ${c.name}`, rp(c.total)] as Cell[]),
    ...pl.biayaPerKategori.map((c) => [`Biaya: ${c.name}`, rp(-c.total)] as Cell[]),
    ["Laba bersih", rp(pl.labaBersih)],
  ];
  L.table(
    [
      { title: "Pos", width: W - 140 },
      { title: "Nominal", width: 140, align: "right" },
    ],
    plRows,
    { boldLast: true, size: 9.5 },
  );
  L.note("Modal masuk, belanja stok, prive, dan transfer antar akun tidak dihitung di laba rugi.");

  // --- Arus kas ----------------------------------------------------------------
  L.heading("Arus Kas per Akun");
  L.table(
    [
      { title: "Akun", width: 135 },
      { title: "Saldo awal", width: 95, align: "right" },
      { title: "Masuk", width: 95, align: "right" },
      { title: "Keluar", width: 95, align: "right" },
      { title: "Saldo akhir", width: 95, align: "right" },
    ],
    [
      ...cf.akun.map((a) => [a.name, num(a.saldoAwal), num(a.masuk), num(a.keluar), num(a.saldoAkhir)] as Cell[]),
      ["Total", num(cf.totalSaldoAwal), num(cf.totalMasuk), num(cf.totalKeluar), num(cf.totalSaldoAkhir)],
    ],
    { boldLast: true },
  );
  const catRows: Cell[][] = [
    ...cf.masukPerKategori.map((c) => [`Masuk: ${c.name}`, { text: num(c.total), color: POS }] as Cell[]),
    ...cf.keluarPerKategori.map((c) => [`Keluar: ${c.name}`, { text: num(-c.total), color: NEG }] as Cell[]),
  ];
  if (catRows.length) {
    L.table(
      [
        { title: "Kategori", width: W - 140 },
        { title: "Nominal (Rp)", width: 140, align: "right" },
      ],
      catRows,
    );
  }

  // --- Per item ----------------------------------------------------------------
  if (items.length) {
    L.heading("Penjualan per Item", "omzet sebelum diskon");
    L.table(
      [
        { title: "Item", width: 195 },
        { title: "Qty", width: 50, align: "right" },
        { title: "Omzet", width: 90, align: "right" },
        { title: "HPP", width: 90, align: "right" },
        { title: "Laba kotor", width: 90, align: "right" },
      ],
      items.map((i) => [i.name, num(i.qty), num(i.omzet), num(i.hpp), { text: num(i.labaKotor), color: i.labaKotor < 0 ? NEG : INK }]),
    );
  }

  // --- Harian ------------------------------------------------------------------
  if (days.length) {
    L.heading("Rincian Harian");
    L.table(
      [
        { title: "Tanggal", width: 95 },
        { title: "Omzet", width: 84, align: "right" },
        { title: "HPP", width: 84, align: "right" },
        { title: "Pend. lain", width: 84, align: "right" },
        { title: "Biaya", width: 84, align: "right" },
        { title: "Laba bersih", width: 84, align: "right" },
      ],
      [
        ...days.map((d) => [tglPendek(d.tanggal), num(d.omzet), num(d.hpp), num(d.pendapatanLain), num(d.biaya), { text: num(d.labaBersih), color: d.labaBersih < 0 ? NEG : INK }] as Cell[]),
        ["Total", num(pl.omzet), num(pl.hpp), num(pl.pendapatanLain), num(pl.biaya), num(pl.labaBersih)],
      ],
      { boldLast: true },
    );
  }

  // --- Daftar penjualan --------------------------------------------------------
  const saleRows = sales.slice(0, PDF_LIST_LIMIT);
  if (saleRows.length) {
    L.heading("Daftar Penjualan", `${new Set(sales.map((s) => s.invoice_no)).size} invoice`);
    L.table(
      [
        { title: "Tanggal", width: 48 },
        { title: "Invoice", width: 92 },
        { title: "Channel", width: 62 },
        { title: "Item", width: 133 },
        { title: "Qty", width: 30, align: "right" },
        { title: "Subtotal", width: 75, align: "right" },
        { title: "HPP", width: 75, align: "right" },
      ],
      saleRows.map((r) => [tglPendek(r.tanggal), r.invoice_no, chName(r.channel), r.item_name, num(r.qty), num(r.line_total), num(r.hpp)]),
      { size: 8 },
    );
  }

  // --- Daftar kas --------------------------------------------------------------
  const cashRows = cash.slice(0, PDF_LIST_LIMIT);
  if (cashRows.length) {
    L.heading("Daftar Transaksi Kas", `${cash.length} transaksi`);
    L.table(
      [
        { title: "Tanggal", width: 48 },
        { title: "Kategori", width: 105 },
        { title: "Akun", width: 70 },
        { title: "Keterangan", width: 142 },
        { title: "Masuk", width: 75, align: "right" },
        { title: "Keluar", width: 75, align: "right" },
      ],
      cashRows.map((r) => [
        tglPendek(r.tanggal),
        r.kategori,
        r.akun,
        r.description ?? "",
        r.direction === "in" ? { text: num(r.amount), color: POS } : "",
        r.direction === "out" ? { text: num(r.amount), color: NEG } : "",
      ]),
      { size: 8 },
    );
  }

  const truncated = sales.length > PDF_LIST_LIMIT || cash.length > PDF_LIST_LIMIT;
  if (truncated) L.note(`Daftar dipotong di ${PDF_LIST_LIMIT} baris. Ekspor periode yang lebih pendek untuk rincian lengkap.`, NEG);
  if (!pl.jmlTransaksi && !cash.length) L.note("Tidak ada transaksi di periode ini.");

  // --- Footer di semua halaman -------------------------------------------------
  const total = doc.pageCount;
  for (let i = 0; i < total; i++) {
    doc.line(i, M, A4.height - 34, M + W, A4.height - 34);
    doc.text(i, M, A4.height - 22, `Dibuat ${generatedAt} · Catetin`, { size: 7.5, color: MUTED });
    doc.text(i, M + W, A4.height - 22, `Halaman ${i + 1} dari ${total}`, { size: 7.5, color: MUTED, align: "right" });
  }

  const suffix = p.from === p.to ? p.from : `${p.from}_${p.to}`;
  return {
    bytes: doc.build({ title: `Laporan Keuangan ${name} ${range}`, author: name }),
    filename: `laporan_${suffix}.pdf`,
    truncated,
  };
}
