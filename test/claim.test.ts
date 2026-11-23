import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { claimOwner, ensureOwnerClaimCode, hasOwner } from "../worker/services/users";
import { getSetting } from "../worker/services/settings";
import { useFreshDb } from "./helpers";

const budi = { telegramId: 111, username: "budi", fullName: "Budi" };
const sari = { telegramId: 222, username: "sari", fullName: "Sari" };

describe("klaim owner", () => {
  useFreshDb();

  it("kode benar: jadi owner, kode dihapus, audit tercatat", async () => {
    const code = (await ensureOwnerClaimCode(env.DB))!;
    const user = await claimOwner(env.DB, code, budi);
    expect(user.role).toBe("owner");
    expect(user.telegram_id).toBe(111);
    expect(await getSetting(env.DB, "owner_claim_code")).toBeNull();
    expect(await ensureOwnerClaimCode(env.DB)).toBeNull();

    const audit = await env.DB.prepare("SELECT action, user_id FROM audit_log").all();
    expect(audit.results).toEqual([{ action: "user.claim_owner", user_id: user.id }]);
  });

  it("kode salah ditolak", async () => {
    await ensureOwnerClaimCode(env.DB);
    await expect(claimOwner(env.DB, "salah", budi)).rejects.toMatchObject({ code: "CLAIM_INVALID" });
    expect(await hasOwner(env.DB)).toBe(false);
  });

  it("kode tidak bisa dipakai dua kali", async () => {
    const code = (await ensureOwnerClaimCode(env.DB))!;
    await claimOwner(env.DB, code, budi);
    await expect(claimOwner(env.DB, code, sari)).rejects.toMatchObject({ code: "CLAIM_INVALID" });
    const owners = await env.DB.prepare("SELECT telegram_id FROM users WHERE role='owner'").all();
    expect(owners.results).toEqual([{ telegram_id: 111 }]);
  });

  it("dua klaim bersamaan: hanya satu owner", async () => {
    const code = (await ensureOwnerClaimCode(env.DB))!;
    const results = await Promise.allSettled([claimOwner(env.DB, code, budi), claimOwner(env.DB, code, sari)]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    const owners = await env.DB.prepare("SELECT COUNT(*) AS n FROM users WHERE role='owner'").first<{ n: number }>();
    expect(owners?.n).toBe(1);
    const audit = await env.DB.prepare("SELECT COUNT(*) AS n FROM audit_log").first<{ n: number }>();
    expect(audit?.n).toBe(1);
  });

  it("user yang sudah terdaftar sebagai staff bisa naik jadi owner lewat kode", async () => {
    await env.DB.prepare("INSERT INTO users (telegram_id, full_name, role) VALUES (111, 'Budi', 'staff')").run();
    const code = (await ensureOwnerClaimCode(env.DB))!;
    const user = await claimOwner(env.DB, code, budi);
    expect(user.role).toBe("owner");
    const n = await env.DB.prepare("SELECT COUNT(*) AS n FROM users").first<{ n: number }>();
    expect(n?.n).toBe(1);
  });
});
