import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { getWebhookSecret, setSetting } from "../worker/services/settings";
import { ensureOwnerClaimCode } from "../worker/services/users";
import { BOT_INFO, mockTelegram, privateMessage, useFreshDb } from "./helpers";

const URL_WEBHOOK = "https://finbot.contoh.workers.dev/webhook/tg";

describe("webhook Telegram", () => {
  useFreshDb();
  let secret = "";

  beforeEach(async () => {
    await setSetting(env.DB, "bot_info", JSON.stringify(BOT_INFO));
    secret = await getWebhookSecret(env);
  });

  async function send(update: unknown, headerSecret = secret) {
    const tg = mockTelegram();
    const req = new Request(URL_WEBHOOK, {
      method: "POST",
      body: JSON.stringify(update),
      headers: { "content-type": "application/json", "X-Telegram-Bot-Api-Secret-Token": headerSecret },
    });
    const res = await handleTelegramWebhook(req, env, { apiTransformer: tg.transformer });
    return { res, tg };
  }

  it("secret header salah: 401, update tidak diproses", async () => {
    const { res, tg } = await send(privateMessage(111, "/start"), "palsu");
    expect(res.status).toBe(401);
    expect(tg.calls).toHaveLength(0);
  });

  it("/start dari orang tak dikenal: diminta menghubungi owner", async () => {
    const { res, tg } = await send(privateMessage(111, "/start"));
    expect(res.status).toBe(200);
    expect(tg.replies()).toEqual(["Kamu belum terdaftar. Minta owner menambahkan akun Telegram kamu."]);
  });

  it("/start claim_<kode>: jadi owner dan dapat tombol Mini App", async () => {
    const code = await ensureOwnerClaimCode(env.DB);
    const { tg } = await send(privateMessage(111, `/start claim_${code}`, "Budi"));
    const msg = tg.calls.find((c) => c.method === "sendMessage")!;
    expect(String(msg.payload["text"])).toContain("Kamu sekarang owner");
    expect(msg.payload["reply_markup"]).toEqual({
      inline_keyboard: [[{ text: "Buka Aplikasi", web_app: { url: "https://finbot.contoh.workers.dev/" } }]],
    });

    const again = await send(privateMessage(111, "/start", "Budi"));
    expect(again.tg.replies()[0]).toContain("Halo, Budi (Owner)");
  });

  it("kode klaim salah: pesan penolakan", async () => {
    await ensureOwnerClaimCode(env.DB);
    const { tg } = await send(privateMessage(111, "/start claim_ngawur"));
    expect(tg.replies()).toEqual(["Kode klaim tidak valid atau sudah dipakai."]);
  });

  it("update yang sama dikirim ulang: hanya diproses sekali", async () => {
    const update = privateMessage(111, "/start");
    const first = await send(update);
    const second = await send(update);
    expect(first.tg.replies()).toHaveLength(1);
    expect(second.res.status).toBe(200);
    expect(second.tg.calls).toHaveLength(0);
  });

  it("/app hanya untuk user terdaftar", async () => {
    const stranger = await send(privateMessage(222, "/app"));
    expect(stranger.tg.replies()[0]).toContain("belum terdaftar");

    await env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (333, 'Sari', 'staff')").run();
    const staff = await send(privateMessage(333, "/app", "Sari"));
    expect(staff.tg.replies()).toEqual(["Buka aplikasi:"]);
  });

  it("body bukan JSON: 400", async () => {
    const req = new Request(URL_WEBHOOK, { method: "POST", body: "{rusak", headers: { "X-Telegram-Bot-Api-Secret-Token": secret } });
    const res = await handleTelegramWebhook(req, env);
    expect(res.status).toBe(400);
  });
});
