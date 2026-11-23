import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { getWebhookSecret, setSetting } from "../worker/services/settings";
import { extractChannel } from "../worker/bot/commands/sales";
import { parseProductArgs } from "../worker/bot/commands/products";
import { BOT_INFO, buttonsOf, callbackQuery, groupCallback, groupMessage, mockTelegram, privateMessage, useFreshDb } from "./helpers";

const OWNER_TG = 111;
const STAFF_TG = 222;
const STRANGER_TG = 333;

describe("parser kecil", () => {
  it("extractChannel: code, nama, singkatan; channel buatan user", () => {
    const chs = [
      { code: "offline", name: "Offline" },
      { code: "shopee", name: "Shopee" },
      { code: "whatsapp", name: "WhatsApp" },
      { code: "pasarpagi", name: "Pasar Pagi" },
    ];
    expect(extractChannel(["shopee", "pak", "budi"], chs)).toEqual({ channel: "shopee", rest: ["pak", "budi"] });
    expect(extractChannel(["pak", "WA"], chs)).toEqual({ channel: "whatsapp", rest: ["pak"] });
    expect(extractChannel(["pak", "budi"], chs)).toEqual({ channel: "offline", rest: ["pak", "budi"] });
    expect(extractChannel(["pasarpagi", "x"], chs)).toEqual({ channel: "pasarpagi", rest: ["x"] });
    // singkatan untuk channel yang sudah dihapus tidak dikenali
    expect(extractChannel(["ig"], chs)).toEqual({ channel: "offline", rest: ["ig"] });
  });
  it("parseProductArgs", () => {
    expect(parseProductArgs(["Salep", "Kulit", "hpp", "12rb", "jual", "20rb"])).toEqual({ name: "Salep Kulit", cost: 12_000, sell: 20_000 });
    expect(parseProductArgs(["Salep", "jual", "20", "rb"])).toEqual({ name: "Salep", sell: 20_000 });
    expect(parseProductArgs(["Salep", "hpp", "abc"])).toBeNull();
    expect(parseProductArgs(["Salep"])).toEqual({ name: "Salep" });
  });
});

