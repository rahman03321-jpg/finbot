/**
 * Token sesi Mini App tanpa tabel: base64url(payload) + "." + base64url(HMAC_SHA256(payload)).
 * Payload hanya berisi id user & kedaluwarsa; peran dibaca ulang dari DB setiap request
 * sehingga user yang dinonaktifkan langsung terkunci (ARCHITECTURE.md §7).
 */
import { AppError } from "../lib/errors";

export const SESSION_TTL_S = 12 * 60 * 60;

interface Payload {
  uid: number;
  exp: number;
}

const enc = new TextEncoder();

function b64url(bytes: Uint8Array): string {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function unb64url(s: string): Uint8Array | null {
  try {
    const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((s.length + 3) % 4));
    return Uint8Array.from(bin, (c) => c.charCodeAt(0));
  } catch {
    return null;
  }
}

async function key(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", enc.encode(secret), { name: "HMAC", hash: "SHA-256" }, false, ["sign", "verify"]);
}

export async function issueSession(userId: number, secret: string, now: Date = new Date()): Promise<{ token: string; expiresAt: number }> {
  const exp = Math.floor(now.getTime() / 1000) + SESSION_TTL_S;
  const body = b64url(enc.encode(JSON.stringify({ uid: userId, exp } satisfies Payload)));
  const sig = new Uint8Array(await crypto.subtle.sign("HMAC", await key(secret), enc.encode(body)));
  return { token: `${body}.${b64url(sig)}`, expiresAt: exp };
}

/** Kembalikan id user dari token yang sah & belum kedaluwarsa. */
export async function verifySession(token: string, secret: string, now: Date = new Date()): Promise<number> {
  const unauthorized = () => new AppError("UNAUTHORIZED", "Sesi berakhir. Buka ulang aplikasi dari bot.", 401);
  const [body, sig] = token.split(".");
  if (!body || !sig) throw unauthorized();
  const sigBytes = unb64url(sig);
  if (!sigBytes) throw unauthorized();
  const ok = await crypto.subtle.verify("HMAC", await key(secret), sigBytes, enc.encode(body));
  if (!ok) throw unauthorized();
  const raw = unb64url(body);
  if (!raw) throw unauthorized();
  let p: Payload;
  try {
    p = JSON.parse(new TextDecoder().decode(raw)) as Payload;
  } catch {
    throw unauthorized();
  }
  if (typeof p.uid !== "number" || typeof p.exp !== "number" || p.exp < now.getTime() / 1000) throw unauthorized();
  return p.uid;
}
