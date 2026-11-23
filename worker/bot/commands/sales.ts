/**
 * /omzet (penjualan cepat) & /jual (dari master produk) — ARCHITECTURE.md §8, §9.1.
 */
import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { parseAmount, takeAmount } from "../parsers/amount";
import { matchLeading } from "../parsers/match";
import { html, rupiah, tanggalPendek } from "../format";
import { actorOf, canSeeCost, defineDraftType, guard, markVoided, standardKeyboard, startDraft, words, type View } from "../drafts";
import { wibDate } from "../../lib/date";
import { newUid } from "../../lib/crypto";
import { getAccount, listAccounts } from "../../services/cash";
import { getFeatures } from "../../services/features";
import { getProduct, listProducts } from "../../services/products";
import { createSale, voidSale, type SaleItemInput } from "../../services/sales";
import { CHANNEL_ALIASES, listChannels, type Channel } from "../../services/masters";

/** Cari kata yang cocok dengan channel aktif (code, nama tanpa spasi, atau singkatan); sisanya jadi catatan. */
export function extractChannel(ws: string[], channels: Pick<Channel, "code" | "name">[]): { channel: string; rest: string[] } {
  const norm = (x: string) => x.toLowerCase().replace(/[^a-z0-9]/g, "");
  const lookup = new Map<string, string>();
  for (const c of channels) {
    lookup.set(norm(c.code), c.code);
    lookup.set(norm(c.name), c.code);
  }
  for (const [alias, code] of Object.entries(CHANNEL_ALIASES)) {
    if (channels.some((c) => c.code === code) && !lookup.has(alias)) lookup.set(alias, code);
  }
  const idx = ws.findIndex((w) => lookup.has(norm(w)));
  if (idx < 0) return { channel: "offline", rest: ws };
  return { channel: lookup.get(norm(ws[idx]!))!, rest: [...ws.slice(0, idx), ...ws.slice(idx + 1)] };
}

const QUICK_ITEM_NAME = "Penjualan cepat";

interface SaleDraft {
  t: "sale";
  uid: string;
  quick: boolean;
  items: SaleItemInput[];
  accountId: number;
  channel: string;
  note: string | null;
  tanggal: string;
  /** Untuk penjualan cepat: apakah user mengisi HPP. */
  hppGiven: boolean;
}

interface ItemLine {
  name: string;
  qty: number;
  price: number;
  cost: number;
  stock: number | null;
}

async function resolveItems(db: D1Database, items: SaleItemInput[], stockOn: boolean): Promise<ItemLine[]> {
  const out: ItemLine[] = [];
  for (const it of items) {
    if ("productId" in it) {
      const p = await getProduct(db, it.productId);
      out.push({
        name: p?.name ?? "?",
        qty: it.qty,
        price: it.sellPrice ?? p?.sell_price ?? 0,
        cost: p?.cost_price ?? 0,
        stock: stockOn && p?.track_stock ? p.stock : null,
      });
    } else {
      out.push({ name: it.itemName, qty: it.qty, price: it.sellPrice, cost: it.costPrice ?? 0, stock: null });
    }
  }
  return out;
}

defineDraftType<SaleDraft>("sale", {
  async render(ctx, d): Promise<View> {
    const db = ctx.env.DB;
    const features = await getFeatures(db);
    const [lines, account] = await Promise.all([resolveItems(db, d.items, features.stock), getAccount(db, d.accountId)]);
    const total = lines.reduce((n, l) => n + l.qty * l.price, 0);
    const hpp = lines.reduce((n, l) => n + l.qty * l.cost, 0);
    const showCost = canSeeCost(ctx);

    const body: string[] = [];
    if (!d.quick) {
      for (const l of lines) body.push(`• ${html(l.name)} × ${l.qty} @ ${rupiah(l.price)} = ${rupiah(l.qty * l.price)}`);
    }
    body.push(`Omzet: <b>${rupiah(total)}</b>`);
    if (showCost) {
      body.push(`HPP: ${rupiah(hpp)}`);
      body.push(`Laba kotor: <b>${rupiah(total - hpp)}</b>`);
    }
    body.push(`Akun: ${html(account?.name ?? "-")}`);
    if (d.channel !== "offline") {
      const ch = (await listChannels(db, false)).find((c) => c.code === d.channel);
      body.push(`Channel: ${html(ch?.name ?? d.channel)}`);
    }
    body.push(`Tanggal: ${tanggalPendek(d.tanggal)}`);
    if (d.note) body.push(`Catatan: ${html(d.note)}`);

    const warnings: string[] = [];
    if (d.quick && !d.hppGiven) {
      warnings.push(
        showCost
          ? "⚠️ HPP kosong, jadi laba kotor = omzet. Tambahkan <code>hpp &lt;nominal&gt;</code> kalau ada modal barangnya."
          : "⚠️ HPP belum diisi.",
      );
    }
    for (const l of lines) {
      if (l.stock !== null && l.stock - l.qty < 0) warnings.push(`⚠️ Stok ${html(l.name)} tinggal ${l.stock}, akan jadi ${l.stock - l.qty}.`);
    }

    return {
      title: d.quick ? "🧾 <b>Penjualan cepat</b>" : "🧾 <b>Penjualan</b>",
      lines: body,
      warnings,
      keyboard: await standardKeyboard(ctx, d),
    };
  },

  async save(ctx, d) {
    const sale = await createSale(
      ctx.env.DB,
      { uid: d.uid, tanggal: d.tanggal, channel: d.channel, items: d.items, accountId: d.accountId, note: d.note, source: "bot" },
      actorOf(ctx),
    );
    return { title: `✅ 🧾 <b>${html(sale.invoice_no)}</b> tersimpan`, voidData: `vs:${sale.id}` };
  },
});

