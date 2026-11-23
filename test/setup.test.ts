import { env, reset } from "cloudflare:test";
import { afterEach, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { runSetup } from "../worker/services/setup";
import { getSetting } from "../worker/services/settings";
import { mockTelegram } from "./helpers";

const ORIGIN = "https://finbot.contoh.workers.dev";

afterEach(async () => {
  await reset();
});

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

function formPost(key: string): Request {
  return new Request(`${ORIGIN}/setup`, {
    method: "POST",
    body: new URLSearchParams({ key }),
    headers: { "content-type": "application/x-www-form-urlencoded" },
  });
}

describe("runSetup", () => {
  it("DB kosong: migrasi, secret, webhook, menu, perintah, dan tautan klaim", async () => {
    const tg = mockTelegram();
    const r = await runSetup(env, { origin: ORIGIN, apiTransformer: tg.transformer });

    expect(r.steps.every((s) => s.ok)).toBe(true);
    expect(r.dbVersion).toBe(3);
    expect(r.botUsername).toBe("finbot_test_bot");
    expect(r.ownerClaimed).toBe(false);
    expect(r.claimLink).toMatch(/^https:\/\/t\.me\/finbot_test_bot\?start=claim_[0-9a-f]{32}$/);

    expect(tg.calls.map((c) => c.method)).toEqual(["getMe", "setWebhook", "setChatMenuButton", "setMyCommands"]);

    const wh = tg.calls.find((c) => c.method === "setWebhook")!.payload;
    expect(wh["url"]).toBe(`${ORIGIN}/webhook/tg`);
    expect(wh["secret_token"]).toBe(await getSetting(env.DB, "webhook_secret"));
    expect(wh["allowed_updates"]).toEqual(["message", "callback_query"]);

    const menu = tg.calls.find((c) => c.method === "setChatMenuButton")!.payload;
    expect(menu["menu_button"]).toEqual({ type: "web_app", text: "Buka App", web_app: { url: `${ORIGIN}/` } });

    expect(await getSetting(env.DB, "session_secret")).toMatch(/^[0-9a-f]{64}$/);
  });

  it("dijalankan ulang: secret dan kode klaim tetap sama", async () => {
    const first = await runSetup(env, { origin: ORIGIN, apiTransformer: mockTelegram().transformer });
    const secret1 = await getSetting(env.DB, "webhook_secret");
    const second = await runSetup(env, { origin: ORIGIN, apiTransformer: mockTelegram().transformer });
    expect(second.claimLink).toBe(first.claimLink);
    expect(await getSetting(env.DB, "webhook_secret")).toBe(secret1);
    expect(second.steps[0]!.detail).toContain("Sudah versi terbaru");
  });

  it("token bot salah: berhenti dengan pesan jelas, tanpa memasang webhook", async () => {
    const tg = mockTelegram({ getMe: () => new Error("Unauthorized") });
    const r = await runSetup(env, { origin: ORIGIN, apiTransformer: tg.transformer });
    const bot = r.steps.find((s) => s.name === "Bot")!;
    expect(bot.ok).toBe(false);
    expect(bot.detail).toContain("BOT_TOKEN tidak valid");
    expect(tg.calls.map((c) => c.method)).toEqual(["getMe"]);
  });

  it("satu langkah Telegram gagal tidak menghentikan langkah lain", async () => {
    const tg = mockTelegram({ setChatMenuButton: () => new Error("Bad Request") });
    const r = await runSetup(env, { origin: ORIGIN, apiTransformer: tg.transformer });
    expect(r.steps.find((s) => s.name === "Tombol menu")!.ok).toBe(false);
    expect(r.steps.find((s) => s.name === "Perintah bot")!.ok).toBe(true);
    expect(r.claimLink).not.toBeNull();
  });
});

describe("route /setup", () => {
  it("GET menampilkan form", async () => {
    const res = await worker.fetch(new Request(`${ORIGIN}/setup`), env, ctx());
    expect(res.status).toBe(200);
    expect(await res.text()).toContain('name="key"');
  });

  it("SETUP_KEY salah: 401 dan DB tidak disentuh", async () => {
    const res = await worker.fetch(formPost("salah-total-123"), env, ctx());
    expect(res.status).toBe(401);
    expect(await res.text()).toContain("SETUP_KEY salah");
    const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='settings'").first();
    expect(t).toBeNull();
  });

  it("SETUP_KEY di konfigurasi terlalu pendek: ditolak", async () => {
    const res = await worker.fetch(formPost("pendek"), { ...env, SETUP_KEY: "pendek" }, ctx());
    expect(res.status).toBe(500);
    expect(await res.text()).toContain("kurang dari 12 karakter");
  });
});
