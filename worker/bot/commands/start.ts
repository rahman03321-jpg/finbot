import { InlineKeyboard, type Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { acceptInvite, claimOwner } from "../../services/users";
import { AppError } from "../../lib/errors";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" } as const;

export function appKeyboard(appUrl: string): InlineKeyboard {
  return new InlineKeyboard().webApp("Buka Aplikasi", appUrl);
}

export function registerStart(bot: Bot<BotContext>): void {
  bot.command("start", async (ctx) => {
    if (ctx.chat.type !== "private") return;
    const payload = ctx.match.trim();

    if (payload.startsWith("claim_")) {
      const from = ctx.from!;
      try {
        const user = await claimOwner(ctx.env.DB, payload.slice("claim_".length), {
          telegramId: from.id,
          username: from.username,
          fullName: [from.first_name, from.last_name].filter(Boolean).join(" "),
        });
        ctx.user = user;
        await ctx.reply(
          `Selamat, ${user.full_name}! Kamu sekarang owner usaha ini.\n\nBuka aplikasi lewat tombol di bawah atau tombol menu di kiri bawah.`,
          { reply_markup: appKeyboard(ctx.appUrl) },
        );
      } catch (e) {
        if (e instanceof AppError) {
          await ctx.reply(e.message);
          return;
        }
        throw e;
      }
      return;
    }

    if (payload.startsWith("join_")) {
      const from = ctx.from!;
      try {
        const user = await acceptInvite(ctx.env.DB, payload.slice("join_".length), {
          telegramId: from.id,
          username: from.username,
          fullName: [from.first_name, from.last_name].filter(Boolean).join(" "),
        });
        ctx.user = user;
        await ctx.reply(
          `Selamat datang, ${user.full_name}! Kamu terdaftar sebagai ${ROLE_LABEL[user.role]}.\n\nCoba /omzet, /jual, /masuk, atau /keluar. Kamu juga bisa memakai bot ini di grup usaha.`,
          { reply_markup: appKeyboard(ctx.appUrl) },
        );
      } catch (e) {
        if (e instanceof AppError) {
          await ctx.reply(e.message);
          return;
        }
        throw e;
      }
      return;
    }

    if (!ctx.user) {
      await ctx.reply("Kamu belum terdaftar. Minta owner menambahkan akun Telegram kamu.");
      return;
    }

    await ctx.reply(
      `Halo, ${ctx.user.full_name} (${ROLE_LABEL[ctx.user.role]}).\n\nBot ini mencatat kas, penjualan, dan laporan usaha kamu. Buka aplikasi lewat tombol di bawah.`,
      { reply_markup: appKeyboard(ctx.appUrl) },
    );
  });
}
