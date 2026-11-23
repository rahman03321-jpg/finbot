import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { appKeyboard } from "./start";

export function registerApp(bot: Bot<BotContext>): void {
  bot.command("app", async (ctx) => {
    if (ctx.chat.type !== "private") {
      // Tombol web_app inline hanya berfungsi di chat pribadi.
      await ctx.reply("Buka aplikasi dari chat pribadi dengan bot ini.");
      return;
    }
    await ctx.reply("Buka aplikasi:", { reply_markup: appKeyboard(ctx.appUrl) });
  });
}
