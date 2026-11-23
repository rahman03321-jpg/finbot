import { Bot, type Context, type Transformer } from "grammy/web";
import type { UserFromGetMe } from "grammy/types";
import type { Env } from "../env";
import { findActiveUser, type User } from "../services/users";
import { registerStart } from "./commands/start";
import { registerApp } from "./commands/app";
import { registerCash } from "./commands/cash";
import { registerDrafts } from "./drafts";
import { registerSales } from "./commands/sales";
import { registerProducts } from "./commands/products";
import { registerUsers } from "./commands/users";
import { registerReports } from "./commands/reports";
import { registerSchedule } from "./commands/schedule";
import { registerStock } from "./commands/stock";
import { registerAccounts } from "./commands/accounts";

export interface BotContextExtra {
  env: Env;
  /** URL Mini App (https://<host>/). */
  appUrl: string;
  /** User terdaftar & aktif, atau null. */
  user: User | null;
}

export type BotContext = Context & BotContextExtra;

export interface CreateBotOptions {
  env: Env;
  appUrl: string;
  botInfo: UserFromGetMe;
  /** Dipakai test untuk mencegat panggilan ke api.telegram.org. */
  apiTransformer?: Transformer;
}

/** Pesan diawali /perintah yang tidak ditujukan ke bot lain (mis. /masuk atau /masuk@bot_ini). */
function isCommandForThisBot(ctx: BotContext): boolean {
  const text = ctx.msg?.text ?? "";
  const m = /^\/[A-Za-z0-9_]+(?:@([A-Za-z0-9_]+))?/.exec(text);
  if (!m) return false;
  return !m[1] || m[1].toLowerCase() === ctx.me.username.toLowerCase();
}

export function createBot(opts: CreateBotOptions): Bot<BotContext> {
  const bot = new Bot<BotContext>(opts.env.BOT_TOKEN, { botInfo: opts.botInfo });
  if (opts.apiTransformer) bot.api.config.use(opts.apiTransformer);

  bot.use(async (ctx, next) => {
    ctx.env = opts.env;
    ctx.appUrl = opts.appUrl;
    ctx.user = ctx.from ? await findActiveUser(opts.env.DB, ctx.from.id) : null;
    await next();
  });

  // /start menangani sendiri user yang belum terdaftar (klaim owner).
  registerStart(bot);

  // Semua handler setelah ini hanya untuk user terdaftar.
  bot.use(async (ctx, next) => {
    if (!ctx.user) {
      const msg = "Kamu belum terdaftar. Minta owner menambahkan akun Telegram kamu.";
      if (ctx.callbackQuery) {
        await ctx.answerCallbackQuery({ text: msg, show_alert: true });
      } else if (ctx.chat?.type === "private") {
        await ctx.reply(msg);
      } else if (isCommandForThisBot(ctx)) {
        // Di grup hanya membalas perintah yang ditujukan ke bot ini, bukan obrolan biasa.
        await ctx.reply(msg, { reply_parameters: { message_id: ctx.msg!.message_id } });
      }
      return;
    }
    await next();
  });

  registerApp(bot);
  registerDrafts(bot);
  registerCash(bot);
  registerSales(bot);
  registerProducts(bot);
  registerAccounts(bot);
  registerUsers(bot);
  registerReports(bot);
  registerSchedule(bot);
  registerStock(bot);

  bot.catch(async (err) => {
    console.error("bot error", err.error);
    try {
      await err.ctx.reply("Maaf, terjadi kesalahan. Coba lagi sebentar lagi.");
    } catch {
      // abaikan: jangan sampai error balasan membuat webhook gagal terus
    }
  });

  return bot;
}
