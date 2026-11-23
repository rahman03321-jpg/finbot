/**
 * Parser nominal rupiah dari teks bebas.
 *   "50rb", "50k", "50 ribu", "1,5jt", "1.5jt", "2 juta", "250.000", "250000", "Rp 1.250.000"
 * Mengembalikan integer rupiah > 0, atau null bila tidak valid. Tidak pernah memakai float
 * untuk hasil akhir: pecahan dihitung dengan aritmetika integer.
 */
export const MAX_AMOUNT = 1_000_000_000_000; // Rp 1 triliun, batas wajar & aman untuk Number

const SUFFIX: Record<string, number> = {
  k: 1_000,
  rb: 1_000,
  rbu: 1_000,
  ribu: 1_000,
  rebu: 1_000,
  jt: 1_000_000,
  jta: 1_000_000,
  juta: 1_000_000,
};

/** Kata yang boleh berdiri sendiri setelah angka, mis. "75 rb". */
export function isAmountSuffix(word: string): boolean {
  return word.toLowerCase() in SUFFIX;
}

export function parseAmount(input: string): number | null {
  let s = input.trim().toLowerCase().replace(/\s+/g, "");
  s = s.replace(/^(rp\.?|idr)/, "");
  // Buntut gaya kuitansi: "250.000,-" / "250.000,00" / "250000.00"
  // (sen nol tanpa satuan dibuang; sen bukan nol ditolak di bawah karena rupiah = integer)
  s = s.replace(/,-$/, "");
  if (/^[\d.,]+[.,]00$/.test(s)) s = s.slice(0, -3);
  const m = /^(\d[\d.,]*)([a-z]*)$/.exec(s);
  if (!m) return null;
  const num = m[1]!;
  const suffix = m[2]!;
  let mult = 1;
  if (suffix) {
    const v = SUFFIX[suffix];
    if (v === undefined) return null;
    mult = v;
  }

  // Pisahkan angka per pemisah '.' atau ','
  const parts = num.split(/[.,]/);
  if (parts.some((p) => p === "")) return null;

  let intDigits: string;
  let fracDigits = "";
  if (parts.length === 1) {
    intDigits = parts[0]!;
  } else {
    const tail = parts.slice(1);
    const allThousands = tail.every((p) => p.length === 3) && parts[0]!.length <= 3;
    if (allThousands) {
      // 250.000 / 1.250.000 / 1,250,000 → pemisah ribuan
      intDigits = parts.join("");
    } else if (parts.length === 2 && suffix) {
      // 1,5jt / 1.25jt → desimal, hanya boleh bersama satuan
      intDigits = parts[0]!;
      fracDigits = parts[1]!;
    } else {
      return null;
    }
  }

  // nilai = (int + frac/10^n) * mult, dihitung integer
  const scale = 10 ** fracDigits.length;
  const numerator = (Number(intDigits) * scale + Number(fracDigits || "0")) * mult;
  if (!Number.isSafeInteger(numerator) || numerator % scale !== 0) return null;
  const value = numerator / scale;
  if (value <= 0 || value > MAX_AMOUNT) return null;
  return value;
}

/**
 * Ambil nominal dari awal daftar kata. Mendukung satuan terpisah ("75 rb").
 * Mengembalikan nominal & sisa kata, atau null.
 */
export function takeAmount(words: string[]): { amount: number; rest: string[] } | null {
  if (words.length === 0) return null;
  if (words.length >= 2 && isAmountSuffix(words[1]!)) {
    const joined = parseAmount(words[0]! + words[1]!);
    if (joined !== null) return { amount: joined, rest: words.slice(2) };
  }
  const single = parseAmount(words[0]!);
  return single === null ? null : { amount: single, rest: words.slice(1) };
}
