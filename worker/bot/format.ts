/** Format rupiah: 1250000 → "Rp 1.250.000", -5000 → "-Rp 5.000". */
export function rupiah(n: number): string {
  const sign = n < 0 ? "-" : "";
  const digits = String(Math.abs(Math.trunc(n)));
  return `${sign}Rp ${digits.replace(/\B(?=(\d{3})+(?!\d))/g, ".")}`;
}

const BULAN = ["Jan", "Feb", "Mar", "Apr", "Mei", "Jun", "Jul", "Agu", "Sep", "Okt", "Nov", "Des"];

/** '2026-11-17' → '17 Nov 2026'. */
export function tanggalPendek(ymd: string): string {
  const [y, m, d] = ymd.split("-");
  return `${Number(d)} ${BULAN[Number(m) - 1] ?? m} ${y}`;
}

/** Escape untuk parse_mode HTML Telegram. */
export function html(s: string): string {
  return s.replace(/[&<>]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;" })[c]!);
}
