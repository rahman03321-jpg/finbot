import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import worker from "../worker/index";
import { signInitData } from "../worker/auth/initData";
import { createCashTransaction, createTransfer, listCategories, type Actor } from "../worker/services/cash";
import { addAccount, deleteAccount } from "../worker/services/masters";
import { createSale } from "../worker/services/sales";
import { cashByAccount } from "../worker/services/reports";
import { wibDate } from "../worker/lib/date";
import { useFreshDb } from "./helpers";

const owner: Actor = { id: 1, role: "owner" };

describe("kas masuk/keluar per akun", () => {
  useFreshDb();
  let bca = 0;

  beforeEach(async () => {
    await env.DB.batch([
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (1, 111, 'Budi', 'owner')"),
      env.DB.prepare("INSERT INTO users (id, telegram_id, full_name, role) VALUES (2, 222, 'Sari', 'staff')"),
    ]);
    bca = (await addAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 1_000_000 }, owner)).id;
    const cats = await listCategories(env.DB);
    const cat = (n: string) => cats.find((c) => c.name === n)!.id;
    const cash = (tanggal: string, direction: "in" | "out", amount: number, name: string, accountId: number) =>
      createCashTransaction(env.DB, { tanggal, direction, amount, categoryId: cat(name), accountId, source: "bot" }, owner);

    await cash("2026-10-31", "in", 500_000, "Modal Masuk", 1); // sebelum periode
    await cash("2026-11-02", "in", 7_000_000, "Modal Masuk", 1);
    await createSale(env.DB, { tanggal: "2026-11-03", items: [{ itemName: "X", qty: 1, sellPrice: 3_000_000 }], accountId: bca, source: "bot" }, owner);
    await cash("2026-11-04", "out", 1_500_000, "Gaji", 1);
    await cash("2026-11-05", "out", 500_000, "Iklan", bca);
    await createTransfer(env.DB, { tanggal: "2026-11-06", amount: 2_000_000, fromAccountId: 1, toAccountId: bca, source: "bot" }, owner);
  });

  it("total = jumlah per akun; transfer tidak dihitung masuk/keluar tapi memengaruhi saldo", async () => {
    const s = await cashByAccount(env.DB, "2026-11-01", "2026-11-30");
    expect(s.totalMasuk).toBe(10_000_000);
    expect(s.totalKeluar).toBe(2_000_000);
    expect(s.akun.map((a) => [a.name, a.masuk, a.keluar, a.saldo])).toEqual([
      // Tunai: 500rb + 7jt − 1,5jt − 2jt (transfer) = 4jt
      ["Tunai", 7_000_000, 1_500_000, 4_000_000],
      // BCA: 1jt (awal) + 3jt − 500rb + 2jt (transfer) = 5,5jt
      ["BCA", 3_000_000, 500_000, 5_500_000],
    ]);
    expect(s.totalSaldo).toBe(9_500_000);
  });

  it("saldo dihitung per akhir periode", async () => {
    const s = await cashByAccount(env.DB, "2026-11-01", "2026-11-03");
    expect(s.akun.map((a) => [a.name, a.saldo])).toEqual([
      ["Tunai", 7_500_000],
      ["BCA", 4_000_000],
    ]);
  });

  it("akun yang dihapus tetap muncul bila punya transaksi di periode", async () => {
    const dana = await addAccount(env.DB, { name: "Dana", type: "ewallet", openingBalance: 0 }, owner);
    const cats = await listCategories(env.DB);
    await createCashTransaction(env.DB, { tanggal: "2026-11-10", direction: "in", amount: 50_000, categoryId: cats.find((c) => c.name === "Modal Masuk")!.id, accountId: dana.id, source: "bot" }, owner);
    await createCashTransaction(env.DB, { tanggal: "2026-11-11", direction: "out", amount: 50_000, categoryId: cats.find((c) => c.name === "Gaji")!.id, accountId: dana.id, source: "bot" }, owner);
    await deleteAccount(env.DB, dana.id, owner);
    const s = await cashByAccount(env.DB, "2026-11-01", "2026-11-30");
    expect(s.akun.find((a) => a.name === "Dana")).toMatchObject({ masuk: 50_000, keluar: 50_000, saldo: 0 });
    const oct = await cashByAccount(env.DB, "2026-10-01", "2026-10-31");
    expect(oct.akun.map((a) => a.name)).toEqual(["Tunai", "BCA"]);
  });

  it("API: owner dapat saldo, staff tidak", async () => {
    const ctx = { waitUntil() {}, passThroughOnException() {}, props: {} } as unknown as ExecutionContext;
    const login = async (tgId: number) => {
      const p = new URLSearchParams();
      p.set("auth_date", String(Math.floor(Date.now() / 1000)));
      p.set("user", JSON.stringify({ id: tgId, first_name: "X" }));
      p.set("hash", await signInitData(p, env.BOT_TOKEN));
      const r = await worker.fetch(new Request("https://x.dev/api/auth", { method: "POST", body: JSON.stringify({ initData: p.toString() }) }), env, ctx);
      return ((await r.json()) as { data: { token: string } }).data.token;
    };
    const get = async (token: string) => {
      const r = await worker.fetch(new Request("https://x.dev/api/cash/summary?from=2026-11-01&to=2026-11-30", { headers: { Authorization: `Bearer ${token}` } }), env, ctx);
      return ((await r.json()) as { data: Record<string, unknown> & { akun: Record<string, unknown>[] } }).data;
    };
    const o = await get(await login(111));
    expect(o).toMatchObject({ totalMasuk: 10_000_000, totalSaldo: 9_500_000 });
    expect(o.akun[0]).toHaveProperty("saldo", 4_000_000);
    const s = await get(await login(222));
    expect(s).toMatchObject({ totalMasuk: 10_000_000, totalKeluar: 2_000_000 });
    expect(s).not.toHaveProperty("totalSaldo");
    expect(s.akun[0]).not.toHaveProperty("saldo");
    expect(wibDate()).toMatch(/^\d{4}-/);
  });
});
