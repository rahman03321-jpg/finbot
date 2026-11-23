import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import { MIGRATIONS, migrate, splitStatements } from "../worker/db/migrate";
import { useFreshDb } from "./helpers";

describe("splitStatements", () => {
  it("mengabaikan komentar dan ; di dalam string", () => {
    const sql = `-- komentar; dengan titik koma
CREATE TABLE a (x TEXT); -- buntut 'kutip'
INSERT INTO a VALUES ('satu; dua'), ('it''s');
INSERT INTO a VALUES ('--bukan komentar')`;
    expect(splitStatements(sql)).toEqual([
      "CREATE TABLE a (x TEXT)",
      "INSERT INTO a VALUES ('satu; dua'), ('it''s')",
      "INSERT INTO a VALUES ('--bukan komentar')",
    ]);
  });

  it("memecah migrasi 0001 tanpa statement kosong", () => {
    const stmts = splitStatements(MIGRATIONS[0]!.sql);
    expect(stmts.length).toBeGreaterThan(20);
    expect(stmts.every((s) => s.length > 0 && !s.startsWith("--"))).toBe(true);
  });
});

describe("migrate", () => {
  useFreshDb(); // beforeEach sudah menjalankan migrate sekali

  it("membuat skema, data awal, dan mencatat versi", async () => {
    const v = await env.DB.prepare("SELECT version FROM schema_version").all<{ version: number }>();
    expect(v.results.map((r) => r.version)).toEqual([1, 2, 3]);

    const cats = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories").first<{ n: number }>();
    expect(cats?.n).toBe(14);

    const flag = await env.DB.prepare("SELECT value FROM settings WHERE key='feature_stock'").first<{ value: string }>();
    expect(flag?.value).toBe("0");
  });

  it("idempoten: dijalankan ulang tidak mengubah apa pun", async () => {
    const r = await migrate(env.DB);
    expect(r).toEqual({ applied: [], current: 3 });
    const cats = await env.DB.prepare("SELECT COUNT(*) AS n FROM categories").first<{ n: number }>();
    expect(cats?.n).toBe(14);
  });

  it("migrasi yang gagal tidak meninggalkan perubahan setengah jadi", async () => {
    const bad = [
      ...MIGRATIONS,
      { version: 99, sql: "CREATE TABLE coba (x INTEGER);\nINSERT INTO tabel_tidak_ada VALUES (1);" },
    ];
    await expect(migrate(env.DB, bad)).rejects.toThrow();
    const t = await env.DB.prepare("SELECT name FROM sqlite_master WHERE name='coba'").first();
    expect(t).toBeNull();
    const v = await env.DB.prepare("SELECT MAX(version) AS v FROM schema_version").first<{ v: number }>();
    expect(v?.v).toBe(3);
  });
});
