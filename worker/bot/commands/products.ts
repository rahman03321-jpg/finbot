/** /produk: daftar, tambah, ubah HPP/harga. */
import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { takeAmount } from "../parsers/amount";
import { matchLeading } from "../parsers/match";
import { html, rupiah } from "../format";
import { actorOf, canSeeCost, guard, isAdmin, words } from "../drafts";
import { createProduct, deleteProduct, listProducts, updateProduct, type Product } from "../../services/products";

const KEYWORDS: Record<string, "cost" | "sell"> = { hpp: "cost", modal: "cost", jual: "sell", harga: "sell" };

const HELP = [
  "<b>Kelola produk</b>",
  "<code>/produk</code>: daftar produk",
  "<code>/produk tambah &lt;nama&gt; hpp &lt;nominal&gt; jual &lt;nominal&gt;</code>",
  "<code>/produk ubah &lt;nama&gt; [hpp &lt;nominal&gt;] [jual &lt;nominal&gt;]</code>",
  "<code>/produk hapus &lt;nama&gt;</code>: nonaktifkan (penjualan lama tetap ada)",
  "Contoh: <code>/produk tambah Salep Kulit hpp 12rb jual 20rb</code>",
].join("\n");

export interface ParsedProductArgs {
  name: string;
  cost?: number;
  sell?: number;
}

/** "Salep Kulit hpp 12rb jual 20rb" → { name, cost, sell }. null bila nominal tidak valid. */
export function parseProductArgs(ws: string[]): ParsedProductArgs | null {
  const idx = ws.findIndex((w) => KEYWORDS[w.toLowerCase()] !== undefined);
  const name = (idx < 0 ? ws : ws.slice(0, idx)).join(" ").trim();
  const out: ParsedProductArgs = { name };
  let rest = idx < 0 ? [] : ws.slice(idx);
  while (rest.length) {
    const key = KEYWORDS[rest[0]!.toLowerCase()];
    if (!key) return null;
    const amt = takeAmount(rest.slice(1));
    if (!amt) return null;
    if (key === "cost") out.cost = amt.amount;
    else out.sell = amt.amount;
    rest = amt.rest;
  }
  return out;
}

function margin(p: Pick<Product, "cost_price" | "sell_price">): string {
  if (p.sell_price <= 0) return "";
  const pct = Math.round(((p.sell_price - p.cost_price) * 100) / p.sell_price);
  return ` · margin ${pct}%`;
}

function describe(ctx: BotContext, p: Product): string {
  const base = `<b>${html(p.name)}</b>: jual ${rupiah(p.sell_price)}`;
  return canSeeCost(ctx) ? `${base} · HPP ${rupiah(p.cost_price)}${margin(p)}` : base;
}

async function produk(ctx: BotContext): Promise<void> {
  const ws = words(typeof ctx.match === "string" ? ctx.match : "");
  const sub = ws[0]?.toLowerCase();
  const db = ctx.env.DB;

  if (sub === "hapus") {
    if (!isAdmin(ctx)) {
      await ctx.reply("Hanya owner/admin yang bisa mengelola produk.");
      return;
    }
    const m = matchLeading(ws.slice(1), await listProducts(db));
    if (!m.match || m.rest.length > 0) {
      await ctx.reply("Produk tidak ditemukan (atau namanya kurang lengkap). Lihat daftar dengan /produk.");
      return;
    }
    await deleteProduct(db, m.match.id, actorOf(ctx));
    await ctx.reply(`🗑 Produk <b>${html(m.match.name)}</b> dihapus. Penjualan lama tetap tercatat.`, { parse_mode: "HTML" });
    return;
  }

  if (sub === "tambah" || sub === "ubah") {
    if (!isAdmin(ctx)) {
      await ctx.reply("Hanya owner/admin yang bisa mengelola produk.");
      return;
    }
    const parsed = parseProductArgs(ws.slice(1));
    if (!parsed || !parsed.name) {
      await ctx.reply(HELP, { parse_mode: "HTML" });
      return;
    }

    if (sub === "tambah") {
      if (parsed.sell === undefined) {
        await ctx.reply(`Harga jual wajib diisi.\n\n${HELP}`, { parse_mode: "HTML" });
        return;
      }
      const p = await createProduct(db, { name: parsed.name, costPrice: parsed.cost ?? 0, sellPrice: parsed.sell }, actorOf(ctx));
      const hppNote = parsed.cost === undefined && canSeeCost(ctx) ? "\n⚠️ HPP belum diisi (0). Ubah dengan /produk ubah." : "";
      await ctx.reply(`✅ Produk ditambahkan\n${describe(ctx, p)}${hppNote}`, { parse_mode: "HTML" });
      return;
    }

    // ubah
    if (parsed.cost === undefined && parsed.sell === undefined) {
      await ctx.reply(`Isi HPP dan/atau harga jual baru.\n\n${HELP}`, { parse_mode: "HTML" });
      return;
    }
    const m = matchLeading(words(parsed.name), await listProducts(db));
    if (!m.match || m.rest.length > 0) {
      await ctx.reply("Produk tidak ditemukan (atau namanya kurang lengkap). Lihat daftar dengan /produk.");
      return;
    }
    const p = await updateProduct(
      db,
      m.match.id,
      { ...(parsed.cost !== undefined ? { costPrice: parsed.cost } : {}), ...(parsed.sell !== undefined ? { sellPrice: parsed.sell } : {}) },
      actorOf(ctx),
    );
    await ctx.reply(`✅ Produk diperbarui\n${describe(ctx, p)}\n\nTransaksi lama tidak berubah.`, { parse_mode: "HTML" });
    return;
  }

  const products = await listProducts(db, { q: ws.join(" ") || undefined });
  if (products.length === 0) {
    const footer = isAdmin(ctx) ? `\n\n${HELP}` : "";
    await ctx.reply(`Belum ada produk${ws.length ? " yang cocok" : ""}.${footer}`, { parse_mode: "HTML" });
    return;
  }
  const lines = products.map((p) => `• ${describe(ctx, p)}`);
  const footer = isAdmin(ctx) && ws.length === 0 ? `\n\n${HELP}` : "";
  await ctx.reply(`📦 <b>Produk</b> (${products.length})\n${lines.join("\n")}${footer}`, { parse_mode: "HTML" });
}

export function registerProducts(bot: Bot<BotContext>): void {
  bot.command("produk", (ctx) => guard(ctx, () => produk(ctx)));
}