describe("bot: /omzet, /jual, /produk, grup", () => {
  useFreshDb();
  let secret = "";

  beforeEach(async () => {
    await setSetting(env.DB, "bot_info", JSON.stringify(BOT_INFO));
    secret = await getWebhookSecret(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (?1, 'Budi', 'owner')").bind(OWNER_TG),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (?1, 'Sari', 'staff')").bind(STAFF_TG),
    ]);
  });

  async function send(update: unknown) {
    const tg = mockTelegram();
    const req = new Request("https://finbot.contoh.workers.dev/webhook/tg", {
      method: "POST",
      body: JSON.stringify(update),
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    });
    const res = await handleTelegramWebhook(req, env, { apiTransformer: tg.transformer });
    expect(res.status).toBe(200);
    return tg;
  }

  function last(tg: ReturnType<typeof mockTelegram>) {
    const c = [...tg.calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText")!;
    return { text: String(c.payload["text"]), buttons: buttonsOf(c.payload), chatId: c.payload["chat_id"] };
  }
  function alert(tg: ReturnType<typeof mockTelegram>): string {
    return String(tg.calls.find((c) => c.method === "answerCallbackQuery")?.payload["text"] ?? "");
  }
  function press(tg: ReturnType<typeof mockTelegram>, label: string): string {
    const b = last(tg).buttons.find((x) => x.text.includes(label));
    if (!b) throw new Error(`tombol "${label}" tidak ada`);
    return b.data;
  }

  it("/omzet 1,5jt hpp 900rb shopee → ringkasan dengan laba → Simpan → invoice → Batalkan", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/omzet 1,5jt hpp 900rb shopee pak budi"));
    const d = last(t1).text;
    expect(d).toContain("Penjualan cepat");
    expect(d).toContain("Omzet: <b>Rp 1.500.000</b>");
    expect(d).toContain("HPP: Rp 900.000");
    expect(d).toContain("Laba kotor: <b>Rp 600.000</b>");
    expect(d).toContain("Channel: Shopee");
    expect(d).toContain("Catatan: pak budi");
    expect(d).not.toContain("⚠️");

    const t2 = await send(callbackQuery(OWNER_TG, press(t1, "Simpan")));
    expect(last(t2).text).toMatch(/INV-\d{8}-0001<\/b> tersimpan/);
    const sale = await env.DB.prepare("SELECT total, total_cost, channel, note, source FROM sales").first();
    expect(sale).toEqual({ total: 1_500_000, total_cost: 900_000, channel: "shopee", note: "pak budi", source: "bot" });

    await send(callbackQuery(OWNER_TG, press(t2, "Batalkan"), "x\nOmzet"));
    expect(await env.DB.prepare("SELECT status FROM sales").first()).toEqual({ status: "void" });
    expect(await env.DB.prepare("SELECT status FROM cash_transactions").first()).toEqual({ status: "void" });
  });

  it("/omzet tanpa HPP → peringatan", async () => {
    const t = await send(privateMessage(OWNER_TG, "/omzet 250k"));
    expect(last(t).text).toContain("HPP kosong");
    expect(last(t).text).toContain("Laba kotor: <b>Rp 250.000</b>");
  });

  it("staff: ringkasan tanpa HPP & laba", async () => {
    const t = await send(privateMessage(STAFF_TG, "/omzet 100rb hpp 60rb", "Sari"));
    const d = last(t).text;
    expect(d).toContain("Omzet: <b>Rp 100.000</b>");
    expect(d).not.toContain("HPP:");
    expect(d).not.toContain("Laba");
  });

  it("/produk tambah → /jual salep 3 → Simpan memakai HPP produk", async () => {
    const p = await send(privateMessage(OWNER_TG, "/produk tambah Salep Kulit hpp 12rb jual 20rb"));
    expect(last(p).text).toContain("Salep Kulit</b>: jual Rp 20.000 · HPP Rp 12.000 · margin 40%");

    const t1 = await send(privateMessage(OWNER_TG, "/jual salep 3"));
    const d = last(t1).text;
    expect(d).toContain("Salep Kulit × 3 @ Rp 20.000 = Rp 60.000");
    expect(d).toContain("HPP: Rp 36.000");
    expect(d).toContain("Laba kotor: <b>Rp 24.000</b>");

    await send(callbackQuery(OWNER_TG, press(t1, "Simpan")));
    const item = await env.DB.prepare("SELECT item_name, qty, sell_price, cost_price FROM sale_items").first();
    expect(item).toEqual({ item_name: "Salep Kulit", qty: 3, sell_price: 20_000, cost_price: 12_000 });
  });

  it("/jual dengan harga khusus & channel; /jual tanpa produk terdaftar", async () => {
    const none = await send(privateMessage(OWNER_TG, "/jual salep 1"));
    expect(last(none).text).toContain("Belum ada produk");

    await send(privateMessage(OWNER_TG, "/produk tambah Salep hpp 12rb jual 20rb"));
    const t = await send(privateMessage(OWNER_TG, "/jual salep 2 18rb wa"));
    const d = last(t).text;
    expect(d).toContain("Salep × 2 @ Rp 18.000 = Rp 36.000");
    expect(d).toContain("Channel: WhatsApp");

    const unknown = await send(privateMessage(OWNER_TG, "/jual sampo 1"));
    expect(last(unknown).text).toContain("Produk tidak ditemukan");
  });

  it("/produk ubah & tampilan staff", async () => {
    await send(privateMessage(OWNER_TG, "/produk tambah Salep hpp 12rb jual 20rb"));
    const u = await send(privateMessage(OWNER_TG, "/produk ubah salep hpp 13rb"));
    expect(last(u).text).toContain("HPP Rp 13.000");

    const s = await send(privateMessage(STAFF_TG, "/produk", "Sari"));
    expect(last(s).text).toContain("Salep</b>: jual Rp 20.000");
    expect(last(s).text).not.toContain("HPP");
    const st = await send(privateMessage(STAFF_TG, "/produk tambah Sabun jual 5rb", "Sari"));
    expect(last(st).text).toContain("Hanya owner/admin");
  });

  it("grup: perintah dengan @namabot jalan, HPP tidak tampil walau owner", async () => {
    const t1 = await send(groupMessage(OWNER_TG, `/omzet@${BOT_INFO.username} 300rb hpp 200rb`));
    const d = last(t1);
    expect(d.chatId).toBe(-100123);
    expect(d.text).toContain("Omzet: <b>Rp 300.000</b>");
    expect(d.text).not.toContain("HPP");
    expect(d.text).not.toContain("Laba");

    // Anggota lain menekan Simpan milik owner → ditolak
    const other = await send(groupCallback(STAFF_TG, press(t1, "Simpan"), "Sari"));
    expect(alert(other)).toContain("bukan milikmu");
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM sales").first()).toEqual({ n: 0 });

    // Pemilik draf menekan Simpan → tersimpan
    await send(groupCallback(OWNER_TG, press(t1, "Simpan")));
    expect(await env.DB.prepare("SELECT total, total_cost FROM sales").first()).toEqual({ total: 300_000, total_cost: 200_000 });
  });

  it("grup: orang tak terdaftar → dibalas hanya untuk perintah ke bot ini", async () => {
    const cmd = await send(groupMessage(STRANGER_TG, "/keluar 50rb iklan", "Joko"));
    expect(last(cmd).text).toContain("belum terdaftar");

    const otherBot = await send(groupMessage(STRANGER_TG, "/keluar@bot_lain 50rb", "Joko"));
    expect(otherBot.calls).toHaveLength(0);

    const btn = await send(groupCallback(STRANGER_TG, "v:1", "Joko"));
    expect(alert(btn)).toContain("belum terdaftar");
  });

  it("grup: perintah untuk bot lain diabaikan oleh user terdaftar juga", async () => {
    const t = await send(groupMessage(OWNER_TG, "/omzet@bot_lain 300rb"));
    expect(t.calls.filter((c) => c.method === "sendMessage")).toHaveLength(0);
  });
});
