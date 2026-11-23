/**
 * /masuk, /keluar, /transfer (ARCHITECTURE.md §8).
 * Handler hanya mem-parsing input & memanggil services/cash.ts.
 */
import { InlineKeyboard, type Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { takeAmount } from "../parsers/amount";
import { matchLeading } from "../parsers/match";
import { html, rupiah, tanggalPendek } from "../format";
import { actorOf, cb, defineDraftType, guard, markVoided, standardKeyboard, startDraft, words, type View } from "../drafts";
import { wibDate } from "../../lib/date";
import { newUid } from "../../lib/crypto";
import {
  accountBalance,
  createCashTransaction,
  createTransfer,
  getAccount,
  getCategory,
  listAccounts,
  listManualCategories,
  voidCashTransaction,
  type Category,
  type Direction,
} from "../../services/cash";

interface CashDraft {
  t: "cash";
  uid: string;
  direction: Direction;
  amount: number;
  categoryId: number | null;
  /** Kandidat kategori saat memilih (kosong = semua). */
  candidateIds: number[];
  accountId: number;
  description: string | null;
  tanggal: string;
}

interface TransferDraft {
  t: "transfer";
  uid: string;
  amount: number;
  fromId: number;
  toId: number;
  description: string | null;
  tanggal: string;
}

const DIR_TITLE: Record<Direction, string> = { in: "📥 <b>Kas Masuk</b>", out: "📤 <b>Kas Keluar</b>" };

/** Peringatan bila saldo akun akan minus setelah uang keluar sebesar `amount`. */
export async function negativeBalanceWarning(db: D1Database, accountId: number, amount: number): Promise<string | null> {
  const [acc, balance] = await Promise.all([getAccount(db, accountId), accountBalance(db, accountId)]);
  const after = balance - amount;
  if (after >= 0) return null;
  return `⚠️ Saldo ${html(acc?.name ?? "akun")} akan jadi <b>${rupiah(after)}</b> (sekarang ${rupiah(balance)}). Tetap bisa disimpan; pastikan saldo awal / kas masuk sudah dicatat.`;
}

// ---------------------------------------------------------------------------
// Draf kas
// ---------------------------------------------------------------------------

defineDraftType<CashDraft>("cash", {
  async render(ctx, d): Promise<View> {
    const db = ctx.env.DB;
    const note = d.description ? `Catatan: ${html(d.description)}` : null;

    if (d.categoryId === null) {
      const all = await listManualCategories(db, d.direction);
      const shown = d.candidateIds.length ? all.filter((c) => d.candidateIds.includes(c.id)) : all;
      const kb = new InlineKeyboard();
      shown.forEach((c, i) => {
        kb.text(c.name, cb(d, `c:${c.id}`));
        if (i % 2 === 1) kb.row();
      });
      kb.row();
      if (d.candidateIds.length) kb.text("Kategori lain…", cb(d, "lc"));
      kb.text("✖️ Batal", cb(d, "x"));
      return {
        title: `${DIR_TITLE[d.direction]} ${rupiah(d.amount)}`,
        lines: [...(note ? [note] : []), "", "Pilih kategori:"],
        keyboard: kb,
      };
    }

    const [category, account] = await Promise.all([getCategory(db, d.categoryId), getAccount(db, d.accountId)]);
    const kb = await standardKeyboard(ctx, d);
    kb.text("Ganti kategori", cb(d, "lc"));
    const warning = d.direction === "out" ? await negativeBalanceWarning(db, d.accountId, d.amount) : null;
    return {
      title: DIR_TITLE[d.direction],
      lines: [
        `Nominal: <b>${rupiah(d.amount)}</b>`,
        `Kategori: ${html(category?.name ?? "-")}`,
        `Akun: ${html(account?.name ?? "-")}`,
        `Tanggal: ${tanggalPendek(d.tanggal)}`,
        ...(note ? [note] : []),
      ],
      warnings: warning ? [warning] : [],
      keyboard: kb,
    };
  },

  async save(ctx, d) {
    if (d.categoryId === null) throw new Error("draf kas tanpa kategori");
    const tx = await createCashTransaction(
      ctx.env.DB,
      { uid: d.uid, tanggal: d.tanggal, direction: d.direction, amount: d.amount, categoryId: d.categoryId, accountId: d.accountId, description: d.description, source: "bot" },
      actorOf(ctx),
    );
    return { title: `✅ ${DIR_TITLE[d.direction]} tersimpan`, voidData: `v:${tx.id}` };
  },

  async action(ctx, d, action, arg) {
    if (action === "c" && arg !== undefined) {
      if ((await listManualCategories(ctx.env.DB, d.direction)).some((c) => c.id === arg)) {
        d.categoryId = arg;
        d.candidateIds = [];
      }
    } else if (action === "lc") {
      d.categoryId = null;
      d.candidateIds = [];
    } else {
      return null;
    }
    return this.render(ctx, d);
  },
});

// ---------------------------------------------------------------------------
// Draf transfer
// ---------------------------------------------------------------------------

defineDraftType<TransferDraft>("transfer", {
  async render(ctx, d): Promise<View> {
    const db = ctx.env.DB;
    const [from, to] = await Promise.all([getAccount(db, d.fromId), getAccount(db, d.toId)]);
    const warning = await negativeBalanceWarning(db, d.fromId, d.amount);
    return {
      title: "🔁 <b>Transfer Antar Akun</b>",
      lines: [
        `Nominal: <b>${rupiah(d.amount)}</b>`,
        `Dari: ${html(from?.name ?? "-")}`,
        `Ke: ${html(to?.name ?? "-")}`,
        `Tanggal: ${tanggalPendek(d.tanggal)}`,
        ...(d.description ? [`Catatan: ${html(d.description)}`] : []),
      ],
      warnings: warning ? [warning] : [],
      keyboard: await standardKeyboard(ctx, d),
    };
  },

  async save(ctx, d) {
    const t = await createTransfer(
      ctx.env.DB,
      { uid: d.uid, tanggal: d.tanggal, amount: d.amount, fromAccountId: d.fromId, toAccountId: d.toId, description: d.description, source: "bot" },
      actorOf(ctx),
    );
    return { title: "✅ 🔁 <b>Transfer</b> tersimpan", voidData: `v:${t.out.id}` };
  },
});

// ---------------------------------------------------------------------------
// Perintah
// ---------------------------------------------------------------------------

const HELP: Record<Direction, string> = {
  in: "Format: <code>/masuk &lt;nominal&gt; [kategori] [catatan]</code>\nContoh: <code>/masuk 500rb modal awal</code>",
  out: "Format: <code>/keluar &lt;nominal&gt; [kategori] [catatan]</code>\nContoh: <code>/keluar 75rb ongkir jne</code>",
};

async function startCash(ctx: BotContext, direction: Direction, args: string): Promise<void> {
  const parsed = takeAmount(words(args));
  if (!parsed) {
    await ctx.reply(`Nominal tidak dikenali.\n\n${HELP[direction]}`, { parse_mode: "HTML" });
    return;
  }
  const db = ctx.env.DB;
  const categories = await listManualCategories(db, direction);
  const m = matchLeading(parsed.rest, categories);

  let category: Category | null = m.match;
  let candidateIds = m.candidates.map((c) => c.id);
  // /masuk tanpa kategori yang cocok → default "Pendapatan Lain" (§8)
  if (!category && candidateIds.length === 0 && direction === "in") {
    category = categories.find((c) => c.kind === "other_income" && c.is_system === 1) ?? null;
  }
  if (category) candidateIds = [];

  const accounts = await listAccounts(db);
  if (accounts.length === 0) {
    await ctx.reply("Belum ada akun kas aktif. Minta owner menambahkan akun dengan /akun.");
    return;
  }

  await startDraft(ctx, {
    t: "cash",
    uid: newUid(),
    direction,
    amount: parsed.amount,
    categoryId: category?.id ?? null,
    candidateIds,
    accountId: accounts[0]!.id,
    description: m.rest.join(" ").slice(0, 200) || null,
    tanggal: wibDate(),
  } satisfies CashDraft);
}

const TRANSFER_HELP =
  "Format: <code>/transfer &lt;nominal&gt; &lt;dari&gt; &lt;ke&gt; [catatan]</code>\nContoh: <code>/transfer 1jt tunai bca setor</code>";

async function startTransfer(ctx: BotContext, args: string): Promise<void> {
  if (ctx.user!.role === "staff") {
    await ctx.reply("Hanya owner/admin yang bisa transfer antar akun.");
    return;
  }
  const accounts = await listAccounts(ctx.env.DB);
  if (accounts.length < 2) {
    await ctx.reply("Transfer butuh minimal 2 akun kas. Tambahkan akun dulu, misalnya:\n<code>/akun tambah BCA bank</code>", {
      parse_mode: "HTML",
    });
    return;
  }
  const parsed = takeAmount(words(args));
  if (!parsed) {
    await ctx.reply(`Nominal tidak dikenali.\n\n${TRANSFER_HELP}`, { parse_mode: "HTML" });
    return;
  }
  const from = matchLeading(parsed.rest, accounts);
  const to = from.match ? matchLeading(from.rest, accounts) : null;
  if (!from.match || !to?.match) {
    const list = accounts.map((a) => `• ${html(a.name)}`).join("\n");
    await ctx.reply(`Akun asal/tujuan tidak dikenali.\n\n${TRANSFER_HELP}\n\nAkun yang ada:\n${list}`, { parse_mode: "HTML" });
    return;
  }
  if (from.match.id === to.match.id) {
    await ctx.reply("Akun asal dan tujuan tidak boleh sama.");
    return;
  }
  await startDraft(ctx, {
    t: "transfer",
    uid: newUid(),
    amount: parsed.amount,
    fromId: from.match.id,
    toId: to.match.id,
    description: to.rest.join(" ").slice(0, 200) || null,
    tanggal: wibDate(),
  } satisfies TransferDraft);
}

export function registerCash(bot: Bot<BotContext>): void {
  bot.command("masuk", (ctx) => guard(ctx, () => startCash(ctx, "in", ctx.match)));
  bot.command("keluar", (ctx) => guard(ctx, () => startCash(ctx, "out", ctx.match)));
  bot.command("transfer", (ctx) => guard(ctx, () => startTransfer(ctx, ctx.match)));
  bot.callbackQuery(/^v:(\d+)$/, (ctx) =>
    guard(ctx, async () => {
      await voidCashTransaction(ctx.env.DB, Number(ctx.match[1]), "Dibatalkan lewat bot", actorOf(ctx));
      await markVoided(ctx);
    }),
  );
}
