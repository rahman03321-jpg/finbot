import { env } from "cloudflare:test";
import { beforeEach, describe, expect, it } from "vitest";
import {
  accountBalances,
  createAccount,
  createCashTransaction,
  createTransfer,
  listManualCategories,
  voidCashTransaction,
  type Actor,
} from "../worker/services/cash";
import { useFreshDb } from "./helpers";

let owner: Actor;
let staff: Actor;
let staff2: Actor;

async function catId(name: string): Promise<number> {
  const r = await env.DB.prepare("SELECT id FROM categories WHERE name = ?1").bind(name).first<{ id: number }>();
  return r!.id;
}

async function addUser(tgId: number, role: string): Promise<Actor> {
  const r = await env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (?1, 'X', ?2) RETURNING id")
    .bind(tgId, role)
    .first<{ id: number }>();
  return { id: r!.id, role: role as Actor["role"] };
}

async function auditCount(action: string): Promise<number> {
  const r = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log WHERE action = ?1").bind(action).first<{ n: number }>();
  return r!.n;
}

const TUNAI = 1;

describe("services/cash", () => {
  useFreshDb();

  beforeEach(async () => {
    owner = await addUser(1, "owner");
    staff = await addUser(2, "staff");
    staff2 = await addUser(3, "staff");
  });

  it("kategori manual tidak menyertakan Penjualan & Transfer", async () => {
    const inn = (await listManualCategories(env.DB, "in")).map((c) => c.name);
    expect(inn).toEqual(["Pendapatan Lain", "Modal Masuk"]);
    const out = (await listManualCategories(env.DB, "out")).map((c) => c.name);
    expect(out).toContain("Belanja Stok");
    expect(out).not.toContain("Transfer Keluar");
  });

  it("mencatat kas keluar + audit", async () => {
    const tx = await createCashTransaction(
      env.DB,
      { tanggal: "2026-11-17", direction: "out", amount: 75_000, categoryId: await catId("Ongkir"), accountId: TUNAI, description: "jne", source: "bot" },
      staff,
    );
    expect(tx).toMatchObject({ amount: 75_000, direction: "out", status: "posted", ref_type: "manual", source: "bot", created_by: staff.id, description: "jne" });
    expect(await auditCount("cash.create")).toBe(1);
  });

  it("uid yang sama tidak membuat transaksi dobel", async () => {
    const input = { uid: "uid-sama", tanggal: "2026-11-17", direction: "in" as const, amount: 500_000, categoryId: await catId("Modal Masuk"), accountId: TUNAI, source: "bot" as const };
    const a = await createCashTransaction(env.DB, input, owner);
    const b = await createCashTransaction(env.DB, input, owner);
    expect(b.id).toBe(a.id);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM cash_transactions").first<{ n: number }>();
    expect(n!.n).toBe(1);
    expect(await auditCount("cash.create")).toBe(1);
  });

  it("menolak kategori Penjualan, arah yang salah, dan nominal tidak valid", async () => {
    const base = { tanggal: "2026-11-17", accountId: TUNAI, source: "bot" as const };
    await expect(createCashTransaction(env.DB, { ...base, direction: "in", amount: 1000, categoryId: await catId("Penjualan") }, owner)).rejects.toMatchObject({ code: "INVALID_CATEGORY" });
    await expect(createCashTransaction(env.DB, { ...base, direction: "in", amount: 1000, categoryId: await catId("Ongkir") }, owner)).rejects.toMatchObject({ code: "INVALID_CATEGORY" });
    await expect(createCashTransaction(env.DB, { ...base, direction: "out", amount: 1.5, categoryId: await catId("Ongkir") }, owner)).rejects.toMatchObject({ code: "INVALID_AMOUNT" });
    await expect(createCashTransaction(env.DB, { ...base, direction: "out", amount: 1000, categoryId: await catId("Ongkir"), tanggal: "17-11-2026" }, owner)).rejects.toMatchObject({ code: "INVALID_DATE" });
  });

  it("void: status jadi void, saldo kembali, audit tercatat, tidak bisa dua kali", async () => {
    const tx = await createCashTransaction(env.DB, { tanggal: "2026-11-17", direction: "out", amount: 50_000, categoryId: await catId("Iklan"), accountId: TUNAI, source: "bot" }, owner);
    expect((await accountBalances(env.DB))[0]!.balance).toBe(-50_000);
    const [v] = await voidCashTransaction(env.DB, tx.id, "salah input", owner);
    expect(v).toMatchObject({ status: "void", voided_by: owner.id, void_reason: "salah input" });
    expect((await accountBalances(env.DB))[0]!.balance).toBe(0);
    expect(await auditCount("cash.void")).toBe(1);
    await expect(voidCashTransaction(env.DB, tx.id, "lagi", owner)).rejects.toMatchObject({ code: "ALREADY_VOID" });
    expect(await auditCount("cash.void")).toBe(1);
  });

  it("staff hanya boleh void miliknya sendiri dan < 24 jam", async () => {
    const mk = (actor: Actor) =>
      createCashTransaction(env.DB, { tanggal: "2026-11-17", direction: "out", amount: 10_000, categoryId: 7, accountId: TUNAI, source: "bot" }, actor);
    const milikStaff2 = await mk(staff2);
    await expect(voidCashTransaction(env.DB, milikStaff2.id, "x", staff)).rejects.toMatchObject({ code: "FORBIDDEN" });

    const milikSendiri = await mk(staff);
    const besok = new Date(Date.parse(milikSendiri.created_at) + 25 * 60 * 60 * 1000);
    await expect(voidCashTransaction(env.DB, milikSendiri.id, "x", staff, besok)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const [v] = await voidCashTransaction(env.DB, milikSendiri.id, "x", staff);
    expect(v!.status).toBe("void");

    // admin/owner boleh void milik siapa pun
    const [w] = await voidCashTransaction(env.DB, milikStaff2.id, "x", owner);
    expect(w!.status).toBe("void");
  });

  it("transfer: 2 baris saling merujuk, saldo pindah, total tetap; void satu = void keduanya", async () => {
    const bca = await createAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 0 }, owner);
    await createCashTransaction(env.DB, { tanggal: "2026-11-17", direction: "in", amount: 2_000_000, categoryId: await catId("Modal Masuk"), accountId: TUNAI, source: "bot" }, owner);

    const t = await createTransfer(env.DB, { tanggal: "2026-11-17", amount: 1_500_000, fromAccountId: TUNAI, toAccountId: bca.id, source: "bot" }, owner);
    expect(t.out).toMatchObject({ direction: "out", account_id: TUNAI, ref_type: "transfer", ref_id: t.in.id });
    expect(t.in).toMatchObject({ direction: "in", account_id: bca.id, ref_type: "transfer", ref_id: t.out.id });

    const bal = await accountBalances(env.DB);
    expect(bal.map((b) => b.balance)).toEqual([500_000, 1_500_000]);

    const voided = await voidCashTransaction(env.DB, t.in.id, "batal", owner);
    expect(voided.map((r) => r.status)).toEqual(["void", "void"]);
    expect((await accountBalances(env.DB)).map((b) => b.balance)).toEqual([2_000_000, 0]);
  });

  it("transfer: staff ditolak, akun sama ditolak, uid sama idempoten", async () => {
    const bca = await createAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 0 }, owner);
    const input = { uid: "tf-1", tanggal: "2026-11-17", amount: 1000, fromAccountId: TUNAI, toAccountId: bca.id, source: "bot" as const };
    await expect(createTransfer(env.DB, input, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
    await expect(createTransfer(env.DB, { ...input, toAccountId: TUNAI }, owner)).rejects.toMatchObject({ code: "SAME_ACCOUNT" });
    const a = await createTransfer(env.DB, input, owner);
    const b = await createTransfer(env.DB, input, owner);
    expect(b.out.id).toBe(a.out.id);
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM cash_transactions").first<{ n: number }>();
    expect(n!.n).toBe(2);
  });

  it("akun: hanya owner, nama unik (tanpa beda huruf besar/kecil), saldo awal ikut dihitung", async () => {
    await expect(createAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 0 }, staff)).rejects.toMatchObject({ code: "FORBIDDEN" });
    const acc = await createAccount(env.DB, { name: "BCA", type: "bank", openingBalance: 2_000_000 }, owner);
    await expect(createAccount(env.DB, { name: "bca", type: "bank", openingBalance: 0 }, owner)).rejects.toMatchObject({ code: "DUPLICATE" });
    const bal = await accountBalances(env.DB);
    expect(bal.find((b) => b.id === acc.id)!.balance).toBe(2_000_000);
    expect(await auditCount("account.create")).toBe(1);
  });

  it("saldo sampai tanggal tertentu mengabaikan transaksi sesudahnya", async () => {
    const cat = await catId("Modal Masuk");
    await createCashTransaction(env.DB, { tanggal: "2026-11-01", direction: "in", amount: 100_000, categoryId: cat, accountId: TUNAI, source: "bot" }, owner);
    await createCashTransaction(env.DB, { tanggal: "2026-11-15", direction: "in", amount: 50_000, categoryId: cat, accountId: TUNAI, source: "bot" }, owner);
    expect((await accountBalances(env.DB, "2026-11-10"))[0]!.balance).toBe(100_000);
    expect((await accountBalances(env.DB))[0]!.balance).toBe(150_000);
  });
});
