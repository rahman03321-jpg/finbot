import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { Api } from "grammy/web";
import { runScheduled } from "../worker/bot/scheduled";
import { getAppSettings, setReportGroup, setSetting, updateAppSettings } from "../worker/services/settings";
import { createSale } from "../worker/services/sales";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { getWebhookSecret } from "../worker/services/settings";
import { BOT_INFO, GROUP_ID, groupMessage, mockTelegram, privateMessage, useFreshDb } from "./helpers";

const owner = { id: 1, role: "owner" as const };

// Senin 16 Nov 2026 21:10 WIB
const MON_21 = new Date("2026-11-16T14:10:00Z");
// Senin 16 Nov 2026 20:10 WIB (bukan jam laporan)
const MON_20 = new Date("2026-11-16T13:10:00Z");
// Selasa 1 Des 2026 21:00 WIB
const DEC1_21 = new Date("2026-12-01T14:00:00Z");
// Rabu 18 Nov 2026 21:30 WIB
const WED_21 = new Date("2026-11-18T14:30:00Z");

function apiWith(tg: ReturnType<typeof mockTelegram>): Api {
  const a = new Api(env.BOT_TOKEN);
  a.config.use(tg.transformer);
  return a;
}

describe("laporan otomatis (cron)", () => {
  useFreshDb();
  beforeEach(async () => {
    await env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')").run();
    await createSale(env.DB, { tanggal: "2026-11-16", items: [{ itemName: "X", qty: 1, sellPrice: 100_000, costPrice: 60_000 }], accountId: 1, source: "bot" }, owner);
    await createSale(env.DB, { tanggal: "2026-11-10", items: [{ itemName: "X", qty: 1, sellPrice: 50_000, costPrice: 30_000 }], accountId: 1, source: "bot" }, owner);
  });

  it("bukan jam laporan → tidak mengirim apa pun", async () => {
    const tg = mockTelegram();
    const r = await runScheduled(env, apiWith(tg), MON_20);
    expect(r).toEqual({ sent: [], skipped: "bukan jam laporan" });
    expect(tg.calls).toHaveLength(0);
  });

  it("Senin jam 21 WIB → harian + mingguan ke owner, lengkap dengan laba & perbandingan", async () => {
    const tg = mockTelegram();
    const r = await runScheduled(env, apiWith(tg), MON_21);
    expect(r.sent).toEqual(["daily", "weekly"]);
    const msgs = tg.calls.filter((c) => c.method === "sendMessage");
    expect(msgs.every((m) => m.payload["chat_id"] === 111)).toBe(true);
    const [daily, weekly] = msgs.map((m) => String(m.payload["text"]));
    expect(daily).toContain("Laporan harian otomatis");
    expect(daily).toContain("Laporan Hari ini");
    expect(daily).toContain("Omzet: <b>Rp 100.000</b>");
    expect(daily).toContain("Laba bersih: Rp 40.000");
    expect(weekly).toContain("Laporan mingguan otomatis");
    expect(weekly).toContain("Minggu lalu"); // 9–15 Nov
    expect(weekly).toContain("Omzet: <b>Rp 50.000</b>");
    expect(weekly).toContain("Dibanding minggu sebelumnya: omzet baru");
  });

  it("tidak terkirim dua kali di hari yang sama (cron terpanggil ulang)", async () => {
    const first = mockTelegram();
    await runScheduled(env, apiWith(first), MON_21);
    const second = mockTelegram();
    const r = await runScheduled(env, apiWith(second), new Date(MON_21.getTime() + 20 * 60_000));
    expect(r.sent).toEqual([]);
    expect(second.calls).toHaveLength(0);
  });

  it("tanggal 1 → bulanan + PDF ke owner", async () => {
    const tg = mockTelegram();
    const r = await runScheduled(env, apiWith(tg), DEC1_21);
    expect(r.sent).toEqual(["daily", "monthly"]);
    const monthly = String(tg.calls.filter((c) => c.method === "sendMessage")[1]!.payload["text"]);
    expect(monthly).toContain("Laporan bulanan otomatis");
    expect(monthly).toContain("Bulan lalu");
    expect(monthly).toContain("Omzet: <b>Rp 150.000</b>");
    const doc = tg.calls.find((c) => c.method === "sendDocument")!;
    expect(doc.payload["chat_id"]).toBe(111);
    expect((doc.payload["document"] as { filename: string }).filename).toBe("laporan_2026-11-01_2026-11-30.pdf");
  });

  it("jenis yang dimatikan & jam yang diubah dihormati", async () => {
    await updateAppSettings(env.DB, { daily_report_enabled: false, report_hour: 20 }, owner);
    const at21 = mockTelegram();
    expect((await runScheduled(env, apiWith(at21), MON_21)).sent).toEqual([]);
    const at20 = mockTelegram();
    expect((await runScheduled(env, apiWith(at20), MON_20)).sent).toEqual(["weekly"]);
  });

  it("tujuan grup: dikirim ke grup tanpa HPP/laba; PDF bulanan tetap ke owner", async () => {
    await setReportGroup(env.DB, GROUP_ID, "Toko", owner);
    const tg = mockTelegram();
    await runScheduled(env, apiWith(tg), DEC1_21);
    const msgs = tg.calls.filter((c) => c.method === "sendMessage");
    expect(msgs.every((m) => m.payload["chat_id"] === GROUP_ID)).toBe(true);
    const all = msgs.map((m) => String(m.payload["text"])).join();
    expect(all).not.toMatch(/HPP:|Laba kotor|Laba bersih|laba bersih/);
    expect(all).toContain("hanya ditampilkan untuk owner/admin di chat pribadi");
    expect(tg.calls.find((c) => c.method === "sendDocument")!.payload["chat_id"]).toBe(111);
  });

  it("gagal kirim (mis. bot dikeluarkan dari grup) tidak membuat cron error", async () => {
    const tg = mockTelegram({ sendMessage: () => new Error("Forbidden: bot was kicked") });
    const r = await runScheduled(env, apiWith(tg), WED_21);
    expect(r.sent).toEqual([]);
  });
});

