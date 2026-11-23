/** /user: kelola anggota usaha (owner saja). */
import type { Bot } from "grammy/web";
import type { BotContext } from "../bot";
import { matchLeading } from "../parsers/match";
import { html } from "../format";
import { actorOf, guard, words } from "../drafts";
import { addUser, createInvite, listUsers, updateUser, type MemberRole, type User } from "../../services/users";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" } as const;
const ROLE_WORDS: Record<string, MemberRole> = { admin: "admin", staff: "staff", staf: "staff", karyawan: "staff" };

const HELP = [
  "<b>Kelola user</b> (owner)",
  "<code>/user</code>: daftar user",
  "<code>/user undang [staff|admin]</code>: buat tautan undangan sekali pakai (24 jam). Kirim tautannya ke orang tersebut.",
  "<code>/user tambah [staff|admin]</code>: <i>balas (reply)</i> pesan orang tersebut di grup dengan perintah ini.",
  "<code>/user ubah &lt;nama|@username&gt; &lt;staff|admin&gt;</code>",
  "<code>/user nonaktif &lt;nama|@username&gt;</code> · <code>/user aktif &lt;nama|@username&gt;</code>",
  "",
  "Admin: input transaksi, kelola produk, lihat HPP/laba & laporan.",
  "Staff: input transaksi saja, tanpa HPP/laba/laporan.",
].join("\n");

function label(u: User): string {
  const uname = u.username ? ` (@${html(u.username)})` : "";
  const inactive = u.is_active ? "" : " · <i>nonaktif</i>";
  return `${html(u.full_name)}${uname}: ${ROLE_LABEL[u.role]}${inactive}`;
}

/** Cari user dari "@username" atau nama (awalan). */
function findTarget(users: User[], ws: string[]): { user: User | null; rest: string[]; ambiguous: User[] } {
  const first = ws[0] ?? "";
  if (first.startsWith("@")) {
    const u = users.find((x) => x.username?.toLowerCase() === first.slice(1).toLowerCase()) ?? null;
    return { user: u, rest: ws.slice(1), ambiguous: [] };
  }
  const named = users.map((u) => ({ ...u, name: u.full_name }));
  const m = matchLeading(ws, named);
  return { user: m.match, rest: m.rest, ambiguous: m.candidates };
}

async function user(ctx: BotContext): Promise<void> {
  if (ctx.user!.role !== "owner") {
    await ctx.reply("Hanya owner yang bisa mengelola user.");
    return;
  }
  const db = ctx.env.DB;
  const ws = words(typeof ctx.match === "string" ? ctx.match : "");
  const sub = ws[0]?.toLowerCase();
  const actor = actorOf(ctx);

  if (!sub) {
    const users = await listUsers(db);
    await ctx.reply(`👥 <b>User</b> (${users.length})\n${users.map((u) => `• ${label(u)}`).join("\n")}\n\n${HELP}`, { parse_mode: "HTML" });
    return;
  }

  if (sub === "undang") {
    if (ctx.chat?.type !== "private") {
      await ctx.reply("Buat undangan lewat chat pribadi dengan bot, supaya tautannya tidak dipakai orang lain di grup.");
      return;
    }
    const role = ROLE_WORDS[ws[1]?.toLowerCase() ?? ""] ?? "staff";
    const inv = await createInvite(db, role, actor);
    const link = `https://t.me/${ctx.me.username}?start=join_${inv.code}`;
    await ctx.reply(
      [
        `🔗 Tautan undangan <b>${ROLE_LABEL[role]}</b> (sekali pakai, berlaku 24 jam):`,
        link,
        "",
        "Kirim tautan ini ke orangnya. Setelah dia membuka tautan dan menekan Start, dia langsung terdaftar.",
      ].join("\n"),
      { parse_mode: "HTML", link_preview_options: { is_disabled: true } },
    );
    return;
  }

  if (sub === "tambah") {
    const target = ctx.msg?.reply_to_message?.from;
    if (!target || target.is_bot) {
      await ctx.reply(
        "Balas (reply) pesan orang yang mau ditambahkan dengan <code>/user tambah staff</code>.\nAtau buat tautan undangan dengan <code>/user undang</code> di chat pribadi.",
        { parse_mode: "HTML" },
      );
      return;
    }
    const role = ROLE_WORDS[ws[1]?.toLowerCase() ?? ""] ?? "staff";
    const u = await addUser(
      db,
      { telegramId: target.id, username: target.username, fullName: [target.first_name, target.last_name].filter(Boolean).join(" ") },
      role,
      actor,
    );
    await ctx.reply(`✅ ${label(u)} ditambahkan.`, { parse_mode: "HTML" });
    return;
  }

  if (sub === "ubah" || sub === "nonaktif" || sub === "aktif") {
    const users = (await listUsers(db)).filter((u) => u.role !== "owner");
    const t = findTarget(users, ws.slice(1));
    if (!t.user) {
      const hint = t.ambiguous.length ? `Ada beberapa yang cocok: ${t.ambiguous.map((u) => html(u.full_name)).join(", ")}. Tulis lebih lengkap.` : "User tidak ditemukan.";
      await ctx.reply(`${hint}\n\n${HELP}`, { parse_mode: "HTML" });
      return;
    }
    let change: { role?: MemberRole; isActive?: boolean };
    if (sub === "ubah") {
      const role = ROLE_WORDS[t.rest[0]?.toLowerCase() ?? ""];
      if (!role) {
        await ctx.reply("Sebutkan peran baru: staff atau admin.");
        return;
      }
      change = { role };
    } else {
      change = { isActive: sub === "aktif" };
    }
    const u = await updateUser(db, t.user.id, change, actor);
    await ctx.reply(`✅ ${label(u)}`, { parse_mode: "HTML" });
    return;
  }

  await ctx.reply(HELP, { parse_mode: "HTML" });
}

export function registerUsers(bot: Bot<BotContext>): void {
  bot.command("user", (ctx) => guard(ctx, () => user(ctx)));
}
