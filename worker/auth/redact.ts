/**
 * SATU-SATUNYA tempat menyaring HPP/laba untuk staff (ARCHITECTURE.md §7).
 * Semua respons API melewati `redactFor(role, data)` di helper `ok()` (routes/api/util.ts).
 */
import type { Role } from "../services/users";

/** Nama field yang dianggap rahasia: HPP, laba, margin (camelCase maupun snake_case). */
const SENSITIVE = /^(cost_price|total_cost|hpp|unit_cost|laba.*|margin.*|penjualanTanpaHpp)$/i;

export function isSensitiveKey(key: string): boolean {
  return SENSITIVE.test(key);
}

function strip(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(strip);
  if (value !== null && typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value)) {
      if (!isSensitiveKey(k)) out[k] = strip(v);
    }
    return out;
  }
  return value;
}

export function redactFor<T>(role: Role, data: T): T {
  return role === "staff" ? (strip(data) as T) : data;
}
