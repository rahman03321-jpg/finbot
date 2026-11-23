/** Format & tanggal untuk Mini App. Tanggal "hari ini" berasal dari server (WIB) lewat /api/meta. */

export function rupiah(n: number): string {
  const sign = n < 0 ? "-" : "";
  return `${sign}Rp ${String(Math.abs(Math.trunc(n))).replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

/** Ringkas untuk label grafik: 1.250.000 → "1,3jt", 75.000 → "75rb". */
export function rupiahShort(n: number): string {
  const a = Math.abs(n);
  const sign = n < 0 ? "-" : "";
  if (a >= 1_000_000_000) return `${sign}${(a / 1_000_000_000).toFixed(1).replace(".", ",").replace(",0", "")}M`;
  if (a >= 1_000_000) return `${sign}${(a / 1_000_000).toFixed(1).replace(".", ",").replace(",0", "")}jt`;
  if (a >= 1_000) return `${sign}${Math.round(a / 1_000)}rb`;
  return `${sign}${a}`;
}

/** Ribuan dengan titik tanpa "Rp" (untuk input). */
export function thousands(n: number): string {
  return String(n).replace(/\B(?=(\d{3})+(?!\d))/g, ".");
}

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];
const HARI = ["Min", "Sen", "Sel", "Rab", "Kam", "Jum", "Sab"];

export function tgl(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${Number(d)} ${BULAN[Number(m) - 1]} ${y}`;
}

export function tglPendek(ymd: string): string {
  const [, m, d] = ymd.split("-");
  return `${Number(d)} ${BULAN[Number(m) - 1]}`;
}

export function hariTgl(ymd: string): string {
  const day = new Date(`${ymd}T00:00:00Z`).getUTCDay();
  return `${HARI[day]}, ${tgl(ymd)}`;
}

export function rangeLabel(from: string, to: string): string {
  return from === to ? tgl(from) : `${tglPendek(from)} – ${tgl(to)}`;
}

export function addDays(ymd: string, n: number): string {
  const [y, m, d] = ymd.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
}

export type PeriodKey = "hari" | "kemarin" | "minggu" | "minggulalu" | "bulan" | "bulanlalu";

export const PERIOD_LABEL: Record<PeriodKey, string> = {
  hari: "Hari ini",
  kemarin: "Kemarin",
  minggu: "Minggu ini",
  minggulalu: "Minggu lalu",
  bulan: "Bulan ini",
  bulanlalu: "Bulan lalu",
};

/** Sama persis dengan periodRange() di worker/lib/date.ts. */
export function periodRange(key: PeriodKey, today: string): { from: string; to: string } {
  const wd = ((new Date(`${today}T00:00:00Z`).getUTCDay() + 6) % 7) + 1; // 1=Senin
  const first = `${today.slice(0, 8)}01`;
  switch (key) {
    case "hari":
      return { from: today, to: today };
    case "kemarin": {
      const k = addDays(today, -1);
      return { from: k, to: k };
    }
    case "minggu":
      return { from: addDays(today, 1 - wd), to: today };
    case "minggulalu": {
      const to = addDays(today, -wd);
      return { from: addDays(to, -6), to };
    }
    case "bulan":
      return { from: first, to: today };
    case "bulanlalu": {
      const to = addDays(first, -1);
      return { from: `${to.slice(0, 8)}01`, to };
    }
  }
}

export function newUid(): string {
  return crypto.randomUUID();
}

export function pct(part: number, whole: number): string {
  return whole > 0 ? `${Math.round((part * 100) / whole)}%` : "–";
}
