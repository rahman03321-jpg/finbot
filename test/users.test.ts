import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { getWebhookSecret, setSetting } from "../worker/services/settings";
import { acceptInvite, addUser, createInvite, findActiveUser, updateUser, type User } from "../worker/services/users";
import { BOT_INFO, GROUP_ID, mockTelegram, privateMessage, useFreshDb } from "./helpers";

const OWNER_TG = 111;
let ownerActor: { id: number; role: "owner" };

describe("kelola user", () => {
  useFreshDb();
  let secret = "";

  beforeEach(async () => {
    await setSetting(env.DB, "bot_info", JSON.stringify(BOT_INFO));
    secret = await getWebhookSecret(env);
    const r = await env.DB.prepare("INSERT INTO users (telegram_id, full_name, username, role) VALUES (?1, 'Budi', 'budi', 'owner') RETURNING id")
      .bind(OWNER_TG)
      .first<{ id: number }>();
    ownerActor = { id: r!.id, role: "owner" };
  });

  async function send(update: unknown) {
    const tg = mockTelegram();
    const req = new Request("https://finbot.contoh.workers.dev/webhook/tg", {
      method: "POST",
      body: JSON.stringify(update),
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    });
    await handleTelegramWebhook(req, env, { apiTransformer: tg.transformer });
    return tg;
  }
  const lastText = (tg: ReturnType<typeof mockTelegram>) =>
    String([...tg.calls].reverse().find((c) => c.method === "sendMessage")?.payload["text"] ?? "");

  it("undangan: sekali pakai, kedaluwarsa ditolak, owner tidak turun peran", async () => {
    const inv = await createInvite(env.DB, "admin", ownerActor);
    const sari = await acceptInvite(env.DB, inv.code, { telegramId: 222, fullName: "Sari", username: "sari" });
    expect(sari).toMatchObject({ role: "admin", is_active: 1 });
    await expect(acceptInvite(env.DB, inv.code, { telegramId: 333, fullName: "Joko" })).rejects.toMatchObject({ code: "INVITE_INVALID" });

    const lama = await createInvite(env.DB, "staff", ownerActor, new Date(Date.now() - 25 * 3600_000));
    await expect(acceptInvite(env.DB, lama.code, { telegramId: 333, fullName: "Joko" })).rejects.toMatchObject({ code: "INVITE_INVALID" });

    const inv2 = await createInvite(env.DB, "staff", ownerActor);
    const own = await acceptInvite(env.DB, inv2.code, { telegramId: OWNER_TG, fullName: "Budi" });
    expect(own.role).toBe("owner");

    const used = await env.DB.prepare("SELECT used_by FROM user_invites WHERE code = ?1").bind(inv.code).first<{ used_by: number }>();
    expect(used!.used_by).toBe(sari.id);
    const audit = await env.DB.prepare("SELECT action FROM audit_log ORDER BY id").all<{ action: string }>();
    expect(audit.results.map((a) => a.action)).toEqual(["user.invite", "user.join", "user.invite", "user.invite", "user.join"]);
  });

  it("hanya owner yang bisa mengundang/menambah/mengubah", async () => {
    const admin = { id: 99, role: "admin" as const };
    await expect(createInvite(env.DB, "staff", admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(addUser(env.DB, { telegramId: 5, fullName: "X" }, "staff", admin)).rejects.toMatchObject({ code: "FORBIDDEN" });
  });

  it("nonaktif: tidak bisa memakai bot; aktif lagi bisa; owner tidak bisa diubah", async () => {
    const u: User = await addUser(env.DB, { telegramId: 222, fullName: "Sari" }, "staff", ownerActor);
    await updateUser(env.DB, u.id, { isActive: false }, ownerActor);
    expect(await findActiveUser(env.DB, 222)).toBeNull();
    await updateUser(env.DB, u.id, { isActive: true, role: "admin" }, ownerActor);
    expect(await findActiveUser(env.DB, 222)).toMatchObject({ role: "admin" });
    await expect(updateUser(env.DB, ownerActor.id, { role: "staff" }, ownerActor)).rejects.toMatchObject({ code: "IS_OWNER" });
  });

  it("bot: /user undang → tautan → /start join_<kode> → terdaftar & bisa mencatat", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/user undang staff"));
    const link = /https:\/\/t\.me\/finbot_test_bot\?start=join_([0-9a-f]+)/.exec(lastText(t1));
    expect(link).not.toBeNull();

    const t2 = await send(privateMessage(222, `/start join_${link![1]}`, "Sari"));
    expect(lastText(t2)).toContain("terdaftar sebagai Staff");

    const t3 = await send(privateMessage(222, "/keluar 10rb iklan", "Sari"));
    expect(lastText(t3)).toContain("Kas Keluar");
  });

  it("bot: /user undang di grup ditolak", async () => {
    const tg = await send({
      update_id: 9001,
      message: {
        message_id: 1,
        date: 0,
        chat: { id: GROUP_ID, type: "supergroup", title: "Toko" },
        from: { id: OWNER_TG, is_bot: false, first_name: "Budi" },
        text: "/user undang",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
      },
    });
    expect(lastText(tg)).toContain("chat pribadi");
  });

  it("bot: reply pesan di grup dengan /user tambah admin", async () => {
    const tg = await send({
      update_id: 9002,
      message: {
        message_id: 10,
        date: 0,
        chat: { id: GROUP_ID, type: "supergroup", title: "Toko" },
        from: { id: OWNER_TG, is_bot: false, first_name: "Budi" },
        text: "/user tambah admin",
        entities: [{ type: "bot_command", offset: 0, length: 5 }],
        reply_to_message: {
          message_id: 9,
          date: 0,
          chat: { id: GROUP_ID, type: "supergroup", title: "Toko" },
          from: { id: 444, is_bot: false, first_name: "Rina", username: "rina" },
          text: "halo",
        },
      },
    });
    expect(lastText(tg)).toContain("Rina (@rina): Admin");
    expect(await findActiveUser(env.DB, 444)).toMatchObject({ role: "admin" });
  });

  it("bot: /user ubah & nonaktif lewat nama, staff tidak bisa memakai /user", async () => {
    await addUser(env.DB, { telegramId: 222, fullName: "Sari Dewi", username: "sari" }, "staff", ownerActor);
    const t1 = await send(privateMessage(OWNER_TG, "/user ubah sari admin"));
    expect(lastText(t1)).toContain("Sari Dewi (@sari): Admin");
    const t2 = await send(privateMessage(OWNER_TG, "/user nonaktif @sari"));
    expect(lastText(t2)).toContain("nonaktif");
    const t3 = await send(privateMessage(222, "/keluar 10rb iklan", "Sari"));
    expect(lastText(t3)).toContain("belum terdaftar");

    await send(privateMessage(OWNER_TG, "/user aktif sari"));
    await updateUser(env.DB, (await findActiveUser(env.DB, 222))!.id, { role: "staff" }, ownerActor);
    const t4 = await send(privateMessage(222, "/user", "Sari"));
    expect(lastText(t4)).toContain("Hanya owner");
  });
});
