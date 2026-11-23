import { Hono } from "hono";
import type { Transformer } from "grammy/web";
import type { Update, UserFromGetMe } from "grammy/types";
import type { Env } from "../env";
import { createBot } from "../bot/bot";
import { getSetting, getWebhookSecret } from "../services/settings";
import { safeEqual } from "../lib/crypto";

export interface WebhookDeps {
  apiTransformer?: Transformer;
}

/** Proses satu update Telegram. Dipisah dari route agar bisa dites langsung. */
export async function handleTelegramWebhook(req: Request, env: Env, deps: WebhookDeps = {}): Promise<Response> {
  const header = req.headers.get("X-Telegram-Bot-Api-Secret-Token") ?? "";
  if (!(await safeEqual(header, await getWebhookSecret(env)))) {
    return new Response("unauthorized", { status: 401 });
  }

  let update: Update;
  try {
    update = (await req.json()) as Update;
  } catch {
    return new Response("bad request", { status: 400 });
  }
  if (typeof update.update_id !== "number") return new Response("bad request", { status: 400 });

  // Idempotensi: Telegram bisa mengirim ulang update yang sama.
  const ins = await env.DB.prepare("INSERT OR IGNORE INTO processed_updates (update_id) VALUES (?1)").bind(update.update_id).run();
  if (ins.meta.changes === 0) return new Response("ok");

  const raw = await getSetting(env.DB, "bot_info");
  if (!raw) return new Response("setup belum dijalankan", { status: 503 });
  const botInfo = JSON.parse(raw) as UserFromGetMe;

  const bot = createBot({
    env,
    appUrl: `${new URL(req.url).origin}/`,
    botInfo,
    ...(deps.apiTransformer ? { apiTransformer: deps.apiTransformer } : {}),
  });
  await bot.handleUpdate(update);
  return new Response("ok");
}

export const webhookRoutes = new Hono<{ Bindings: Env }>();

webhookRoutes.post("/webhook/tg", (c) => handleTelegramWebhook(c.req.raw, c.env));
