/**
 * Helper tanggal zona Asia/Jakarta (WIB, UTC+7, tanpa DST).
 * Semua "hari ini" WAJIB lewat file ini. Jangan pakai toISOString().slice(0, 10) (itu UTC).
 */
const WIB_OFFSET_MS = 7 * 60 * 60 * 1000;

/** Date yang komponen UTC-nya = jam dinding WIB. Hanya untuk dibaca lewat getUTC*. */
function shifted(now: Date): Date {
  return new Date(now.getTime() + WIB_OFFSET_MS);
}

/** Tanggal WIB sebagai 'YYYY-MM-DD'. */
export function wibDate(now: Date = new Date()): string {
  return shifted(now).toISOString().slice(0, 10);
}

/** Jam WIB 0–23. */
export function wibHour(now: Date = new Date()): number {
  return shifted(now).getUTCHours();
}

/** Hari WIB: 1 = Senin … 7 = Minggu. */
export function wibIsoWeekday(now: Date = new Date()): number {
  const d = shifted(now).getUTCDay();
  return d === 0 ? 7 : d;
}

/** Tanggal 1–31 di WIB. */
export function wibDayOfMonth(now: Date = new Date()): number {
  return shifted(now).getUTCDate();
}

// ---------------------------------------------------------------------------
// Periode laporan (ARCHITECTURE.md §10)
// ---------------------------------------------------------------------------

const YMD_RE = /^(\d{4})-(\d{2})-(\d{2})$/;

/** Validasi 'YYYY-MM-DD' yang benar-benar ada di kalender. */
export function isValidYmd(s: string): boolean {
  const m = YMD_RE.exec(s);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.toISOString().slice(0, 10) === s;
}

/** Tambah n hari ke 'YYYY-MM-DD' (aritmetika kalender, tanpa zona). */
export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

/** Selisih hari inklusif: daysBetween('2026-11-01','2026-11-01') = 1 */
export function daysInclusive(from: string, to: string): number {
  return Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000) + 1;
}

function firstOfMonth(ymd: string): string {
  return `${ymd.slice(0, 8)}01`;
}

/** Hari 1 = Senin … 7 = Minggu untuk tanggal kalender. */
function isoWeekdayOf(ymd: string): number {
  const d = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
}

export type PeriodCode = "hari" | "kemarin" | "minggu" | "minggulalu" | "bulan" | "bulanlalu" | "custom";

export interface Period {
  code: PeriodCode;
  from: string;
  to: string;
  /** Label Bahasa Indonesia, mis. "Bulan ini". */
  label: string;
}

export const MAX_PERIOD_DAYS = 366;

const PERIOD_ALIASES: Record<string, Exclude<PeriodCode, "custom">> = {
  hari: "hari",
  harian: "hari",
  hariini: "hari",
  today: "hari",
  kemarin: "kemarin",
  minggu: "minggu",
  mingguan: "minggu",
  mingguini: "minggu",
  pekan: "minggu",
  minggulalu: "minggulalu",
  pekanlalu: "minggulalu",
  bulan: "bulan",
  bulanan: "bulan",
  bulanini: "bulan",
  bulanlalu: "bulanlalu",
};

const PERIOD_LABEL: Record<Exclude<PeriodCode, "custom">, string> = {
  hari: "Hari ini",
  kemarin: "Kemarin",
  minggu: "Minggu ini",
  minggulalu: "Minggu lalu",
  bulan: "Bulan ini",
  bulanlalu: "Bulan lalu",
};

/** Rentang tanggal WIB untuk kode periode siap pakai. */
export function periodRange(code: Exclude<PeriodCode, "custom">, now: Date = new Date()): Period {
  const today = wibDate(now);
  let from: string;
  let to: string;
  switch (code) {
    case "hari":
      from = to = today;
      break;
    case "kemarin":
      from = to = addDays(today, -1);
      break;
    case "minggu":
      from = addDays(today, 1 - isoWeekdayOf(today));
      to = today;
      break;
    case "minggulalu":
      to = addDays(today, -isoWeekdayOf(today));
      from = addDays(to, -6);
      break;
    case "bulan":
      from = firstOfMonth(today);
      to = today;
      break;
    case "bulanlalu":
      to = addDays(firstOfMonth(today), -1);
      from = firstOfMonth(to);
      break;
  }
  return { code, from, to, label: PERIOD_LABEL[code] };
}

/** "17/11", "17/11/2026", "17-11-26", "2026-11-17" → 'YYYY-MM-DD' (tahun default = tahun ini WIB). */
export function parseDateWord(word: string, now: Date = new Date()): string | null {
  if (isValidYmd(word)) return word;
  const m = /^(\d{1,2})[/.-](\d{1,2})(?:[/.-](\d{2}|\d{4}))?$/.exec(word);
  if (!m) return null;
  const year = m[3] ? (m[3].length === 2 ? 2000 + Number(m[3]) : Number(m[3])) : Number(wibDate(now).slice(0, 4));
  const ymd = `${year}-${m[2]!.padStart(2, "0")}-${m[1]!.padStart(2, "0")}`;
  return isValidYmd(ymd) ? ymd : null;
}

/**
 * Teks periode dari user → Period. Kosong = hari ini.
 * Menerima kode ("bulan", "minggu lalu"), satu tanggal, atau dua tanggal (dari–sampai).
 * Mengembalikan null bila tidak dikenali atau rentang tidak valid (> 366 hari / terbalik).
 */
export function parsePeriod(text: string, now: Date = new Date()): Period | null {
  const t = text.trim().toLowerCase();
  if (!t) return periodRange("hari", now);
  const alias = PERIOD_ALIASES[t.replace(/\s+/g, "")];
  if (alias) return periodRange(alias, now);

  // Pisah per spasi; kata penghubung ("s.d.", "sampai", "-") dibuang. Tanggal ber-strip tetap utuh.
  const SEP = new Set(["s.d.", "s.d", "sd", "s/d", "sampai", "hingga", "-", "–", "—"]);
  const parts = t.split(/\s+/).filter((p) => p && !SEP.has(p));
  if (parts.length < 1 || parts.length > 2) return null;
  const from = parseDateWord(parts[0]!, now);
  const to = parts.length === 2 ? parseDateWord(parts[1]!, now) : from;
  if (!from || !to || to < from || daysInclusive(from, to) > MAX_PERIOD_DAYS) return null;
  return { code: "custom", from, to, label: from === to ? from : `${from} s.d. ${to}` };
}

const BULAN_PENDEK = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** "17 Nov 2026 14:05 WIB" */
export function wibDateTimeLabel(now: Date = new Date()): string {
  const s = shifted(now);
  const hh = String(s.getUTCHours()).padStart(2, "0");
  const mm = String(s.getUTCMinutes()).padStart(2, "0");
  return `${s.getUTCDate()} ${BULAN_PENDEK[s.getUTCMonth()]} ${s.getUTCFullYear()} ${hh}:${mm} WIB`;
}

/**
 * Validasi tanggal transaksi: harus tanggal kalender yang ada, tidak sebelum 2000,
 * dan tidak melewati hari ini (WIB). Mengembalikan pesan error, atau null bila sah.
 */
export function txDateError(tanggal: string, now: Date = new Date()): string | null {
  if (!isValidYmd(tanggal)) return "Tanggal tidak valid (format YYYY-MM-DD).";
  if (tanggal < "2000-01-01") return "Tanggal terlalu lama.";
  if (tanggal > wibDate(now)) return "Tanggal tidak boleh melewati hari ini.";
  return null;
}
