import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import { handleTelegramWebhook } from "../worker/routes/webhook";
import { getWebhookSecret, setSetting } from "../worker/services/settings";
import { BOT_INFO, buttonsOf, callbackQuery, mockTelegram, privateMessage, useFreshDb } from "./helpers";

const OWNER_TG = 111;
const STAFF_TG = 222;

describe("bot: /masuk, /keluar, /transfer", () => {
  useFreshDb();
  let secret = "";

  beforeEach(async () => {
    await setSetting(env.DB, "bot_info", JSON.stringify(BOT_INFO));
    secret = await getWebhookSecret(env);
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (?1, 'Budi', 'owner')").bind(OWNER_TG),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (?1, 'Sari', 'staff')").bind(STAFF_TG),
    ]);
  });

  async function send(update: unknown) {
    const tg = mockTelegram();
    const req = new Request("https://finbot.contoh.workers.dev/webhook/tg", {
      method: "POST",
      body: JSON.stringify(update),
      headers: { "X-Telegram-Bot-Api-Secret-Token": secret },
    });
    const res = await handleTelegramWebhook(req, env, { apiTransformer: tg.transformer });
    expect(res.status).toBe(200);
    return tg;
  }

  /** Pesan terakhir yang dikirim / diedit bot. */
  function lastOutput(tg: ReturnType<typeof mockTelegram>) {
    const c = [...tg.calls].reverse().find((x) => x.method === "sendMessage" || x.method === "editMessageText")!;
    return { text: String(c.payload["text"]), buttons: buttonsOf(c.payload), method: c.method };
  }

  function press(tg: ReturnType<typeof mockTelegram>, label: string): string {
    const b = lastOutput(tg).buttons.find((x) => x.text.includes(label));
    if (!b) throw new Error(`tombol "${label}" tidak ada: ${JSON.stringify(lastOutput(tg).buttons)}`);
    return b.data;
  }

  async function cashRows() {
    return (await env.DB.prepare("SELECT direction, amount, category_id, account_id, description, status, source FROM cash_transactions ORDER BY id").all()).results;
  }

  it("/keluar 75rb ongkir jne → ringkasan → Simpan → tersimpan → Batalkan → void", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/keluar 75rb ongkir jne"));
    const draft = lastOutput(t1);
    expect(draft.text).toContain("Kas Keluar");
    expect(draft.text).toContain("Rp 75.000");
    expect(draft.text).toContain("Kategori: Ongkir");
    expect(draft.text).toContain("Akun: Tunai");
    expect(draft.text).toContain("Catatan: jne");
    expect(await cashRows()).toHaveLength(0); // belum tersimpan sebelum Simpan

    const t2 = await send(callbackQuery(OWNER_TG, press(t1, "Simpan")));
    const saved = lastOutput(t2);
    expect(saved.method).toBe("editMessageText");
    expect(saved.text).toContain("tersimpan");
    expect(await cashRows()).toEqual([
      { direction: "out", amount: 75_000, category_id: 7, account_id: 1, description: "jne", status: "posted", source: "bot" },
    ]);

    const t3 = await send(callbackQuery(OWNER_TG, press(t2, "Batalkan"), saved.text.replace(/<[^>]+>/g, "")));
    expect(lastOutput(t3).text).toContain("Dibatalkan");
    expect((await cashRows())[0]).toMatchObject({ status: "void" });
  });

  it("Simpan ditekan dua kali tidak membuat transaksi dobel", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/masuk 500rb modal awal"));
    const data = press(t1, "Simpan");
    await send(callbackQuery(OWNER_TG, data));
    const t3 = await send(callbackQuery(OWNER_TG, data));
    expect(t3.calls.find((c) => c.method === "answerCallbackQuery")!.payload["text"]).toContain("kedaluwarsa");
    expect(await cashRows()).toHaveLength(1);
  });

  it("/masuk tanpa kategori → default Pendapatan Lain", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/masuk 1,5jt bunga bank"));
    const d = lastOutput(t1);
    expect(d.text).toContain("Rp 1.500.000");
    expect(d.text).toContain("Kategori: Pendapatan Lain");
    expect(d.text).toContain("Catatan: bunga bank");
  });

  it("/keluar tanpa kategori yang cocok → pilih kategori dari tombol", async () => {
    const t1 = await send(privateMessage(STAFF_TG, "/keluar 20000 bensin", "Sari"));
    const pick = lastOutput(t1);
    expect(pick.text).toContain("Pilih kategori");
    expect(pick.buttons.map((b) => b.text)).toContain("Operasional Lain");
    expect(pick.buttons.map((b) => b.text)).not.toContain("Transfer Keluar");

    const t2 = await send(callbackQuery(STAFF_TG, press(t1, "Operasional Lain"), "", 1, "Sari"));
    expect(lastOutput(t2).text).toContain("Kategori: Operasional Lain");
    await send(callbackQuery(STAFF_TG, press(t2, "Simpan"), "", 1, "Sari"));
    expect(await cashRows()).toEqual([
      { direction: "out", amount: 20_000, category_id: 12, account_id: 1, description: "bensin", status: "posted", source: "bot" },
    ]);
  });

  it("Ganti akun", async () => {
    await env.DB.prepare("INSERT INTO accounts (name, type) VALUES ('BCA', 'bank')").run();
    const t1 = await send(privateMessage(OWNER_TG, "/keluar 100rb iklan"));
    const t2 = await send(callbackQuery(OWNER_TG, press(t1, "Ganti akun")));
    expect(lastOutput(t2).text).toContain("Pilih akun");
    const t3 = await send(callbackQuery(OWNER_TG, press(t2, "BCA")));
    expect(lastOutput(t3).text).toContain("Akun: BCA");
    await send(callbackQuery(OWNER_TG, press(t3, "Simpan")));
    expect((await cashRows())[0]).toMatchObject({ account_id: 2, category_id: 6 });
  });

  it("peringatan saldo minus muncul di draf, tapi tidak di pesan tersimpan", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/keluar 75rb ongkir"));
    expect(lastOutput(t1).text).toContain("Saldo Tunai akan jadi <b>-Rp 75.000</b>");
    const t2 = await send(callbackQuery(OWNER_TG, press(t1, "Simpan")));
    expect(lastOutput(t2).text).not.toContain("⚠️");

    await send(privateMessage(OWNER_TG, "/masuk 500rb modal"));
    const t3 = await send(privateMessage(OWNER_TG, "/keluar 10rb iklan"));
    // draf /masuk belum disimpan → saldo masih -75.000
    expect(lastOutput(t3).text).toContain("akan jadi <b>-Rp 85.000</b>");
  });

  it("tidak ada peringatan bila saldo cukup; transfer juga diperingatkan", async () => {
    await env.DB.prepare("UPDATE accounts SET opening_balance = 100000 WHERE id = 1").run();
    await env.DB.prepare("INSERT INTO accounts (name, type) VALUES ('BCA', 'bank')").run();
    const ok = await send(privateMessage(OWNER_TG, "/keluar 50rb iklan"));
    expect(lastOutput(ok).text).not.toContain("⚠️");
    const tf = await send(privateMessage(OWNER_TG, "/transfer 150rb tunai bca"));
    expect(lastOutput(tf).text).toContain("Saldo Tunai akan jadi <b>-Rp 50.000</b>");
  });

  it("Batal tidak menyimpan apa pun", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/keluar 50rb gaji"));
    const t2 = await send(callbackQuery(OWNER_TG, press(t1, "Batal")));
    expect(lastOutput(t2).text).toContain("tidak ada yang disimpan");
    expect(await cashRows()).toHaveLength(0);
  });

  it("tombol draf lama tidak berlaku setelah draf baru dibuat", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/keluar 50rb gaji"));
    const lama = press(t1, "Simpan");
    await send(privateMessage(OWNER_TG, "/keluar 10rb iklan"));
    const t3 = await send(callbackQuery(OWNER_TG, lama));
    expect(t3.calls.find((c) => c.method === "answerCallbackQuery")!.payload["text"]).toContain("kedaluwarsa");
    expect(await cashRows()).toHaveLength(0);
  });

  it("nominal tidak valid → pesan bantuan", async () => {
    const t = await send(privateMessage(OWNER_TG, "/keluar ongkir"));
    expect(lastOutput(t).text).toContain("Nominal tidak dikenali");
  });

  it("staff tidak bisa membatalkan transaksi orang lain", async () => {
    const t1 = await send(privateMessage(OWNER_TG, "/keluar 50rb gaji"));
    const t2 = await send(callbackQuery(OWNER_TG, press(t1, "Simpan")));
    const voidData = press(t2, "Batalkan");
    const t3 = await send(callbackQuery(STAFF_TG, voidData, "", 1, "Sari"));
    const answer = t3.calls.find((c) => c.method === "answerCallbackQuery")!.payload;
    expect(answer["text"]).toContain("Staff hanya bisa membatalkan");
    expect((await cashRows())[0]).toMatchObject({ status: "posted" });
  });

  it("/transfer 1jt tunai bca → Simpan → dua baris kas", async () => {
    await env.DB.prepare("INSERT INTO accounts (name, type) VALUES ('BCA', 'bank')").run();
    const t1 = await send(privateMessage(OWNER_TG, "/transfer 1jt tunai bca setor"));
    const d = lastOutput(t1);
    expect(d.text).toContain("Dari: Tunai");
    expect(d.text).toContain("Ke: BCA");
    expect(d.text).toContain("Catatan: setor");
    await send(callbackQuery(OWNER_TG, press(t1, "Simpan")));
    const rows = await cashRows();
    expect(rows.map((r) => [r["direction"], r["account_id"], r["amount"]])).toEqual([
      ["out", 1, 1_000_000],
      ["in", 2, 1_000_000],
    ]);
  });

  it("/transfer oleh staff ditolak; dengan 1 akun diberi petunjuk", async () => {
    const s = await send(privateMessage(STAFF_TG, "/transfer 1jt tunai bca", "Sari"));
    expect(lastOutput(s).text).toContain("Hanya owner/admin");
    const o = await send(privateMessage(OWNER_TG, "/transfer 1jt tunai bca"));
    expect(lastOutput(o).text).toContain("minimal 2 akun");
  });

  it("/akun tambah lalu /saldo", async () => {
    const a = await send(privateMessage(OWNER_TG, "/akun tambah BCA bank 2jt"));
    expect(lastOutput(a).text).toContain("Akun <b>BCA</b> (Bank) ditambahkan");
    await send(privateMessage(OWNER_TG, "/masuk 300rb modal"));
    const s = await send(privateMessage(OWNER_TG, "/saldo"));
    const out = lastOutput(s).text;
    expect(out).toContain("Tunai: <b>Rp 0</b>"); // draf /masuk belum disimpan
    expect(out).toContain("BCA: <b>Rp 2.000.000</b>");
    expect(out).toContain("Total: <b>Rp 2.000.000</b>");

    const staffSaldo = await send(privateMessage(STAFF_TG, "/saldo", "Sari"));
    expect(lastOutput(staffSaldo).text).toContain("hanya bisa dilihat owner/admin");
    const staffAkun = await send(privateMessage(STAFF_TG, "/akun tambah Dana ewallet", "Sari"));
    expect(lastOutput(staffAkun).text).toContain("Hanya owner");
  });
});
