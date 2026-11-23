/** Isi file CSV ekspor laporan; dipakai /export di bot dan tombol Ekspor di Mini App. */
import { toCsv } from "../lib/csv";
import { EXPORT_ROW_LIMIT, exportCash, exportSales, profitLoss } from "./reports";

export interface ExportFile {
  name: string;
  content: string;
}

export interface ExportBundle {
  files: ExportFile[];
  truncated: boolean;
}

export async function buildExport(db: D1Database, from: string, to: string): Promise<ExportBundle> {
  const [sales, cash, pl] = await Promise.all([exportSales(db, from, to), exportCash(db, from, to), profitLoss(db, from, to)]);
  const suffix = from === to ? from : `${from}_${to}`;

  const plCsv = toCsv(
    ["Pos", "Nominal"],
    [
      ["Omzet", pl.omzet],
      ["HPP", pl.hpp],
      ["Laba kotor", pl.labaKotor],
      ["Pendapatan lain", pl.pendapatanLain],
      ...pl.biayaPerKategori.map((c) => [`Biaya: ${c.name}`, c.total]),
      ["Total biaya operasional", pl.biaya],
      ["Laba bersih", pl.labaBersih],
    ],
  );
  const salesCsv = toCsv(
    ["Tanggal", "Invoice", "Channel", "Item", "Qty", "Harga", "Subtotal item", "HPP/unit", "HPP item", "Diskon", "Total invoice", "Akun", "Catatan"],
    sales.map((r) => [r.tanggal, r.invoice_no, r.channel, r.item_name, r.qty, r.sell_price, r.line_total, r.cost_price, r.hpp, r.discount, r.total, r.akun, r.note]),
  );
  const cashCsv = toCsv(
    ["Tanggal", "Arah", "Kategori", "Jenis", "Akun", "Nominal", "Keterangan", "Sumber"],
    cash.map((r) => [r.tanggal, r.direction === "in" ? "Masuk" : "Keluar", r.kategori, r.jenis, r.akun, r.amount, r.description, r.ref_type]),
  );

  return {
    files: [
      { name: `labarugi_${suffix}.csv`, content: plCsv },
      { name: `penjualan_${suffix}.csv`, content: salesCsv },
      { name: `kas_${suffix}.csv`, content: cashCsv },
    ],
    truncated: sales.length >= EXPORT_ROW_LIMIT || cash.length >= EXPORT_ROW_LIMIT,
  };
}
