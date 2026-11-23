import { Api, type Transformer } from "grammy/web";
import type { Env } from "../env";
import { migrate } from "../db/migrate";
import { getSessionSecret, getWebhookSecret, setSetting } from "./settings";
import { ensureOwnerClaimCode, hasOwner } from "./users";
import { getFeatures } from "./features";
import { botCommands } from "../bot/commands/list";

export interface SetupStep {
  name: string;
  ok: boolean;
  detail: string;
}

export interface SetupReport {
  steps: SetupStep[];
  dbVersion: number | null;
  botUsername: string | null;
  ownerClaimed: boolean;
  claimLink: string | null;
}

export interface SetupOptions {
  /** Origin publik worker, mis. https://finbot.nama.workers.dev */
  origin: string;
  apiTransformer?: Transformer;
}

function errMsg(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/**
 * Langkah setup idempoten (ARCHITECTURE.md §6). Aman dijalankan berulang kali,
 * termasuk setelah update versi. Langkah yang gagal tidak menghentikan langkah
 * berikutnya kecuali langkah itu bergantung padanya.
 */
export async function runSetup(env: Env, opts: SetupOptions): Promise<SetupReport> {
  const steps: SetupStep[] = [];
  const report: SetupReport = { steps, dbVersion: null, botUsername: null, ownerClaimed: false, claimLink: null };

  // 1. Migrasi
  try {
    const r = await migrate(env.DB);
    report.dbVersion = r.current;
    steps.push({
      name: "Database",
      ok: true,
      detail: r.applied.length ? `Migrasi dijalankan: ${r.applied.join(", ")}. Versi ${r.current}.` : `Sudah versi terbaru (${r.current}).`,
    });
  } catch (e) {
    steps.push({ name: "Database", ok: false, detail: `Migrasi gagal: ${errMsg(e)}` });
    return report; // langkah lain butuh tabel settings
  }

  // 2. Secret internal
  const webhookSecret = await getWebhookSecret(env);
  await getSessionSecret(env);
  steps.push({ name: "Kunci rahasia", ok: true, detail: "Webhook secret & session secret siap." });

  const api = new Api(env.BOT_TOKEN);
  if (opts.apiTransformer) api.config.use(opts.apiTransformer);
  const appUrl = `${opts.origin}/`;

  // 3. Info bot
  try {
    const me = await api.getMe();
    await setSetting(env.DB, "bot_info", JSON.stringify(me));
    report.botUsername = me.username;
    steps.push({ name: "Bot", ok: true, detail: `Terhubung ke @${me.username}.` });
  } catch (e) {
    steps.push({ name: "Bot", ok: false, detail: `BOT_TOKEN tidak valid atau Telegram tidak bisa dihubungi: ${errMsg(e)}` });
    return report; // tanpa token yang valid, langkah Telegram lain pasti gagal
  }

  // 4. Webhook
  try {
    await api.setWebhook(`${opts.origin}/webhook/tg`, {
      secret_token: webhookSecret,
      allowed_updates: ["message", "callback_query"],
      drop_pending_updates: true,
    });
    steps.push({ name: "Webhook", ok: true, detail: `Webhook diarahkan ke ${opts.origin}/webhook/tg.` });
  } catch (e) {
    steps.push({ name: "Webhook", ok: false, detail: `Gagal memasang webhook: ${errMsg(e)}` });
  }

  // 5. Tombol menu Mini App
  try {
    await api.setChatMenuButton({ menu_button: { type: "web_app", text: "Buka App", web_app: { url: appUrl } } });
    steps.push({ name: "Tombol menu", ok: true, detail: `Tombol menu membuka ${appUrl}.` });
  } catch (e) {
    steps.push({ name: "Tombol menu", ok: false, detail: `Gagal memasang tombol menu: ${errMsg(e)}` });
  }

  // 6. Daftar perintah
  try {
    const features = await getFeatures(env.DB);
    await api.setMyCommands(botCommands({ featureStock: features.stock }));
    steps.push({ name: "Perintah bot", ok: true, detail: "Daftar perintah diperbarui." });
  } catch (e) {
    steps.push({ name: "Perintah bot", ok: false, detail: `Gagal memasang daftar perintah: ${errMsg(e)}` });
  }

  // 7. Klaim owner
  const code = await ensureOwnerClaimCode(env.DB);
  report.ownerClaimed = await hasOwner(env.DB);
  if (code) report.claimLink = `https://t.me/${report.botUsername}?start=claim_${code}`;

  return report;
}
