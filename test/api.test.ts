import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { Api } from "grammy/web";
import worker from "../worker/index";
import { signInitData, validateInitData } from "../worker/auth/initData";
import { issueSession, verifySession } from "../worker/auth/session";
import { redactFor } from "../worker/auth/redact";
import { setTelegramApiFactory } from "../worker/routes/api/util";
import { createProduct } from "../worker/services/products";
import { getSessionSecret } from "../worker/services/settings";
import { wibDate } from "../worker/lib/date";
import { mockTelegram, useFreshDb } from "./helpers";

const ORIGIN = "https://finbot.contoh.workers.dev";
const TODAY = wibDate();

async function initDataFor(tgId: number, opts: { authDate?: number; token?: string } = {}): Promise<string> {
  const p = new URLSearchParams();
  p.set("auth_date", String(opts.authDate ?? Math.floor(Date.now() / 1000)));
  p.set("query_id", "AAE123");
  p.set("user", JSON.stringify({ id: tgId, first_name: "Budi", username: "budi" }));
  p.set("hash", await signInitData(p, opts.token ?? env.BOT_TOKEN));
  return p.toString();
}

function ctx(): ExecutionContext {
  return { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
}

async function call(method: string, path: string, token?: string, body?: unknown) {
  const res = await worker.fetch(
    new Request(`${ORIGIN}${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    }),
    env,
    ctx(),
  );
  return { status: res.status, json: (await res.json()) as { ok: boolean; data?: any; error?: { code: string; message: string } } };
}

async function login(tgId: number): Promise<string> {
  const r = await call("POST", "/api/auth", undefined, { initData: await initDataFor(tgId) });
  expect(r.status).toBe(200);
  return r.json.data.token as string;
}

describe("auth unit", () => {
  it("initData: valid, hash salah, token bot lain, kedaluwarsa", async () => {
    const good = await initDataFor(111);
    expect((await validateInitData(good, env.BOT_TOKEN)).id).toBe(111);

    const tampered = good.replace("budi", "joko");
    await expect(validateInitData(tampered, env.BOT_TOKEN)).rejects.toMatchObject({ code: "INVALID_INIT_DATA" });
    await expect(validateInitData(await initDataFor(111, { token: "999:LAIN" }), env.BOT_TOKEN)).rejects.toMatchObject({ code: "INVALID_INIT_DATA" });
    const old = await initDataFor(111, { authDate: Math.floor(Date.now() / 1000) - 25 * 3600 });
    await expect(validateInitData(old, env.BOT_TOKEN)).rejects.toMatchObject({ code: "INIT_DATA_EXPIRED" });
    await expect(validateInitData("", env.BOT_TOKEN)).rejects.toMatchObject({ code: "INVALID_INIT_DATA" });
  });

  it("token sesi: valid, diubah, kedaluwarsa, secret lain", async () => {
    const { token } = await issueSession(7, "rahasia");
    expect(await verifySession(token, "rahasia")).toBe(7);
    const [body, sig] = token.split(".");
    const forged = `${btoa(JSON.stringify({ uid: 1, exp: 9e9 })).replace(/=+$/, "")}.${sig}`;
    await expect(verifySession(forged, "rahasia")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    await expect(verifySession(`${body}.${sig}`, "lain")).rejects.toMatchObject({ code: "UNAUTHORIZED" });
    const later = new Date(Date.now() + 13 * 3600_000);
    await expect(verifySession(token, "rahasia", later)).rejects.toMatchObject({ code: "UNAUTHORIZED" });
  });

  it("redact: staff kehilangan semua field HPP/laba di segala kedalaman", () => {
    const data = { total: 10, total_cost: 6, items: [{ sell_price: 5, cost_price: 3 }], pl: { omzet: 10, hpp: 6, labaKotor: 4, labaBersih: 2, margin: 40 } };
    expect(redactFor("staff", data)).toEqual({ total: 10, items: [{ sell_price: 5 }], pl: { omzet: 10 } });
    expect(redactFor("admin", data)).toBe(data);
  });
});

describe("REST API", () => {
  useFreshDb();
  let ownerToken = "";
  let staffToken = "";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (222, 'Sari', 'staff')"),
    ]);
    await createProduct(env.DB, { name: "Salep", costPrice: 12_000, sellPrice: 20_000 }, { id: 1, role: "owner" });
    ownerToken = await login(111);
    staffToken = await login(222);
  });

  afterEach(() => setTelegramApiFactory((t) => new Api(t)));

  it("auth: orang tak terdaftar ditolak 403; tanpa token 401; user dinonaktifkan langsung terkunci", async () => {
    const r = await call("POST", "/api/auth", undefined, { initData: await initDataFor(999) });
    expect(r.status).toBe(403);
    expect(r.json.error!.code).toBe("NOT_REGISTERED");
    expect((await call("GET", "/api/meta")).status).toBe(401);

    await env.DB.prepare("UPDATE users SET is_active = 0 WHERE telegram_id = 222").run();
    expect((await call("GET", "/api/meta", staffToken)).status).toBe(401);
  });

  it("meta: owner dapat saldo akun; staff tidak", async () => {
    const o = await call("GET", "/api/meta", ownerToken);
    expect(o.json.data.user).toMatchObject({ full_name: "Budi", role: "owner" });
    expect(o.json.data.accounts[0]).toHaveProperty("balance");
    expect(o.json.data.categories.length).toBeGreaterThan(10);
    expect(o.json.data.features).toEqual({ stock: false });
    const s = await call("GET", "/api/meta", staffToken);
    expect(s.json.data.accounts[0]).not.toHaveProperty("balance");
  });

  it("kas: buat (idempoten via uid), daftar, void; validasi 400", async () => {
    const body = { uid: "mini-app-uid-1", tanggal: TODAY, direction: "out", amount: 75_000, category_id: 7, account_id: 1, description: "jne" };
    const a = await call("POST", "/api/cash", staffToken, body);
    expect(a.status).toBe(201);
    expect(a.json.data).toMatchObject({ amount: 75_000, source: "miniapp" });
    const b = await call("POST", "/api/cash", staffToken, body);
    expect(b.json.data.id).toBe(a.json.data.id);

    const list = await call("GET", "/api/cash", staffToken);
    expect(list.json.data.items).toHaveLength(1);
    expect(list.json.data.items[0]).toMatchObject({ category_name: "Ongkir", account_name: "Tunai", created_by_name: "Sari" });

    const v = await call("POST", `/api/cash/${a.json.data.id}/void`, staffToken, {});
    expect(v.json.data[0].status).toBe("void");

    const bad = await call("POST", "/api/cash", staffToken, { ...body, uid: undefined, amount: 1.5 });
    expect(bad.status).toBe(400);
    expect(bad.json.error!.code).toBe("VALIDATION");
  });

  it("penjualan: staff tidak menerima HPP/total_cost; owner menerima", async () => {
    const body = { tanggal: TODAY, items: [{ product_id: 1, qty: 3 }, { item_name: "Jasa", qty: 1, sell_price: 50_000, cost_price: 10_000 }], account_id: 1, channel: "shopee" };
    const s = await call("POST", "/api/sales", staffToken, body);
    expect(s.status).toBe(201);
    expect(s.json.data).toMatchObject({ total: 110_000, invoice_no: expect.stringMatching(/^INV-/) });
    expect(s.json.data).not.toHaveProperty("total_cost");
    expect(s.json.data.items[0]).not.toHaveProperty("cost_price");

    const ownerView = await call("GET", `/api/sales/${s.json.data.id}`, ownerToken);
    expect(ownerView.json.data.total_cost).toBe(46_000);
    const staffList = await call("GET", "/api/sales", staffToken);
    expect(staffList.json.data.items[0]).not.toHaveProperty("total_cost");

    const v = await call("POST", `/api/sales/${s.json.data.id}/void`, ownerToken, { reason: "salah" });
    expect(v.json.data.status).toBe("void");
  });

  it("produk: staff lihat tanpa HPP & tidak bisa menambah; owner bisa ubah", async () => {
    const s = await call("GET", "/api/products", staffToken);
    expect(s.json.data[0]).toEqual(expect.objectContaining({ name: "Salep", sell_price: 20_000 }));
    expect(s.json.data[0]).not.toHaveProperty("cost_price");
    expect((await call("POST", "/api/products", staffToken, { name: "X", cost_price: 1, sell_price: 2 })).status).toBe(403);

    const p = await call("PATCH", "/api/products/1", ownerToken, { cost_price: 13_000 });
    expect(p.json.data.cost_price).toBe(13_000);
    expect((await call("POST", "/api/products", ownerToken, { name: "Sabun", cost_price: 3_000, sell_price: 5_000 })).status).toBe(201);
  });

  it("laporan: admin saja; summary staff hanya omzet", async () => {
    await call("POST", "/api/sales", ownerToken, { tanggal: TODAY, items: [{ product_id: 1, qty: 1 }], account_id: 1 });
    expect((await call("GET", "/api/reports/profit-loss?period=bulan", staffToken)).status).toBe(403);

    const pl = await call("GET", "/api/reports/profit-loss?period=hari", ownerToken);
    expect(pl.json.data).toMatchObject({ omzet: 20_000, hpp: 12_000, labaBersih: 8_000, period: { code: "hari" } });
    const custom = await call("GET", `/api/reports/cashflow?from=${TODAY}&to=${TODAY}`, ownerToken);
    expect(custom.json.data.totalSaldoAkhir).toBe(20_000);
    expect((await call("GET", "/api/reports/daily?period=tahun", ownerToken)).status).toBe(400);

    const so = await call("GET", "/api/reports/summary", ownerToken);
    expect(so.json.data.today).toMatchObject({ omzet: 20_000, labaBersih: 8_000 });
    expect(so.json.data.chart).toHaveLength(30);
    expect(so.json.data.saldoKas).toBe(20_000);

    const ss = await call("GET", "/api/reports/summary", staffToken);
    expect(ss.json.data.today).toEqual({ omzet: 20_000, jmlTransaksi: 1 });
    expect(ss.json.data).not.toHaveProperty("saldoKas");
    expect(ss.json.data.topItems[0]).not.toHaveProperty("hpp");
  });

  it("ekspor: 1 PDF dikirim ke chat pribadi owner", async () => {
    const tg = mockTelegram();
    setTelegramApiFactory((t) => {
      const a = new Api(t);
      a.config.use(tg.transformer);
      return a;
    });
    const r = await call("POST", "/api/reports/export?period=bulan", ownerToken);
    expect(r.json.data.sent).toBe(true);
    const docs = tg.calls.filter((c) => c.method === "sendDocument");
    expect(docs).toHaveLength(1);
    expect(docs[0]!.payload["chat_id"]).toBe(111);
    expect((docs[0]!.payload["document"] as { filename?: string }).filename).toMatch(/^laporan_.*\.pdf$/);
    expect((await call("POST", "/api/reports/export", staffToken)).status).toBe(403);
  });

  it("endpoint tidak ada → 404 JSON; secret sesi stabil", async () => {
    const r = await call("GET", "/api/tidak-ada", ownerToken);
    expect(r.status).toBe(404);
    expect(await getSessionSecret(env)).toBe(await getSessionSecret(env));
  });
});

describe("REST API: pengaturan & user", () => {
  useFreshDb();
  let ownerToken = "";
  let adminToken = "";

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (222, 'Ani', 'admin')"),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (333, 'Sari', 'staff')"),
      env.DB.prepare("INSERT INTO settings (key, value) VALUES ('bot_info', ?1)").bind(JSON.stringify({ username: "finbot_test_bot" })),
    ]);
    ownerToken = await login(111);
    adminToken = await login(222);
  });

  it("nama usaha: owner bisa ganti, meta ikut berubah; admin hanya bisa baca", async () => {
    const r = await call("PATCH", "/api/settings", ownerToken, { business_name: "Toko Sehat", report_hour: 20, weekly_report_enabled: false });
    expect(r.json.data).toMatchObject({ business_name: "Toko Sehat", report_hour: 20, weekly_report_enabled: false });
    expect((await call("GET", "/api/meta", ownerToken)).json.data.business_name).toBe("Toko Sehat");
    expect((await call("GET", "/api/settings", adminToken)).json.data.business_name).toBe("Toko Sehat");
    expect((await call("PATCH", "/api/settings", adminToken, { business_name: "X" })).status).toBe(403);
    expect((await call("PATCH", "/api/settings", ownerToken, { report_hour: 30 })).status).toBe(400);
  });

  it("user: daftar & undangan (owner), ubah peran / nonaktif; tidak bisa ubah diri sendiri", async () => {
    expect((await call("GET", "/api/users", adminToken)).status).toBe(403);
    const list = await call("GET", "/api/users", ownerToken);
    expect(list.json.data.map((u: { full_name: string }) => u.full_name)).toEqual(["Budi", "Ani", "Sari"]);

    const inv = await call("POST", "/api/users/invite", ownerToken, { role: "staff" });
    expect(inv.json.data.link).toMatch(/^https:\/\/t\.me\/finbot_test_bot\?start=join_[0-9a-f]{24}$/);

    const sari = list.json.data.find((u: { full_name: string }) => u.full_name === "Sari");
    const up = await call("PATCH", `/api/users/${sari.id}`, ownerToken, { role: "admin" });
    expect(up.json.data.role).toBe("admin");
    const off = await call("PATCH", `/api/users/${sari.id}`, ownerToken, { is_active: false });
    expect(off.json.data.is_active).toBe(0);

    const me = list.json.data.find((u: { full_name: string }) => u.full_name === "Budi");
    expect((await call("PATCH", `/api/users/${me.id}`, ownerToken, { role: "staff" })).status).toBe(409);
  });
});

describe("REST API: modul stok", () => {
  useFreshDb();
  let ownerToken = "";
  let staffToken = "";
  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (333, 'Sari', 'staff')"),
    ]);
    ownerToken = await login(111);
    staffToken = await login(333);
  });
  afterEach(() => setTelegramApiFactory((t) => new Api(t)));

  it("aktifkan modul → menu bot diperbarui; produk dengan stok awal; opname; restock; staff dibatasi", async () => {
    const tg = mockTelegram();
    setTelegramApiFactory((t) => {
      const a = new Api(t);
      a.config.use(tg.transformer);
      return a;
    });
    expect((await call("GET", "/api/stock/low", ownerToken)).status).toBe(403); // modul mati
    const s = await call("PATCH", "/api/settings", ownerToken, { feature_stock: true });
    expect(s.json.data.feature_stock).toBe(true);
    const cmds = tg.calls.find((c) => c.method === "setMyCommands")!.payload["commands"] as { command: string }[];
    expect(cmds.map((c) => c.command)).toEqual(expect.arrayContaining(["stok", "restock"]));
    expect((await call("GET", "/api/meta", ownerToken)).json.data.features).toEqual({ stock: true });

    const p = await call("POST", "/api/products", ownerToken, { name: "Salep", cost_price: 10_000, sell_price: 20_000, min_stock: 5, opening_stock: 12 });
    expect(p.json.data).toMatchObject({ stock: 12, min_stock: 5, track_stock: 1 });
    const id = p.json.data.id;

    const op = await call("POST", `/api/products/${id}/stock`, ownerToken, { actual: 4, note: "hitung ulang" });
    expect(op.json.data.change).toBe(-8);
    expect((await call("GET", "/api/stock/low", staffToken)).json.data.map((x: { name: string }) => x.name)).toEqual(["Salep"]);
    expect((await call("POST", `/api/products/${id}/stock`, staffToken, { actual: 1 })).status).toBe(403);

    const today = wibDate();
    const pu = await call("POST", "/api/purchases", ownerToken, { tanggal: today, items: [{ product_id: id, qty: 6, unit_cost: 11_000 }], account_id: 1 });
    expect(pu.status).toBe(201);
    expect(pu.json.data.hppChanges[0]).toMatchObject({ before: 10_000, after: 10_600 });
    expect((await call("GET", "/api/purchases", staffToken)).status).toBe(403);
    const list = await call("GET", "/api/purchases", ownerToken);
    expect(list.json.data.items[0]).toMatchObject({ total: 66_000, first_item: "Salep", item_count: 1 });
    const moves = await call("GET", `/api/products/${id}/movements`, ownerToken);
    expect(moves.json.data.map((m: { type: string }) => m.type)).toEqual(["purchase", "adjustment", "opening"]);

    const v = await call("POST", `/api/purchases/${pu.json.data.id}/void`, ownerToken, {});
    expect(v.json.data.status).toBe("void");
  });
});
