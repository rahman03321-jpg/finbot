/**
 * Kerangka draf bot: ringkasan + [Simpan] [Batal] sebelum data disimpan (ARCHITECTURE.md §8).
 * Satu draf aktif per user di bot_sessions. Callback: d:<8 char uid>:<aksi>[:<angka>].
 * Tiap jenis draf (kas, transfer, penjualan) mendaftarkan DraftType-nya sendiri.
 */
import { InlineKeyboard, type Bot } from "grammy/web";
import type { BotContext } from "./bot";
import { html } from "./format";
import { AppError } from "../lib/errors";
import { clearState, loadState, saveState } from "../services/botSessions";
import { getAccount, listAccounts, type Actor } from "../services/cash";

export interface DraftBase {
  t: string;
  uid: string;
  /** Bila ada, tombol "Ganti akun" tersedia otomatis. */
  accountId?: number;
}

export interface View {
  /** Baris judul draf, mis. "📤 <b>Kas Keluar</b>". */
  title: string;
  /** Isi ringkasan (HTML). Juga dipakai di pesan "tersimpan". */
  lines: string[];
  /** Peringatan yang hanya tampil di draf (mis. saldo minus). */
  warnings?: string[];
  keyboard: InlineKeyboard;
}

export interface Saved {
  /** Judul pesan setelah tersimpan, mis. "✅ 📤 <b>Kas Keluar</b> tersimpan". */
  title: string;
  /** callback_data tombol Batalkan. */
  voidData: string;
}

export interface DraftType<D extends DraftBase> {
  render(ctx: BotContext, d: D): Promise<View>;
  save(ctx: BotContext, d: D): Promise<Saved>;
  /** Aksi khusus jenis ini. Kembalikan View untuk ditampilkan; draf boleh dimutasi (akan disimpan). null = tidak dikenal. */
  action?(ctx: BotContext, d: D, action: string, arg: number | undefined): Promise<View | null>;
}

const types = new Map<string, DraftType<DraftBase>>();

export function defineDraftType<D extends DraftBase>(t: D["t"], def: DraftType<D>): void {
  types.set(t, def as unknown as DraftType<DraftBase>);
}

export function cb(d: DraftBase, action: string): string {
  return `d:${d.uid.slice(0, 8)}:${action}`;
}

export function actorOf(ctx: BotContext): Actor {
  return { id: ctx.user!.id, role: ctx.user!.role };
}

export function isAdmin(ctx: BotContext): boolean {
  return ctx.user?.role === "owner" || ctx.user?.role === "admin";
}

/**
 * Boleh menampilkan HPP/laba di pesan ini? Hanya untuk owner/admin DAN di chat pribadi,
 * karena di grup pesan bot terbaca semua anggota (termasuk staff).
 */
export function canSeeCost(ctx: BotContext): boolean {
  return isAdmin(ctx) && ctx.chat?.type === "private";
}

/** Baris tombol standar: [Simpan][Batal] + [Ganti akun] bila akun > 1. */
export async function standardKeyboard(ctx: BotContext, d: DraftBase, kb = new InlineKeyboard()): Promise<InlineKeyboard> {
  kb.text("✅ Simpan", cb(d, "s")).text("✖️ Batal", cb(d, "x"));
  if (d.accountId !== undefined && (await listAccounts(ctx.env.DB)).length > 1) kb.row().text("Ganti akun", cb(d, "la"));
  return kb;
}

function toText(v: View, withWarnings = true): string {
  let text = [v.title, ...v.lines].join("\n");
  if (withWarnings && v.warnings?.length) text += `\n\n${v.warnings.join("\n")}`;
  return text;
}

async function accountPicker(ctx: BotContext, d: DraftBase): Promise<View> {
  const kb = new InlineKeyboard();
  (await listAccounts(ctx.env.DB)).forEach((a, i) => {
    kb.text(a.id === d.accountId ? `• ${a.name}` : a.name, cb(d, `a:${a.id}`));
    if (i % 2 === 1) kb.row();
  });
  kb.row().text("↩️ Kembali", cb(d, "b"));
  return { title: "Pilih akun kas:", lines: [], keyboard: kb };
}

