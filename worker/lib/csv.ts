/**
 * CSV untuk dibuka di Excel/Google Sheets berbahasa Indonesia:
 * pemisah ';' (Excel lokal Indonesia memakai koma sebagai desimal) + BOM UTF-8.
 * Angka ditulis sebagai integer tanpa pemisah ribuan.
 */
const BOM = "﻿";
const SEP = ";";

function cell(v: unknown): string {
  if (v === null || v === undefined) return "";
  const s = String(v);
  // Cegah formula injection saat dibuka di spreadsheet
  const safe = /^[=+\-@\t\r]/.test(s) && typeof v === "string" ? `'${s}` : s;
  return /[";\n\r]/.test(safe) ? `"${safe.replace(/"/g, '""')}"` : safe;
}

export function toCsv(headers: string[], rows: unknown[][]): string {
  const lines = [headers, ...rows].map((r) => r.map(cell).join(SEP));
  return BOM + lines.join("\r\n") + "\r\n";
}
