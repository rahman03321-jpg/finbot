/**
 * Cron tiap jam (ARCHITECTURE.md §13). Pada jam laporan (WIB):
 *  - harian  : ringkasan hari ini
 *  - Senin   : ringkasan minggu lalu + perbandingan dengan minggu sebelumnya
 *  - tanggal 1: ringkasan bulan lalu + perbandingan + file PDF ke owner
 *  - modul stok aktif: peringatan stok menipis ke owner (maks 1x/hari)
 * Tiap jenis laporan "diklaim" dulu lewat settings.last_<jenis>_report_date sehingga
 * tidak pernah terkirim dua kali di hari yang sama, walau cron terpanggil ulang.
 */
import { InputFile, type Api } from "grammy/web";
import type { Env } from "../env";
import { addDays, periodRange, wibDate, wibDateTimeLabel, wibDayOfMonth, wibHour, wibIsoWeekday, type Period } from "../lib/date";
import { getAppSettings } from "../services/settings";
import { profitLoss } from "../services/reports";
import { buildPdfReport } from "../services/pdfReport";
import { cleanup } from "../services/maintenance";
import { getFeatures } from "../services/features";
import { lowStock } from "../services/stock";
import { buildReport } from "./commands/reports";
import { html, rupiah } from "./format";

export type ReportKind = "daily" | "weekly" | "monthly" | "lowstock";

const TITLE: Record<Exclude<ReportKind, "lowstock">, string> = {
  daily: "🗓 <b>Laporan harian otomatis</b>",
  weekly: "🗓 <b>Laporan mingguan otomatis</b>",
  monthly: "🗓 <b>Laporan bulanan otomatis</b>",
};

/** Klaim atomik: true hanya untuk pemanggil pertama di tanggal ini. */
async function claim(db: D1Database, kind: ReportKind, today: string): Promise<boolean> {
  const key = `last_${kind}_report_date`;
  const r = await db.batch([
    db.prepare("INSERT OR IGNORE INTO settings (key, value) VALUES (?1, '')").bind(key),
    db.prepare("UPDATE settings SET value = ?2 WHERE key = ?1 AND value <> ?2").bind(key, today),
  ]);
  return (r[1]!.meta.changes ?? 0) === 1;
}

function change(now: number, prev: number): string {
  if (prev === 0) return now === 0 ? "sama" : "baru";
  const d = Math.round(((now - prev) * 100) / Math.abs(prev));
  return d === 0 ? "sama" : `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}%`;
}

async function comparison(db: D1Database, cur: Period, prev: { from: string; to: string }, label: string, withCost: boolean): Promise<string> {
  const [a, b] = await Promise.all([profitLoss(db, cur.from, cur.to), profitLoss(db, prev.from, prev.to)]);
  const parts = [`omzet ${change(a.omzet, b.omzet)} (sebelumnya ${rupiah(b.omzet)})`];
  if (withCost) parts.push(`laba bersih ${change(a.labaBersih, b.labaBersih)} (sebelumnya ${rupiah(b.labaBersih)})`);
  return `📈 Dibanding ${label}: ${parts.join(", ")}`;
}

export interface ScheduledResult {
  sent: ReportKind[];
  skipped: string | null;
}

export async function runScheduled(env: Env, api: Api, now: Date = new Date()): Promise<ScheduledResult> {
  const db = env.DB;
  await cleanup(db, now).catch((e: unknown) => console.warn("cleanup gagal", e));

  const s = await getAppSettings(db);
  if (wibHour(now) !== s.report_hour) return { sent: [], skipped: "bukan jam laporan" };

  const owner = await db.prepare("SELECT telegram_id FROM users WHERE role = 'owner' AND is_active = 1 LIMIT 1").first<{ telegram_id: number }>();
  if (!owner) return { sent: [], skipped: "belum ada owner" };
  const chatId = s.report_target.chatId ?? owner.telegram_id;
  // HPP & laba hanya ke chat pribadi owner; di grup disembunyikan (§7).
  const withCost = s.report_target.type === "owner";

  const today = wibDate(now);
  const jobs: { kind: Exclude<ReportKind, "lowstock">; period: Period; prev?: { from: string; to: string }; prevLabel?: string }[] = [];
  if (s.daily_report_enabled) jobs.push({ kind: "daily", period: periodRange("hari", now) });
  if (s.weekly_report_enabled && wibIsoWeekday(now) === 1) {
    const p = periodRange("minggulalu", now);
    jobs.push({ kind: "weekly", period: p, prev: { from: addDays(p.from, -7), to: addDays(p.to, -7) }, prevLabel: "minggu sebelumnya" });
  }
  if (s.monthly_report_enabled && wibDayOfMonth(now) === 1) {
    const p = periodRange("bulanlalu", now);
    const prevTo = addDays(p.from, -1);
    jobs.push({ kind: "monthly", period: p, prev: { from: `${prevTo.slice(0, 8)}01`, to: prevTo }, prevLabel: "bulan sebelumnya" });
  }

  const sent: ReportKind[] = [];
  for (const job of jobs) {
    if (!(await claim(db, job.kind, today))) continue;
    try {
      let text = `${TITLE[job.kind]}\n${await buildReport(db, job.period, withCost)}`;
      if (job.prev) text += `\n\n${await comparison(db, job.period, job.prev, job.prevLabel!, withCost)}`;
      await api.sendMessage(chatId, text, { parse_mode: "HTML", link_preview_options: { is_disabled: true } });
      if (job.kind === "monthly") {
        // PDF berisi HPP & laba → selalu ke chat pribadi owner.
        const pdf = await buildPdfReport(db, job.period, wibDateTimeLabel(now));
        await api.sendDocument(owner.telegram_id, new InputFile(pdf.bytes, pdf.filename), {
          caption: `📄 Laporan keuangan ${html(job.period.label.toLowerCase())}`,
        });
      }
      sent.push(job.kind);
    } catch (e) {
      // Klaim tetap tercatat supaya tidak spam; kegagalan dicatat di log Worker.
      console.error(`laporan ${job.kind} gagal dikirim`, e);
    }
  }
  // Peringatan stok menipis (maks 1x/hari) → selalu ke chat pribadi owner.
  if ((await getFeatures(db)).stock) {
    const low = await lowStock(db, 30);
    if (low.length && (await claim(db, "lowstock", today))) {
      try {
        const lines = low.map((p) => `• ${html(p.name)}: <b>${p.stock}</b> ${html(p.unit)}${p.stock <= 0 ? " (habis)" : ` (min ${p.min_stock})`}`);
        const text = [`📦 <b>Stok menipis</b> · ${low.length} produk`, ...lines, "", "Catat restock: /restock &lt;produk&gt; &lt;qty&gt; &lt;harga beli&gt;"].join("\n");
        await api.sendMessage(owner.telegram_id, text, { parse_mode: "HTML" });
        sent.push("lowstock");
      } catch (e) {
        console.error("peringatan stok gagal dikirim", e);
      }
    }
  }
  return { sent, skipped: null };
}
