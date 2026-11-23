/**
 * Validasi Telegram.WebApp.initData (ARCHITECTURE.md §7).
 *   secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)
 *   hash       = hex(HMAC_SHA256(key=secret_key, msg=data_check_string))
 * data_check_string = semua field kecuali `hash`, urut abjad, "key=value" digabung "\n".
 */
import { AppError } from "../lib/errors";

export const INIT_DATA_MAX_AGE_S = 24 * 60 * 60;

export interface TelegramWebAppUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
}

const enc = new TextEncoder();

async function hmac(key: ArrayBuffer | Uint8Array, msg: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(msg));
}

function toHex(buf: ArrayBuffer): string {
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

function fromHex(hex: string): Uint8Array | null {
  if (!/^[0-9a-f]{64}$/i.test(hex)) return null;
  const out = new Uint8Array(32);
  for (let i = 0; i < 32; i++) out[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  return out;
}

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== "hash")
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("\n");
}

/** Hitung hash initData (dipakai validasi & test). */
export async function signInitData(params: URLSearchParams, botToken: string): Promise<string> {
  const secret = await hmac(enc.encode("WebAppData"), botToken);
  return toHex(await hmac(secret, dataCheckString(params)));
}

/** Validasi initData mentah; kembalikan user Telegram bila sah. */
export async function validateInitData(raw: string, botToken: string, now: Date = new Date()): Promise<TelegramWebAppUser> {
  const invalid = () => new AppError("INVALID_INIT_DATA", "Sesi Telegram tidak valid. Tutup lalu buka lagi aplikasinya dari bot.", 401);
  if (!raw || raw.length > 4096) throw invalid();
  const params = new URLSearchParams(raw);
  const given = fromHex(params.get("hash") ?? "");
  if (!given) throw invalid();

  const expected = fromHex(await signInitData(params, botToken))!;
  if (!crypto.subtle.timingSafeEqual(given, expected)) throw invalid();

  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || now.getTime() / 1000 - authDate > INIT_DATA_MAX_AGE_S) {
    throw new AppError("INIT_DATA_EXPIRED", "Sesi Telegram kedaluwarsa. Tutup lalu buka lagi aplikasinya dari bot.", 401);
  }

  let user: TelegramWebAppUser;
  try {
    user = JSON.parse(params.get("user") ?? "") as TelegramWebAppUser;
  } catch {
    throw invalid();
  }
  if (!user || typeof user.id !== "number") throw invalid();
  return user;
}
