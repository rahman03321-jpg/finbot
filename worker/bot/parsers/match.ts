/**
 * Pencocokan teks bebas ke kategori / akun.
 * Contoh: "ongkir jne" → kategori Ongkir, catatan "jne".
 */

function norm(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9]/g, "");
}

function nameWords(name: string): string[] {
  return name
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter((w) => w.length > 0);
}

export interface Named {
  id: number;
  name: string;
}

export interface MatchResult<T extends Named> {
  /** Tepat satu cocok. */
  match: T | null;
  /** Lebih dari satu kandidat (tampilkan tombol pilihan). */
  candidates: T[];
  /** Kata yang tersisa sebagai catatan. */
  rest: string[];
}

const MIN_PREFIX = 3;

/** Apakah `word` cocok dengan item: sama persis dengan nama, atau awalan (≥3 huruf) salah satu kata nama. */
function wordMatches(word: string, item: Named): boolean {
  const w = norm(word);
  if (!w) return false;
  if (norm(item.name) === w) return true;
  if (w.length < MIN_PREFIX) return false;
  return nameWords(item.name).some((nw) => nw.startsWith(w));
}

/**
 * Cocokkan kata pertama (dan kata berikutnya selama masih mempersempit) ke daftar item.
 * - 1 kandidat → match.
 * - >1 kandidat → coba persempit dengan kata kedua; kalau tetap >1, kembalikan kandidat.
 * - 0 kandidat → match null, semua kata jadi catatan.
 */
export function matchLeading<T extends Named>(words: string[], items: T[]): MatchResult<T> {
  if (words.length === 0) return { match: null, candidates: [], rest: [] };

  // Nama lengkap multi-kata yang persis sama ("listrik & internet", "bank bca") diutamakan.
  for (let k = Math.min(4, words.length); k >= 2; k--) {
    const phrase = norm(words.slice(0, k).join(""));
    const exact = items.filter((i) => norm(i.name) === phrase);
    if (exact.length === 1) return { match: exact[0]!, candidates: [], rest: words.slice(k) };
  }

  let candidates = items.filter((i) => wordMatches(words[0]!, i));
  if (candidates.length === 0) return { match: null, candidates: [], rest: words };

  let used = 1;
  if (candidates.length > 1) {
    const exact = candidates.filter((i) => norm(i.name) === norm(words[0]!));
    if (exact.length === 1) return { match: exact[0]!, candidates: [], rest: words.slice(1) };
    if (words.length > 1) {
      const narrowed = candidates.filter((i) => wordMatches(words[1]!, i));
      if (narrowed.length >= 1) {
        candidates = narrowed;
        used = 2;
      }
    }
  }

  if (candidates.length === 1) return { match: candidates[0]!, candidates: [], rest: words.slice(used) };
  return { match: null, candidates, rest: words.slice(used) };
}