describe("pengaturan & /jadwal", () => {
  useFreshDb();
  let secret = "";
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (2, 222, 'Ani', 'admin')"),
    ]);
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
    return tg.replies().join("\n");
  }

  it("bawaan: semua aktif, jam 21, ke owner; nama usaha bisa diganti (owner saja) & tercatat di audit", async () => {
    expect(await getAppSettings(env.DB)).toMatchObject({
      business_name: "Usaha Saya",
      daily_report_enabled: true,
      weekly_report_enabled: true,
      monthly_report_enabled: true,
      report_hour: 21,
      report_target: { type: "owner" },
    });
    const s = await updateAppSettings(env.DB, { business_name: "  Toko   Sehat " }, owner);
    expect(s.business_name).toBe("Toko Sehat");
    await expect(updateAppSettings(env.DB, { business_name: "X" }, { id: 2, role: "admin" })).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(updateAppSettings(env.DB, { report_hour: 24 }, owner)).rejects.toMatchObject({ code: "INVALID_HOUR" });
    const a = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = 'settings.update'").first<{ n: number }>();
    expect(a!.n).toBe(1);
  });

  it("/jadwal grup di grup → tujuan grup; /jadwal pribadi → kembali ke owner; admin ditolak", async () => {
    expect(await send(groupMessage(111, "/jadwal grup"))).toContain("dikirim ke grup ini");
    expect((await getAppSettings(env.DB)).report_target).toEqual({ type: "group", chatId: GROUP_ID, title: "Toko" });
    expect(await send(privateMessage(111, "/jadwal"))).toContain("Dikirim ke: grup <b>Toko</b>");
    expect(await send(privateMessage(111, "/jadwal grup"))).toContain("di dalam grup");
    expect(await send(privateMessage(111, "/jadwal pribadi"))).toContain("chat pribadi owner");
    expect((await getAppSettings(env.DB)).report_target.type).toBe("owner");
    expect(await send(privateMessage(222, "/jadwal", "Ani"))).toContain("Hanya owner");
  });
});
