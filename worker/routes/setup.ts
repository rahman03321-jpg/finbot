import { Hono } from "hono";
import type { Env } from "../env";
import { safeEqual } from "../lib/crypto";
import { runSetup, type SetupReport } from "../services/setup";

const MIN_SETUP_KEY_LENGTH = 12;

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<meta name="robots" content="noindex"><title>${esc(title)}</title>
<style>
  :root{color-scheme:light dark;--bg:#f6f7f9;--card:#fff;--fg:#1d2330;--muted:#5d6676;--ok:#16794a;--err:#b3261e;--line:#dde1e7;--accent:#2b6cb0}
  @media (prefers-color-scheme:dark){:root{--bg:#14171c;--card:#1d2128;--fg:#e7eaf0;--muted:#9aa3b2;--ok:#4cc38a;--err:#f2867e;--line:#2d333d;--accent:#6ea8e8}}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:16px/1.5 system-ui,-apple-system,"Segoe UI",sans-serif}
  main{max-width:560px;margin:0 auto;padding:32px 16px}
  .card{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:20px;margin-bottom:16px}
  h1{font-size:22px;margin:0 0 4px}p{margin:8px 0}.muted{color:var(--muted);font-size:14px}
  input{width:100%;padding:10px 12px;border:1px solid var(--line);border-radius:8px;font:inherit;background:var(--bg);color:var(--fg)}
  button,.btn{display:inline-block;margin-top:12px;padding:10px 16px;border:0;border-radius:8px;background:var(--accent);color:#fff;font:inherit;font-weight:600;text-decoration:none;cursor:pointer}
  ul{list-style:none;padding:0;margin:0}li{padding:8px 0;border-top:1px solid var(--line)}li:first-child{border-top:0}
  .ok{color:var(--ok)}.err{color:var(--err)}code{word-break:break-all}
</style></head><body><main>${body}</main></body></html>`;
}

function formPage(error?: string): string {
  return page(
    "Setup Finbot",
    `<div class="card"><h1>Setup Finbot</h1>
     <p class="muted">Masukkan SETUP_KEY yang kamu isi saat deploy. Halaman ini aman dibuka berulang kali, termasuk setelah update.</p>
     ${error ? `<p class="err">${esc(error)}</p>` : ""}
     <form method="post" action="/setup">
       <label for="key">SETUP_KEY</label>
       <input id="key" name="key" type="password" autocomplete="current-password" required>
       <button type="submit">Jalankan setup</button>
     </form></div>`,
  );
}

function reportPage(r: SetupReport): string {
  const steps = r.steps
    .map((s) => `<li><strong class="${s.ok ? "ok" : "err"}">${s.ok ? "✓" : "✗"} ${esc(s.name)}</strong><br><span class="muted">${esc(s.detail)}</span></li>`)
    .join("");
  const allOk = r.steps.every((s) => s.ok);
  let owner: string;
  if (r.ownerClaimed) {
    owner = `<p class="ok"><strong>✓ Owner sudah terdaftar.</strong></p><p class="muted">Tambah user lain nanti lewat menu Pengaturan di aplikasi.</p>`;
  } else if (r.claimLink) {
    owner = `<p><strong>Langkah terakhir:</strong> buka tautan ini dari akun Telegram yang akan menjadi owner, lalu tekan <em>Start</em>.</p>
      <a class="btn" href="${esc(r.claimLink)}">Klaim sebagai owner</a>
      <p class="muted">Jangan bagikan tautan ini. Siapa pun yang membukanya lebih dulu akan menjadi owner.</p>`;
  } else {
    owner = `<p class="err">Owner belum terdaftar. Perbaiki langkah yang gagal di atas, lalu jalankan setup lagi.</p>`;
  }
  return page(
    "Setup Finbot",
    `<div class="card"><h1>${allOk ? "Setup selesai" : "Setup belum lengkap"}</h1>
     <p class="muted">Versi database: ${r.dbVersion ?? "-"}${r.botUsername ? ` · Bot: @${esc(r.botUsername)}` : ""}</p>
     <ul>${steps}</ul></div>
     <div class="card">${owner}</div>`,
  );
}

export const setupRoutes = new Hono<{ Bindings: Env }>();

// --- Pembatas tebakan SETUP_KEY ------------------------------------------------
// Penghitung global per jam di tabel settings (`setup_fail` = "<jam UTC>|<jumlah>").
// Sebelum /setup pertama tabel settings belum ada → pembatas dilewati (hanya jeda waktu).

export const FAIL_DELAY_MS = 1500;
export const MAX_FAILS_PER_HOUR = 20;

function hourStamp(now: Date): string {
  return now.toISOString().slice(0, 13);
}

async function setupLocked(db: D1Database, now: Date = new Date()): Promise<boolean> {
  try {
    const row = await db.prepare("SELECT value FROM settings WHERE key = 'setup_fail'").first<{ value: string }>();
    if (!row) return false;
    const [hour, n] = row.value.split("|");
    return hour === hourStamp(now) && Number(n) >= MAX_FAILS_PER_HOUR;
  } catch {
    return false;
  }
}

async function recordSetupFailure(db: D1Database, now: Date = new Date()): Promise<void> {
  const h = hourStamp(now);
  try {
    await db
      .prepare(
        `INSERT INTO settings (key, value) VALUES ('setup_fail', ?1 || '|1')
         ON CONFLICT(key) DO UPDATE SET value = CASE
           WHEN substr(value, 1, 13) = ?1 THEN ?1 || '|' || (CAST(substr(value, 15) AS INTEGER) + 1)
           ELSE ?1 || '|1' END`,
      )
      .bind(h)
      .run();
  } catch {
    // tabel belum ada: abaikan
  }
}

setupRoutes.get("/setup", (c) => c.html(formPage()));

setupRoutes.post("/setup", async (c) => {
  const env = c.env;
  if (!env.SETUP_KEY || env.SETUP_KEY.length < MIN_SETUP_KEY_LENGTH) {
    return c.html(formPage(`SETUP_KEY belum diisi atau kurang dari ${MIN_SETUP_KEY_LENGTH} karakter. Atur di dashboard Cloudflare (Settings → Variables and Secrets).`), 500);
  }
  if (!env.BOT_TOKEN) {
    return c.html(formPage("BOT_TOKEN belum diisi. Atur di dashboard Cloudflare (Settings → Variables and Secrets)."), 500);
  }
  if (await setupLocked(env.DB)) {
    return c.html(formPage("Terlalu banyak percobaan salah. Coba lagi jam berikutnya."), 429);
  }
  const form = await c.req.parseBody();
  const key = typeof form["key"] === "string" ? form["key"] : "";
  if (!(await safeEqual(key, env.SETUP_KEY))) {
    await recordSetupFailure(env.DB);
    // Perlambat tebak-tebakan password (waktu tunggu, bukan CPU).
    await new Promise((r) => setTimeout(r, FAIL_DELAY_MS));
    return c.html(formPage("SETUP_KEY salah."), 401);
  }
  const origin = new URL(c.req.url).origin;
  const report = await runSetup(env, { origin });
  return c.html(reportPage(report));
});
