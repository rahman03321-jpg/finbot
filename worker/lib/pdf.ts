/**
 * Penulis PDF minimal tanpa dependensi (Free plan: CPU per request kecil, jadi hindari library berat).
 * - Font standar Helvetica & Helvetica-Bold (tanpa embed), encoding WinAnsi.
 * - Seluruh file ASCII (karakter non-ASCII ditulis sebagai escape oktal) sehingga offset xref = indeks string.
 * - Koordinat dalam point, asal (0,0) di KIRI ATAS (dikonversi ke sistem PDF yang dari kiri bawah).
 */

export const A4 = { width: 595.28, height: 841.89 };

// Lebar glyph Helvetica (per 1000 em) untuk ASCII 32..126 (dari AFM standar Adobe).
const HELV = [
  278, 278, 355, 556, 556, 889, 667, 191, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 278, 278, 584, 584, 584, 556,
  1015, 667, 667, 722, 722, 667, 611, 778, 722, 278, 500, 667, 556, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 278, 278, 278, 469, 556,
  333, 556, 556, 500, 556, 556, 278, 556, 556, 222, 222, 500, 222, 833, 556, 556, 556, 556, 333, 500, 278, 556, 500, 722, 500, 500, 500, 334, 260, 334, 584,
];
// Lebar Helvetica-Bold untuk ASCII 32..126.
const HELV_BOLD = [
  278, 333, 474, 556, 556, 889, 722, 238, 333, 333, 389, 584, 278, 333, 278, 278, 556, 556, 556, 556, 556, 556, 556, 556, 556, 556, 333, 333, 584, 584, 584, 611,
  975, 722, 722, 722, 722, 667, 611, 778, 722, 278, 556, 722, 611, 833, 722, 778, 667, 778, 722, 667, 611, 722, 667, 944, 667, 667, 611, 333, 278, 333, 584, 556,
  333, 556, 611, 556, 611, 556, 333, 611, 611, 278, 278, 556, 278, 889, 611, 611, 611, 611, 389, 556, 333, 611, 556, 778, 556, 556, 500, 389, 280, 389, 584,
];

const UNICODE_TO_WINANSI: Record<string, number> = {
  "•": 0x95,
  "–": 0x96,
  "—": 0x97,
  "‘": 0x91,
  "’": 0x92,
  "“": 0x93,
  "”": 0x94,
  "…": 0x85,
  "€": 0x80,
  "™": 0x99,
};

export type Font = "regular" | "bold";

/** Ubah teks ke daftar kode WinAnsi; karakter yang tidak didukung jadi '?' (emoji dibuang). */
function toWinAnsi(s: string): number[] {
  const out: number[] = [];
  for (const ch of s) {
    const cp = ch.codePointAt(0)!;
    if (cp >= 32 && cp <= 126) out.push(cp);
    else if (UNICODE_TO_WINANSI[ch] !== undefined) out.push(UNICODE_TO_WINANSI[ch]!);
    else if (cp >= 160 && cp <= 255) out.push(cp);
    else if (cp === 10 || cp === 9) out.push(32);
    else if (cp > 0xffff || (cp >= 0x2600 && cp <= 0x27bf) || (cp >= 0xfe00 && cp <= 0xfe0f) || cp === 0x200d) continue; // emoji
    else out.push(63);
  }
  return out;
}

export function textWidth(s: string, size: number, font: Font = "regular"): number {
  const table = font === "bold" ? HELV_BOLD : HELV;
  let w = 0;
  for (const c of toWinAnsi(s)) w += c >= 32 && c <= 126 ? table[c - 32]! : 556;
  return (w * size) / 1000;
}

/** Potong teks agar muat di lebar tertentu (ditambah "..."). */
export function fit(s: string, maxWidth: number, size: number, font: Font = "regular"): string {
  if (textWidth(s, size, font) <= maxWidth) return s;
  let t = s;
  while (t.length > 0 && textWidth(`${t}...`, size, font) > maxWidth) t = t.slice(0, -1);
  return `${t.trimEnd()}...`;
}

function pdfString(s: string): string {
  let out = "(";
  for (const c of toWinAnsi(s)) {
    if (c === 40 || c === 41 || c === 92) out += `\\${String.fromCharCode(c)}`;
    else if (c < 32 || c > 126) out += `\\${c.toString(8).padStart(3, "0")}`;
    else out += String.fromCharCode(c);
  }
  return `${out})`;
}

