/** /jadwal: lihat jadwal laporan otomatis & pilih tujuannya (chat pribadi owner atau grup ini). */
import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { html } from "../format";
import { actorOf, guard, words } from "../drafts";
import { getAppSettings, setReportGroup, updateAppSettings } from "../../services/settings";

const HELP = [
  "<code>/jadwal</code>: lihat jadwal laporan otomatis",
  "<code>/jadwal grup</code>: kirim laporan ke grup ini (ketik di grupnya)",
  "<code>/jadwal pribadi</code>: kirim laporan ke chat pribadi owner",
  "Jam & jenis laporan diatur di aplikasi: ⚙ Pengaturan → Laporan otomatis.",
].join("\n");

async function jadwal(ctx: BotContext): Promise<void> {
  if (ctx.user!.role !== "owner") {
    await ctx.reply("Hanya owner yang bisa mengatur laporan otomatis.");
    return;
  }
  const sub = words(typeof ctx.match === "string" ? ctx.match : "")[0]?.toLowerCase();
  const db = ctx.env.DB;

  if (sub === "grup" || sub === "group") {
    if (ctx.chat?.type !== "group" && ctx.chat?.type !== "supergroup") {
      await ctx.reply("Ketik <code>/jadwal grup</code> di dalam grup yang mau menerima laporan.", { parse_mode: "HTML" });
      return;
    }
    await setReportGroup(db, ctx.chat.id, ctx.chat.title ?? "Grup", actorOf(ctx));
    await ctx.reply(
      "✅ Laporan otomatis akan dikirim ke grup ini.\nDi grup, HPP & laba tidak ditampilkan. Laporan PDF bulanan tetap dikirim ke chat pribadi owner.",
    );
    return;
  }
  if (sub === "pribadi" || sub === "private") {
    await updateAppSettings(db, { report_target: "owner" }, actorOf(ctx));
    await ctx.reply("✅ Laporan otomatis akan dikirim ke chat pribadi owner (lengkap dengan HPP & laba).");
    return;
  }

  const s = await getAppSettings(db);
  const on = (b: boolean) => (b ? "✅" : "⬜️");
  const target = s.report_target.type === "group" ? `grup <b>${html(s.report_target.title ?? "")}</b>` : "chat pribadi owner";
  await ctx.reply(
    [
      "🗓 <b>Laporan otomatis</b>",
      `${on(s.daily_report_enabled)} Harian: ringkasan hari ini`,
      `${on(s.weekly_report_enabled)} Mingguan: tiap Senin, minggu lalu`,
      `${on(s.monthly_report_enabled)} Bulanan: tiap tanggal 1, bulan lalu + PDF`,
      `Jam kirim: <b>${String(s.report_hour).padStart(2, "0")}.00 WIB</b>`,
      `Dikirim ke: ${target}`,
      "",
      HELP,
    ].join("\n"),
    { parse_mode: "HTML" },
  );
}

export function registerSchedule(bot: Bot<BotContext>): void {
  bot.command("jadwal", (ctx) => guard(ctx, () => jadwal(ctx)));
}