/** Simpan draf baru & kirim ringkasannya. */
export async function startDraft<D extends DraftBase>(ctx: BotContext, d: D): Promise<void> {
  const def = types.get(d.t);
  if (!def) throw new Error(`draf tidak dikenal: ${d.t}`);
  await saveState(ctx.env.DB, ctx.from!.id, d);
  const v = await def.render(ctx, d);
  await ctx.reply(toText(v), { parse_mode: "HTML", reply_markup: v.keyboard });
}

async function show(ctx: BotContext, v: View): Promise<void> {
  await ctx.editMessageText(toText(v), { parse_mode: "HTML", reply_markup: v.keyboard });
}

async function onButton(ctx: BotContext, uidPrefix: string, action: string, arg: number | undefined): Promise<void> {
  const db = ctx.env.DB;
  const tgId = ctx.from!.id;
  const d = await loadState<DraftBase>(db, tgId);
  const def = d ? types.get(d.t) : undefined;
  if (!d || !def || d.uid.slice(0, 8) !== uidPrefix) {
    // Di grup, tombol draf orang lain juga jatuh ke sini (draf disimpan per user).
    await ctx.answerCallbackQuery({ text: "Draf ini bukan milikmu atau sudah kedaluwarsa. Kirim perintahnya lagi.", show_alert: true });
    if (ctx.chat?.type === "private") await ctx.editMessageReplyMarkup({ reply_markup: undefined }).catch(() => undefined);
    return;
  }

  if (action === "s") {
    const view = await def.render(ctx, d);
    const saved = await def.save(ctx, d);
    await clearState(db, tgId);
    await ctx.editMessageText([saved.title, ...view.lines].join("\n"), {
      parse_mode: "HTML",
      reply_markup: new InlineKeyboard().text("↩️ Batalkan", saved.voidData),
    });
    await ctx.answerCallbackQuery({ text: "Tersimpan" });
    return;
  }
  if (action === "x") {
    await clearState(db, tgId);
    await ctx.editMessageText("✖️ Dibatalkan, tidak ada yang disimpan.");
    await ctx.answerCallbackQuery();
    return;
  }

  let view: View | null = null;
  if (action === "la" && d.accountId !== undefined) {
    view = await accountPicker(ctx, d);
  } else if (action === "a" && arg !== undefined && d.accountId !== undefined) {
    const acc = await getAccount(db, arg);
    if (acc?.is_active) d.accountId = acc.id;
    await saveState(db, tgId, d);
    view = await def.render(ctx, d);
  } else if (action === "b") {
    view = await def.render(ctx, d);
  } else if (def.action) {
    view = await def.action(ctx, d, action, arg);
    if (view) await saveState(db, tgId, d);
  }
  if (view) await show(ctx, view);
  await ctx.answerCallbackQuery();
}

/** Ubah pesan "tersimpan" menjadi "dibatalkan" setelah void berhasil. */
export async function markVoided(ctx: BotContext): Promise<void> {
  const msg = ctx.callbackQuery?.message;
  const original = msg && "text" in msg ? (msg.text ?? "") : "";
  const body = original.replace(/^.*\n/, "");
  await ctx.editMessageText(`❌ <b>Dibatalkan</b>\n<s>${html(body)}</s>`, { parse_mode: "HTML" });
  await ctx.answerCallbackQuery({ text: "Transaksi dibatalkan" });
}

/** Tampilkan AppError sebagai alert di tombol / balasan di chat; error lain diteruskan ke bot.catch. */
export async function guard(ctx: BotContext, fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (e) {
    if (!(e instanceof AppError)) throw e;
    if (ctx.callbackQuery) await ctx.answerCallbackQuery({ text: e.message, show_alert: true });
    else await ctx.reply(e.message);
  }
}

export function words(s: string): string[] {
  return s.trim().split(/\s+/).filter(Boolean);
}

export function registerDrafts(bot: Bot<BotContext>): void {
  bot.callbackQuery(/^d:([0-9a-f]{8}):([a-z]+)(?::(\d+))?$/, (ctx) =>
    guard(ctx, () => onButton(ctx, ctx.match[1]!, ctx.match[2]!, ctx.match[3] === undefined ? undefined : Number(ctx.match[3]))),
  );
}