function n(v: number): string {
  return (Math.round(v * 100) / 100).toString();
}

export type Rgb = [number, number, number];

export interface TextOpts {
  font?: Font;
  size?: number;
  align?: "left" | "right" | "center";
  color?: Rgb;
}

export class PdfDoc {
  private pages: string[][] = [];
  readonly width = A4.width;
  readonly height = A4.height;

  addPage(): number {
    this.pages.push([]);
    return this.pages.length - 1;
  }

  get pageCount(): number {
    return this.pages.length;
  }

  private ops(page: number): string[] {
    const p = this.pages[page];
    if (!p) throw new Error(`halaman ${page} tidak ada`);
    return p;
  }

  /** y = garis dasar teks, diukur dari atas halaman. */
  text(page: number, x: number, y: number, s: string, o: TextOpts = {}): void {
    const size = o.size ?? 9;
    const font = o.font ?? "regular";
    let tx = x;
    if (o.align === "right") tx = x - textWidth(s, size, font);
    else if (o.align === "center") tx = x - textWidth(s, size, font) / 2;
    const [r, g, b] = o.color ?? [0.1, 0.11, 0.13];
    this.ops(page).push(`BT /${font === "bold" ? "F2" : "F1"} ${n(size)} Tf ${n(r)} ${n(g)} ${n(b)} rg ${n(tx)} ${n(this.height - y)} Td ${pdfString(s)} Tj ET`);
  }

  line(page: number, x1: number, y1: number, x2: number, y2: number, width = 0.5, color: Rgb = [0.82, 0.84, 0.87]): void {
    this.ops(page).push(`${n(width)} w ${n(color[0])} ${n(color[1])} ${n(color[2])} RG ${n(x1)} ${n(this.height - y1)} m ${n(x2)} ${n(this.height - y2)} l S`);
  }

  /** Persegi terisi; (x, y) = sudut kiri atas. */
  rect(page: number, x: number, y: number, w: number, h: number, color: Rgb): void {
    this.ops(page).push(`${n(color[0])} ${n(color[1])} ${n(color[2])} rg ${n(x)} ${n(this.height - y - h)} ${n(w)} ${n(h)} re f`);
  }

  /** Hasilkan byte PDF. */
  build(meta: { title: string; author?: string }): Uint8Array {
    const objs: string[] = [];
    const fontEnc = "/Encoding /WinAnsiEncoding";
    // 1 katalog, 2 pages, 3 F1, 4 F2, lalu pasangan (page, content) per halaman
    const pageIds = this.pages.map((_, i) => 5 + i * 2);
    objs[1] = "<< /Type /Catalog /Pages 2 0 R >>";
    objs[2] = `<< /Type /Pages /Kids [${pageIds.map((id) => `${id} 0 R`).join(" ")}] /Count ${this.pages.length} >>`;
    objs[3] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica ${fontEnc} >>`;
    objs[4] = `<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica-Bold ${fontEnc} >>`;
    this.pages.forEach((ops, i) => {
      const pageId = pageIds[i]!;
      const content = ops.join("\n");
      objs[pageId] =
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${n(this.width)} ${n(this.height)}] ` +
        `/Resources << /Font << /F1 3 0 R /F2 4 0 R >> >> /Contents ${pageId + 1} 0 R >>`;
      objs[pageId + 1] = `<< /Length ${content.length} >>\nstream\n${content}\nendstream`;
    });
    const infoId = objs.length;
    objs[infoId] = `<< /Title ${pdfString(meta.title)} /Producer (Catetin)${meta.author ? ` /Author ${pdfString(meta.author)}` : ""} >>`;

    let out = "%PDF-1.4\n";
    const offsets: number[] = [];
    for (let id = 1; id < objs.length; id++) {
      offsets[id] = out.length;
      out += `${id} 0 obj\n${objs[id]}\nendobj\n`;
    }
    const xref = out.length;
    out += `xref\n0 ${objs.length}\n0000000000 65535 f \n`;
    for (let id = 1; id < objs.length; id++) out += `${String(offsets[id]).padStart(10, "0")} 00000 n \n`;
    out += `trailer\n<< /Size ${objs.length} /Root 1 0 R /Info ${infoId} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

    const bytes = new Uint8Array(out.length);
    for (let i = 0; i < out.length; i++) bytes[i] = out.charCodeAt(i);
    return bytes;
  }
}
