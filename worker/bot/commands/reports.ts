/** /laporan & /export (ARCHITECTURE.md §8, §10). */
import { InputFile, type Api, type Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { html, rupiah, tanggalPendek } from "../format";
import { canSeeCost, guard, isAdmin } from "../drafts";
import { daysInclusive, parsePeriod, wibDateTimeLabel, type Period } from "../../lib/date";
import { buildExport } from "../../services/exports";
import { buildPdfReport } from "../../services/pdfReport";
import { cashflow, daily, itemsSold, profitLoss, EXPORT_ROW_LIMIT } from "../../services/reports";

const PERIOD_HELP = [
  "Periode: <code>hari</code> (default), <code>kemarin</code>, <code>minggu</code>, <code>minggu lalu</code>, <code>bulan</code>, <code>bulan lalu</code>,",
  "atau tanggal: <code>17/11</code>, <code>1/11 15/11</code>, <code>2026-11-01 2026-11-30</code> (maks 366 hari).",
].join("\n");

export function rangeLabel(p: Period): string {
  return p.from === p.to ? tanggalPendek(p.from) : `${tanggalPendek(p.from)} – ${tanggalPendek(p.to)}`;
}

function pct(part: number, whole: number): string {
  if (whole <= 0) return "";
  return ` (${Math.round((part * 100) / whole)}%)`;
}

/** Teks laporan ringkas. `withCost=false` → tanpa HPP/laba (grup). Diekspor untuk dipakai cron (Fase 5). */
export async function buildReport(db: D1Database, p: Period, withCost: boolean): Promise<string> {
  const [pl, cf, items, days] = await Promise.all([
    profitLoss(db, p.from, p.to),
    cashflow(db, p.from, p.to),
    itemsSold(db, p.from, p.to, 5),
    p.from !== p.to && daysInclusive(p.from, p.to) <= 14 ? daily(db, p.from, p.to) : Promise.resolve([]),
  ]);

  const out: string[] = [`📊 <b>Laporan ${html(p.label)}</b>`, `<i>${rangeLabel(p)}</i>`, ""];

  out.push(`Omzet: <b>${rupiah(pl.omzet)}</b> · ${pl.jmlTransaksi} transaksi`);
  if (pl.diskon > 0) out.push(`  (sudah dikurangi diskon ${rupiah(pl.diskon)})`);
  if (withCost) {
    out.push(`HPP: ${rupiah(pl.hpp)}`);
    out.push(`Laba kotor: <b>${rupiah(pl.labaKotor)}</b>${pct(pl.labaKotor, pl.omzet)}`);
    if (pl.pendapatanLain > 0) out.push(`Pendapatan lain: ${rupiah(pl.pendapatanLain)}`);
  }
  out.push(`Biaya operasional: ${rupiah(pl.biaya)}`);
  for (const c of pl.biayaPerKategori) out.push(`  • ${html(c.name)}: ${rupiah(c.total)}`);
  if (withCost) out.push(`<b>Laba bersih: ${rupiah(pl.labaBersih)}</b>`);

  out.push("", "💰 <b>Kas</b>");
  out.push(`Masuk: ${rupiah(cf.totalMasuk)} · Keluar: ${rupiah(cf.totalKeluar)}`);
  for (const a of cf.akun) out.push(`  • ${html(a.name)}: ${rupiah(a.saldoAkhir)}`);
  out.push(`Saldo akhir: <b>${rupiah(cf.totalSaldoAkhir)}</b>`);

  if (items.length) {
    out.push("", "🏆 <b>Terlaris</b>");
    items.forEach((i, n) => out.push(`${n + 1}. ${html(i.name)}: ${i.qty} · ${rupiah(i.omzet)}`));
  }

  if (days.length > 1) {
    out.push("", "📅 <b>Per hari</b>");
    for (const d of days) {
      const tail = withCost ? ` · laba ${rupiah(d.labaBersih)}` : "";
      out.push(`${tanggalPendek(d.tanggal)}: omzet ${rupiah(d.omzet)}${tail}`);
    }
  }

  const notes: string[] = [];
  if (withCost && pl.penjualanTanpaHpp > 0) {
    notes.push(`⚠️ ${pl.penjualanTanpaHpp} penjualan tanpa HPP, jadi laba bisa terlihat lebih besar dari sebenarnya.`);
  }
  if (!withCost) notes.push("<i>HPP & laba hanya ditampilkan untuk owner/admin di chat pribadi.</i>");
  if (notes.length) out.push("", ...notes);
  return out.join("\n");
}

async function laporan(ctx: BotContext): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply("Laporan hanya untuk owner/admin.");
    return;
  }
  const p = parsePeriod(typeof ctx.match === "string" ? ctx.match : "");
  if (!p) {
    await ctx.reply(`Periode tidak dikenali.\n\n${PERIOD_HELP}`, { parse_mode: "HTML" });
    return;
  }
  await ctx.reply(await buildReport(ctx.env.DB, p, canSeeCost(ctx)), { parse_mode: "HTML" });
}

