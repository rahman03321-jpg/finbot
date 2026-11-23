/** UUID v4 untuk kolom `uid` (lihat ARCHITECTURE.md §9.0). */
export function newUid(): string {
  return crypto.randomUUID();
}

/** String acak heksadesimal dari `bytes` byte. */
export function randomHex(bytes: number): string {
  const buf = crypto.getRandomValues(new Uint8Array(bytes));
  return [...buf].map((b) => b.toString(16).padStart(2, "0")).join("");
}

/** Bandingkan dua string dalam waktu konstan (lewat hash agar panjangnya sama). */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const enc = new TextEncoder();
  const [ha, hb] = await Promise.all([
    crypto.subtle.digest("SHA-256", enc.encode(a)),
    crypto.subtle.digest("SHA-256", enc.encode(b)),
  ]);
  return crypto.subtle.timingSafeEqual(ha, hb);
}
