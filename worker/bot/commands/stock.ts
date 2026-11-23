/** /stok & /restock (modul stok, ARCHITECTURE.md §8, §9.4). */
import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { takeAmount } from "../parsers/amount";
import { matchLeading } from "../parsers/match";
import { html, rupiah, tanggalPendek } from "../format";
import { actorOf, canSeeCost, defineDraftType, guard, isAdmin, markVoided, standardKeyboard, startDraft, words, type View } from "../drafts";
import { negativeBalanceWarning } from "./cash";
import { wibDate } from "../../lib/date";
import { newUid } from "../../lib/crypto";
import { getAccount, listAccounts } from "../../services/cash";
import { getFeatures } from "../../services/features";
import { getProduct, listProducts } from "../../services/products";
import { createPurchase, voidPurchase } from "../../services/purchases";

const OFF = "Fitur stok belum diaktifkan. Owner bisa mengaktifkannya di aplikasi: ⚙ Pengaturan → Modul stok.";

async function stok(ctx: BotContext): Promise<void> {
  if (!(await getFeatures(ctx.env.DB)).stock) {
    await ctx.reply(OFF);
    return;
  }
  const q = typeof ctx.match === "string" ? ctx.match.trim() : "";
  const products = (await listProducts(ctx.env.DB, { q: q || undefined })).filter((p) => p.track_stock);
  if (!products.length) {
    await ctx.reply(q ? "Produk tidak ditemukan." : "Belum ada produk yang dilacak stoknya.");
    return;
  }
  const lines = products.map((p) => {
    const low = p.stock <= p.min_stock;
    const flag = p.stock <= 0 ? " ⛔️ habis" : low ? ` ⚠️ (min ${p.min_stock})` : "";
    return `• ${html(p.name)}: <b>${p.stock}</b> ${html(p.unit)}${flag}`;
  });
  const lowCount = products.filter((p) => p.stock <= p.min_stock).length;
  const head = `📦 <b>Stok</b>${lowCount ? ` · ${lowCount} perlu restock` : ""}`;
  await ctx.reply([head, ...lines.slice(0, 80), products.length > 80 ? `…dan ${products.length - 80} lainnya` : ""].filter(Boolean).join("\n"), {
    parse_mode: "HTML",
  });
}

// ---------------------------------------------------------------------------

interface PurchaseDraft {
  t: "purchase";
  uid: string;
  productId: number;
  qty: number;
  unitCost: number;
  accountId: number;
  supplier: string | null;
  tanggal: string;
}

defineDraftType<PurchaseDraft>("purchase", {
  async render(ctx, d): Promise<View> {
    const db = ctx.env.DB;
    const [p, acc] = await Promise.all([getProduct(db, d.productId), getAccount(db, d.accountId)]);
    const total = d.qty * d.unitCost;
    const lines = [
      `Produk: <b>${html(p?.name ?? "-")}</b>`,
      `${d.qty} ${html(p?.unit ?? "pcs")} × ${rupiah(d.unitCost)} = <b>${rupiah(total)}</b>`,
    ];
    if (p?.track_stock) lines.push(`Stok: ${p.stock} → <b>${p.stock + d.qty}</b>`);
    if (p && canSeeCost(ctx)) {
      const after = p.track_stock && p.stock > 0 ? Math.round((p.stock * p.cost_price + total) / (p.stock + d.qty)) : d.unitCost;
      lines.push(after === p.cost_price ? `HPP tetap ${rupiah(p.cost_price)}` : `HPP rata-rata: ${rupiah(p.cost_price)} → <b>${rupiah(after)}</b>`);
    }
    lines.push(`Dibayar dari: ${html(acc?.name ?? "-")}`);
    if (d.supplier) lines.push(`Supplier: ${html(d.supplier)}`);
    lines.push(`Tanggal: ${tanggalPendek(d.tanggal)}`);
    const warn = await negativeBalanceWarning(db, d.accountId, total);
    return { title: "🛒 <b>Restock</b>", lines, warnings: warn ? [warn] : [], keyboard: await standardKeyboard(ctx, d) };
  },
  async save(ctx, d) {
    const r = await createPurchase(
      ctx.env.DB,
      {
        uid: d.uid,
        tanggal: d.tanggal,
        supplier: d.supplier,
        items: [{ productId: d.productId, qty: d.qty, unitCost: d.unitCost }],
        accountId: d.accountId,
        updateCost: "average",
        source: "bot",
      },
      actorOf(ctx),
    );
    return { title: "✅ 🛒 <b>Restock</b> tersimpan", voidData: `vp:${r.id}` };
  },
});

const RESTOCK_HELP = [
  "Format: <code>/restock &lt;produk&gt; &lt;qty&gt; &lt;harga beli satuan&gt; [supplier]</code>",
  "Contoh: <code>/restock salep 10 12rb toko abc</code>",
  "HPP produk diperbarui otomatis (rata-rata tertimbang). Kas keluar dicatat sebagai Belanja Stok.",
].join("\n");

async function restock(ctx: BotContext): Promise<void> {
  const db = ctx.env.DB;
  if (!(await getFeatures(db)).stock) {
    await ctx.reply(OFF);
    return;
  }
  if (!isAdmin(ctx)) {
    await ctx.reply("Hanya owner/admin yang bisa mencatat restock.");
    return;
  }
  const ws = words(typeof ctx.match === "string" ? ctx.match : "");
  const products = await listProducts(db);
  const m = matchLeading(ws, products);
  if (!m.match) {
    const hint = m.candidates.length ? `Produk yang mirip: ${m.candidates.map((p) => html(p.name)).join(", ")}.` : "Produk tidak ditemukan.";
    await ctx.reply(`${ws.length ? `${hint}\n\n` : ""}${RESTOCK_HELP}`, { parse_mode: "HTML" });
    return;
  }
  const qtyWord = m.rest[0] ?? "";
  const qty = /^\d{1,6}$/.test(qtyWord) ? Number(qtyWord) : 0;
  const cost = qty > 0 ? takeAmount(m.rest.slice(1)) : null;
  if (qty <= 0 || !cost) {
    await ctx.reply(`Jumlah atau harga beli tidak dikenali.\n\n${RESTOCK_HELP}`, { parse_mode: "HTML" });
    return;
  }
  const accounts = await listAccounts(db);
  if (!accounts.length) {
    await ctx.reply("Belum ada akun kas aktif.");
    return;
  }
  await startDraft(ctx, {
    t: "purchase",
    uid: newUid(),
    productId: m.match.id,
    qty,
    unitCost: cost.amount,
    accountId: accounts[0]!.id,
    supplier: cost.rest.join(" ").slice(0, 80) || null,
    tanggal: wibDate(),
  } satisfies PurchaseDraft);
}

export function registerStock(bot: Bot<BotContext>): void {
  bot.command("stok", (ctx) => guard(ctx, () => stok(ctx)));
  bot.command("restock", (ctx) => guard(ctx, () => restock(ctx)));
  bot.callbackQuery(/^vp:(\d+)$/, (ctx) =>
    guard(ctx, async () => {
      const r = await voidPurchase(ctx.env.DB, Number(ctx.match[1]), "Dibatalkan lewat bot", actorOf(ctx), { voidDate: wibDate() });
      await markVoided(ctx);
      if (r.warnings.length) await ctx.reply(`⚠️ ${r.warnings.join(" ")}`);
    }),
  );
}