function csvFile(content: string, name: string): InputFile {
  return new InputFile(new TextEncoder().encode(content), name);
}

async function exportCmd(ctx: BotContext): Promise<void> {
  if (!isAdmin(ctx)) {
    await ctx.reply("Ekspor hanya untuk owner/admin.");
    return;
  }
  if (ctx.chat?.type !== "private") {
    await ctx.reply("Ekspor berisi HPP & laba, jadi hanya dikirim lewat chat pribadi dengan bot.");
    return;
  }
  let arg = typeof ctx.match === "string" ? ctx.match.trim() : "";
  let format: ExportFormat = "pdf";
  const fm = /(?:^|\s)(pdf|csv)$/i.exec(arg);
  if (fm) {
    format = fm[1]!.toLowerCase() as ExportFormat;
    arg = arg.slice(0, fm.index).trim();
  }
  const p = parsePeriod(arg || "bulan"); // default ekspor: bulan ini
  if (!p) {
    await ctx.reply(
      `Periode tidak dikenali.\n\n${PERIOD_HELP}\n\nTambahkan <code>csv</code> di akhir untuk file spreadsheet, mis. <code>/export bulan csv</code>.`,
      { parse_mode: "HTML" },
    );
    return;
  }
  await sendExport(ctx.api, ctx.chat.id, ctx.env.DB, p, format);
}

export type ExportFormat = "pdf" | "csv";

/** Kirim laporan ke sebuah chat: 1 file PDF (default) atau 3 file CSV. Dipakai /export dan tombol di Mini App. */
export async function sendExport(api: Api, chatId: number, db: D1Database, p: Period, format: ExportFormat = "pdf"): Promise<void> {
  if (format === "pdf") {
    const r = await buildPdfReport(db, p, wibDateTimeLabel());
    await api.sendDocument(chatId, new InputFile(r.bytes, r.filename), {
      caption: `📄 Laporan keuangan ${p.label} (${rangeLabel(p)})`,
    });
    return;
  }
  const bundle = await buildExport(db, p.from, p.to);
  for (const [i, f] of bundle.files.entries()) {
    await api.sendDocument(
      chatId,
      csvFile(f.content, f.name),
      i === 0 ? { caption: `Laporan ${p.label} (${rangeLabel(p)}): laba rugi, penjualan, dan kas (CSV, pemisah titik koma).` } : {},
    );
  }
  if (bundle.truncated) {
    await api.sendMessage(chatId, `⚠️ Data terpotong di ${EXPORT_ROW_LIMIT} baris. Ekspor per periode yang lebih pendek.`);
  }
}

export function registerReports(bot: Bot<BotContext>): void {
  bot.command("laporan", (ctx) => guard(ctx, () => laporan(ctx)));
  bot.command("export", (ctx) => guard(ctx, () => exportCmd(ctx)));
}