// ---------------------------------------------------------------------------
// Perintah
// ---------------------------------------------------------------------------

const OMZET_HELP = [
  "Format: <code>/omzet &lt;nominal&gt; [hpp &lt;nominal&gt;] [channel] [catatan]</code>",
  "Contoh: <code>/omzet 1,5jt hpp 900rb shopee</code>",
].join("\n");

async function defaultAccountId(ctx: BotContext): Promise<number | null> {
  const accounts = await listAccounts(ctx.env.DB);
  if (accounts.length === 0) {
    await ctx.reply("Belum ada akun kas aktif. Minta owner menambahkan akun dengan /akun.");
    return null;
  }
  return accounts[0]!.id;
}

async function startOmzet(ctx: BotContext, args: string): Promise<void> {
  const parsed = takeAmount(words(args));
  if (!parsed) {
    await ctx.reply(`Nominal tidak dikenali.\n\n${OMZET_HELP}`, { parse_mode: "HTML" });
    return;
  }
  let rest = parsed.rest;
  let hpp: number | null = null;
  if (rest[0] && ["hpp", "modal"].includes(rest[0].toLowerCase())) {
    const h = takeAmount(rest.slice(1));
    if (!h) {
      await ctx.reply(`HPP tidak dikenali.\n\n${OMZET_HELP}`, { parse_mode: "HTML" });
      return;
    }
    hpp = h.amount;
    rest = h.rest;
  }
  const { channel, rest: noteWords } = extractChannel(rest, await listChannels(ctx.env.DB));
  const accountId = await defaultAccountId(ctx);
  if (accountId === null) return;

  await startDraft(ctx, {
    t: "sale",
    uid: newUid(),
    quick: true,
    items: [{ itemName: QUICK_ITEM_NAME, qty: 1, sellPrice: parsed.amount, costPrice: hpp ?? 0 }],
    accountId,
    channel,
    note: noteWords.join(" ").slice(0, 200) || null,
    tanggal: wibDate(),
    hppGiven: hpp !== null,
  } satisfies SaleDraft);
}

const JUAL_HELP = [
  "Format: <code>/jual &lt;produk&gt; [qty] [harga] [channel] [catatan]</code>",
  "Contoh: <code>/jual salep 3</code> · <code>/jual salep 2 18rb shopee</code>",
].join("\n");

/** "3", "x3", "3x", "3pcs" → 3 */
function parseQty(w: string | undefined): number | null {
  if (!w) return null;
  const m = /^x?(\d{1,6})(x|pcs)?$/i.exec(w);
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 ? n : null;
}

async function startJual(ctx: BotContext, args: string): Promise<void> {
  const db = ctx.env.DB;
  const products = await listProducts(db);
  if (products.length === 0) {
    await ctx.reply(
      "Belum ada produk. Tambahkan dulu, misalnya:\n<code>/produk tambah Salep hpp 12rb jual 20rb</code>\n\nAtau catat omzet tanpa produk dengan /omzet.",
      { parse_mode: "HTML" },
    );
    return;
  }
  const ws = words(args);
  if (ws.length === 0) {
    await ctx.reply(JUAL_HELP, { parse_mode: "HTML" });
    return;
  }
  const m = matchLeading(ws, products);
  if (!m.match) {
    const hint = m.candidates.length
      ? `Ada beberapa produk yang mirip:\n${m.candidates.map((p) => `• ${html(p.name)}`).join("\n")}\n\nTulis nama produknya lebih lengkap.`
      : "Produk tidak ditemukan. Lihat daftar produk dengan /produk.";
    await ctx.reply(`${hint}\n\n${JUAL_HELP}`, { parse_mode: "HTML" });
    return;
  }

  let rest = m.rest;
  let qty = 1;
  const q = parseQty(rest[0]);
  if (q !== null) {
    qty = q;
    rest = rest.slice(1);
  }
  let sellPrice: number | undefined;
  if (rest[0]) {
    const price = parseAmount(rest[0].replace(/^@/, ""));
    if (price !== null) {
      sellPrice = price;
      rest = rest.slice(1);
    }
  }
  const { channel, rest: noteWords } = extractChannel(rest, await listChannels(ctx.env.DB));
  const accountId = await defaultAccountId(ctx);
  if (accountId === null) return;

  await startDraft(ctx, {
    t: "sale",
    uid: newUid(),
    quick: false,
    items: [{ productId: m.match.id, qty, ...(sellPrice !== undefined ? { sellPrice } : {}) }],
    accountId,
    channel,
    note: noteWords.join(" ").slice(0, 200) || null,
    tanggal: wibDate(),
    hppGiven: true,
  } satisfies SaleDraft);
}

export function registerSales(bot: Bot<BotContext>): void {
  bot.command("omzet", (ctx) => guard(ctx, () => startOmzet(ctx, ctx.match)));
  bot.command("jual", (ctx) => guard(ctx, () => startJual(ctx, ctx.match)));
  bot.callbackQuery(/^vs:(\d+)$/, (ctx) =>
    guard(ctx, async () => {
      await voidSale(ctx.env.DB, Number(ctx.match[1]), "Dibatalkan lewat bot", actorOf(ctx), { voidDate: wibDate() });
      await markVoided(ctx);
    }),
  );
}
