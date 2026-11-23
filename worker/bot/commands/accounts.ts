/** /saldo dan /akun. */
import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { parseAmount } from "../parsers/amount";
import { html, rupiah, tanggalPendek } from "../format";
import { wibDate } from "../../lib/date";
import { AppError } from "../../lib/errors";
import { accountBalances, createAccount, listAccounts, type AccountType } from "../../services/cash";

const TYPE_WORDS: Record<string, AccountType> = {
  tunai: "cash",
  cash: "cash",
  bank: "bank",
  ewallet: "ewallet",
  "e-wallet": "ewallet",
  dompet: "ewallet",
  marketplace: "marketplace",
  mp: "marketplace",
};

const TYPE_LABEL: Record<AccountType, string> = { cash: "Tunai", bank: "Bank", ewallet: "E-wallet", marketplace: "Marketplace" };

const AKUN_HELP = [
  "<b>Kelola akun kas</b>",
  "<code>/akun</code>: daftar akun",
  "<code>/akun tambah &lt;nama&gt; [tunai|bank|ewallet|marketplace] [saldo awal]</code>",
  "Contoh: <code>/akun tambah BCA bank 2jt</code>",
].join("\n");

async function saldo(ctx: BotContext): Promise<void> {
  if (ctx.user!.role === "staff") {
    await ctx.reply("Saldo kas hanya bisa dilihat owner/admin.");
    return;
  }
  const rows = await accountBalances(ctx.env.DB);
  const total = rows.reduce((n, r) => n + r.balance, 0);
  const lines = rows.map((r) => `${html(r.name)}: <b>${rupiah(r.balance)}</b>`);
  await ctx.reply([`💰 <b>Saldo kas</b> per ${tanggalPendek(wibDate())}`, "", ...lines, "", `Total: <b>${rupiah(total)}</b>`].join("\n"), {
    parse_mode: "HTML",
  });
}

/** "BCA Prioritas bank 2jt" → nama, tipe, saldo awal. Tipe & saldo boleh di urutan mana pun di belakang. */
export function parseNewAccount(args: string[]): { name: string; type: AccountType; openingBalance: number } | null {
  const rest = [...args];
  let type: AccountType = "bank";
  let openingBalance = 0;
  for (let guardLoop = 0; guardLoop < 2 && rest.length > 1; guardLoop++) {
    const last = rest[rest.length - 1]!;
    const t = TYPE_WORDS[last.toLowerCase()];
    const amt = parseAmount(last);
    if (t) {
      type = t;
      rest.pop();
    } else if (amt !== null) {
      openingBalance = amt;
      rest.pop();
    }
  }
  const name = rest.join(" ").trim();
  return name ? { name, type, openingBalance } : null;
}

async function akun(ctx: BotContext): Promise<void> {
  const args = (typeof ctx.match === "string" ? ctx.match : "").trim().split(/\s+/).filter(Boolean);

  if (args[0]?.toLowerCase() === "tambah") {
    if (ctx.user!.role !== "owner") {
      await ctx.reply("Hanya owner yang bisa menambah akun kas.");
      return;
    }
    const parsed = parseNewAccount(args.slice(1));
    if (!parsed) {
      await ctx.reply(AKUN_HELP, { parse_mode: "HTML" });
      return;
    }
    try {
      const acc = await createAccount(ctx.env.DB, parsed, { id: ctx.user!.id, role: ctx.user!.role });
      await ctx.reply(
        `✅ Akun <b>${html(acc.name)}</b> (${TYPE_LABEL[acc.type]}) ditambahkan dengan saldo awal ${rupiah(acc.opening_balance)}.`,
        { parse_mode: "HTML" },
      );
    } catch (e) {
      if (e instanceof AppError) await ctx.reply(e.message);
      else throw e;
    }
    return;
  }

  if (ctx.user!.role === "staff") {
    await ctx.reply("Daftar akun hanya untuk owner/admin.");
    return;
  }
  const accounts = await listAccounts(ctx.env.DB);
  const lines = accounts.map((a) => `• ${html(a.name)} (${TYPE_LABEL[a.type]})`);
  const footer = ctx.user!.role === "owner" ? `\n\n${AKUN_HELP}` : "";
  await ctx.reply(`🏦 <b>Akun kas</b>\n${lines.join("\n")}${footer}`, { parse_mode: "HTML" });
}

export function registerAccounts(bot: Bot<BotContext>): void {
  bot.command("saldo", saldo);
  bot.command("akun", akun);
}
