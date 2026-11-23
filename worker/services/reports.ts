/**
 * Laporan (ARCHITECTURE.md §10). Semua agregasi di SQL dan memakai index (status, tanggal).
 * Hanya status 'posted'. Rentang tanggal inklusif, format 'YYYY-MM-DD' WIB.
 */
import { AppError } from "../lib/errors";
import { addDays, daysInclusive, isValidYmd, MAX_PERIOD_DAYS } from "../lib/date";
import type { CategoryKind, Direction } from "./cash";

function assertRange(from: string, to: string): void {
  if (!isValidYmd(from) || !isValidYmd(to)) throw new AppError("INVALID_DATE", "Format tanggal harus YYYY-MM-DD.");
  if (to < from) throw new AppError("INVALID_RANGE", "Tanggal akhir harus setelah tanggal awal.");
  if (daysInclusive(from, to) > MAX_PERIOD_DAYS) throw new AppError("INVALID_RANGE", `Rentang maksimal ${MAX_PERIOD_DAYS} hari.`);
}

// ---------------------------------------------------------------------------
// Laba rugi (§10.1)
// ---------------------------------------------------------------------------

export interface CategoryTotal {
  id: number;
  name: string;
  kind: CategoryKind;
  direction: Direction;
  total: number;
}

export interface ProfitLoss {
  from: string;
  to: string;
  omzet: number;
  hpp: number;
  diskon: number;
  jmlTransaksi: number;
  labaKotor: number;
  pendapatanLain: number;
  biaya: number;
  biayaPerKategori: CategoryTotal[];
  pendapatanLainPerKategori: CategoryTotal[];
  labaBersih: number;
  /** Penjualan cepat yang HPP-nya 0 (laba bisa terlihat terlalu besar). */
  penjualanTanpaHpp: number;
}

export async function profitLoss(db: D1Database, from: string, to: string): Promise<ProfitLoss> {
  assertRange(from, to);
  const [sales, cats, noHpp] = await db.batch([
    db
      .prepare(
        `SELECT COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(total_cost),0) AS hpp,
                COALESCE(SUM(discount),0) AS diskon, COUNT(*) AS n
         FROM sales WHERE status = 'posted' AND tanggal BETWEEN ?1 AND ?2`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT c.id, c.name, c.kind, c.direction, SUM(t.amount) AS total
         FROM cash_transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'posted' AND t.tanggal BETWEEN ?1 AND ?2
         GROUP BY c.id ORDER BY total DESC`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT COUNT(*) AS n FROM sales
         WHERE status = 'posted' AND tanggal BETWEEN ?1 AND ?2 AND total_cost = 0 AND total > 0`,
      )
      .bind(from, to),
  ]);
  const s = sales!.results[0] as { omzet: number; hpp: number; diskon: number; n: number };
  const all = cats!.results as unknown as CategoryTotal[];
  const biayaPerKategori = all.filter((c) => c.kind === "expense");
  const pendapatanLainPerKategori = all.filter((c) => c.kind === "other_income");
  const biaya = biayaPerKategori.reduce((n, c) => n + c.total, 0);
  const pendapatanLain = pendapatanLainPerKategori.reduce((n, c) => n + c.total, 0);
  const labaKotor = s.omzet - s.hpp;
  return {
    from,
    to,
    omzet: s.omzet,
    hpp: s.hpp,
    diskon: s.diskon,
    jmlTransaksi: s.n,
    labaKotor,
    pendapatanLain,
    biaya,
    biayaPerKategori,
    pendapatanLainPerKategori,
    labaBersih: labaKotor + pendapatanLain - biaya,
    penjualanTanpaHpp: (noHpp!.results[0] as { n: number }).n,
  };
}

// ---------------------------------------------------------------------------
// Arus kas (§10.2)
// ---------------------------------------------------------------------------

export interface AccountFlow {
  id: number;
  name: string;
  saldoAwal: number;
  masuk: number;
  keluar: number;
  saldoAkhir: number;
}

export interface CashFlow {
  from: string;
  to: string;
  akun: AccountFlow[];
  masukPerKategori: CategoryTotal[];
  keluarPerKategori: CategoryTotal[];
  totalSaldoAwal: number;
  totalMasuk: number;
  totalKeluar: number;
  totalSaldoAkhir: number;
}

export async function cashflow(db: D1Database, from: string, to: string): Promise<CashFlow> {
  assertRange(from, to);
  const [acc, cats] = await db.batch([
    db
      .prepare(
        `SELECT a.id, a.name,
           a.opening_balance + COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END)
                                         FROM cash_transactions WHERE account_id = a.id AND status = 'posted' AND tanggal < ?1), 0) AS saldoAwal,
           COALESCE((SELECT SUM(amount) FROM cash_transactions
                     WHERE account_id = a.id AND status = 'posted' AND direction = 'in' AND tanggal BETWEEN ?1 AND ?2), 0) AS masuk,
           COALESCE((SELECT SUM(amount) FROM cash_transactions
                     WHERE account_id = a.id AND status = 'posted' AND direction = 'out' AND tanggal BETWEEN ?1 AND ?2), 0) AS keluar
         FROM accounts a
         -- akun yang sudah dihapus tetap muncul bila punya transaksi di periode ini
         WHERE a.is_active = 1 OR EXISTS (SELECT 1 FROM cash_transactions
                                          WHERE account_id = a.id AND status = 'posted' AND tanggal BETWEEN ?1 AND ?2)
         ORDER BY a.id`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT c.id, c.name, c.kind, c.direction, SUM(t.amount) AS total
         FROM cash_transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'posted' AND t.tanggal BETWEEN ?1 AND ?2
         GROUP BY c.id ORDER BY total DESC`,
      )
      .bind(from, to),
  ]);
  const akun = (acc!.results as unknown as Omit<AccountFlow, "saldoAkhir">[]).map((a) => ({ ...a, saldoAkhir: a.saldoAwal + a.masuk - a.keluar }));
  const all = cats!.results as unknown as CategoryTotal[];
  const sum = (k: keyof AccountFlow) => akun.reduce((n, a) => n + (a[k] as number), 0);
  return {
    from,
    to,
    akun,
    masukPerKategori: all.filter((c) => c.direction === "in"),
    keluarPerKategori: all.filter((c) => c.direction === "out"),
    totalSaldoAwal: sum("saldoAwal"),
    totalMasuk: sum("masuk"),
    totalKeluar: sum("keluar"),
    totalSaldoAkhir: sum("saldoAkhir"),
  };
}

// ---------------------------------------------------------------------------
// Ringkasan per hari (§10.3)
// ---------------------------------------------------------------------------

export interface DailyRow {
  tanggal: string;
  omzet: number;
  hpp: number;
  pendapatanLain: number;
  biaya: number;
  labaBersih: number;
}

/** Hanya tanggal yang punya aktivitas yang dikembalikan, urut naik. */
export async function daily(db: D1Database, from: string, to: string): Promise<DailyRow[]> {
  assertRange(from, to);
  const [sales, cash] = await db.batch([
    db
      .prepare(
        `SELECT tanggal, SUM(total) AS omzet, SUM(total_cost) AS hpp
         FROM sales WHERE status = 'posted' AND tanggal BETWEEN ?1 AND ?2 GROUP BY tanggal`,
      )
      .bind(from, to),
    db
      .prepare(
        `SELECT t.tanggal,
                SUM(CASE WHEN c.kind = 'expense' THEN t.amount ELSE 0 END) AS biaya,
                SUM(CASE WHEN c.kind = 'other_income' THEN t.amount ELSE 0 END) AS pendapatanLain
         FROM cash_transactions t JOIN categories c ON c.id = t.category_id
         WHERE t.status = 'posted' AND t.tanggal BETWEEN ?1 AND ?2 AND c.kind IN ('expense','other_income')
         GROUP BY t.tanggal`,
      )
      .bind(from, to),
  ]);
  const map = new Map<string, DailyRow>();
  const row = (d: string) => {
    let r = map.get(d);
    if (!r) {
      r = { tanggal: d, omzet: 0, hpp: 0, pendapatanLain: 0, biaya: 0, labaBersih: 0 };
      map.set(d, r);
    }
    return r;
  };
  for (const s of sales!.results as { tanggal: string; omzet: number; hpp: number }[]) Object.assign(row(s.tanggal), { omzet: s.omzet, hpp: s.hpp });
  for (const c of cash!.results as { tanggal: string; biaya: number; pendapatanLain: number }[]) {
    Object.assign(row(c.tanggal), { biaya: c.biaya, pendapatanLain: c.pendapatanLain });
  }
  const rows = [...map.values()].sort((a, b) => a.tanggal.localeCompare(b.tanggal));
  for (const r of rows) r.labaBersih = r.omzet - r.hpp + r.pendapatanLain - r.biaya;
  return rows;
}

// ---------------------------------------------------------------------------
// Penjualan per item (§10.4)
// ---------------------------------------------------------------------------

export interface ItemRow {
  itemKey: string;
  name: string;
  qty: number;
  omzet: number;
  hpp: number;
  labaKotor: number;
}

export async function itemsSold(db: D1Database, from: string, to: string, limit = 50): Promise<ItemRow[]> {
  assertRange(from, to);
  const { results } = await db
    .prepare(
      `SELECT COALESCE(CAST(i.product_id AS TEXT), 'q:' || i.item_name) AS itemKey,
              MAX(i.item_name) AS name, SUM(i.qty) AS qty, SUM(i.line_total) AS omzet,
              SUM(i.qty * i.cost_price) AS hpp, SUM(i.line_total - i.qty * i.cost_price) AS labaKotor
       FROM sale_items i JOIN sales s ON s.id = i.sale_id
       WHERE s.status = 'posted' AND s.tanggal BETWEEN ?1 AND ?2
       GROUP BY itemKey ORDER BY omzet DESC LIMIT ?3`,
    )
    .bind(from, to, limit)
    .all<ItemRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Data mentah untuk ekspor CSV
// ---------------------------------------------------------------------------

export const EXPORT_ROW_LIMIT = 5000;

export interface SaleExportRow {
  tanggal: string;
  invoice_no: string;
  channel: string;
  item_name: string;
  qty: number;
  sell_price: number;
  line_total: number;
  cost_price: number;
  hpp: number;
  discount: number;
  total: number;
  akun: string;
  note: string | null;
}

/** Satu baris per item; kolom diskon & total penjualan hanya diisi di item pertama tiap invoice. */
export async function exportSales(db: D1Database, from: string, to: string): Promise<SaleExportRow[]> {
  assertRange(from, to);
  const { results } = await db
    .prepare(
      `SELECT s.tanggal, s.invoice_no, s.channel, i.item_name, i.qty, i.sell_price, i.line_total, i.cost_price,
              i.qty * i.cost_price AS hpp,
              CASE WHEN i.id = (SELECT MIN(id) FROM sale_items WHERE sale_id = s.id) THEN s.discount ELSE 0 END AS discount,
              CASE WHEN i.id = (SELECT MIN(id) FROM sale_items WHERE sale_id = s.id) THEN s.total ELSE 0 END AS total,
              a.name AS akun, s.note
       FROM sales s JOIN sale_items i ON i.sale_id = s.id LEFT JOIN accounts a ON a.id = s.account_id
       WHERE s.status = 'posted' AND s.tanggal BETWEEN ?1 AND ?2
       ORDER BY s.tanggal, s.id, i.id LIMIT ?3`,
    )
    .bind(from, to, EXPORT_ROW_LIMIT)
    .all<SaleExportRow>();
  return results;
}

export interface CashExportRow {
  tanggal: string;
  direction: Direction;
  kategori: string;
  jenis: CategoryKind;
  akun: string;
  amount: number;
  description: string | null;
  ref_type: string;
  source: string;
}

export async function exportCash(db: D1Database, from: string, to: string): Promise<CashExportRow[]> {
  assertRange(from, to);
  const { results } = await db
    .prepare(
      `SELECT t.tanggal, t.direction, c.name AS kategori, c.kind AS jenis, a.name AS akun, t.amount,
              t.description, t.ref_type, t.source
       FROM cash_transactions t JOIN categories c ON c.id = t.category_id JOIN accounts a ON a.id = t.account_id
       WHERE t.status = 'posted' AND t.tanggal BETWEEN ?1 AND ?2
       ORDER BY t.tanggal, t.id LIMIT ?3`,
    )
    .bind(from, to, EXPORT_ROW_LIMIT)
    .all<CashExportRow>();
  return results;
}

// ---------------------------------------------------------------------------
// Dashboard (§10.5)
// ---------------------------------------------------------------------------

export interface PeriodSummary {
  from: string;
  to: string;
  omzet: number;
  hpp: number;
  labaKotor: number;
  biaya: number;
  labaBersih: number;
  jmlTransaksi: number;
}

export interface Summary {
  today: PeriodSummary;
  month: PeriodSummary;
  /** Bulan lalu pada rentang tanggal yang sama (1 s.d. tanggal hari ini) untuk perbandingan adil. */
  prevMonth: PeriodSummary;
  saldoKas: number;
  /** 30 hari terakhir, termasuk hari tanpa transaksi (nol). */
  chart: { tanggal: string; omzet: number; labaBersih: number }[];
  topItems: ItemRow[];
  lowStock: { id: number; name: string; stock: number; min_stock: number }[] | null;
}

function toSummary(pl: ProfitLoss): PeriodSummary {
  return {
    from: pl.from,
    to: pl.to,
    omzet: pl.omzet,
    hpp: pl.hpp,
    labaKotor: pl.labaKotor,
    biaya: pl.biaya,
    labaBersih: pl.labaBersih,
    jmlTransaksi: pl.jmlTransaksi,
  };
}

export async function summary(db: D1Database, today: string, opts: { stock: boolean }): Promise<Summary> {
  const monthStart = `${today.slice(0, 8)}01`;
  const prevEnd = addDays(monthStart, -1);
  const prevStart = `${prevEnd.slice(0, 8)}01`;
  const dayOfMonth = Number(today.slice(8, 10));
  const prevTo = dayOfMonth >= Number(prevEnd.slice(8, 10)) ? prevEnd : `${prevEnd.slice(0, 8)}${String(dayOfMonth).padStart(2, "0")}`;
  const chartFrom = addDays(today, -29);

  const [t, m, p, days, top, bal, low] = await Promise.all([
    profitLoss(db, today, today),
    profitLoss(db, monthStart, today),
    profitLoss(db, prevStart, prevTo),
    daily(db, chartFrom, today),
    itemsSold(db, monthStart, today, 5),
    db
      .prepare(
        `SELECT COALESCE(SUM(a.opening_balance), 0) +
                COALESCE((SELECT SUM(CASE direction WHEN 'in' THEN amount ELSE -amount END)
                          FROM cash_transactions t JOIN accounts a2 ON a2.id = t.account_id
                          WHERE t.status = 'posted' AND a2.is_active = 1), 0) AS saldo
         FROM accounts a WHERE a.is_active = 1`,
      )
      .first<{ saldo: number }>(),
    opts.stock
      ? db
          .prepare("SELECT id, name, stock, min_stock FROM products WHERE is_active = 1 AND track_stock = 1 AND stock <= min_stock ORDER BY stock LIMIT 10")
          .all<{ id: number; name: string; stock: number; min_stock: number }>()
      : Promise.resolve(null),
  ]);

  const byDay = new Map(days.map((d) => [d.tanggal, d]));
  const chart: Summary["chart"] = [];
  for (let i = 0; i < 30; i++) {
    const d = addDays(chartFrom, i);
    const row = byDay.get(d);
    chart.push({ tanggal: d, omzet: row?.omzet ?? 0, labaBersih: row?.labaBersih ?? 0 });
  }

  return {
    today: toSummary(t),
    month: toSummary(m),
    prevMonth: toSummary(p),
    saldoKas: bal?.saldo ?? 0,
    chart,
    topItems: top,
    lowStock: low ? low.results : null,
  };
}

// ---------------------------------------------------------------------------
// Ringkasan kas per akun (kartu Kas masuk / keluar di Beranda & halaman Kas)
// ---------------------------------------------------------------------------

export interface AccountCashRow {
  id: number;
  name: string;
  /** Kas masuk dalam periode, TANPA transfer antar akun. */
  masuk: number;
  /** Kas keluar dalam periode, TANPA transfer antar akun. */
  keluar: number;
  /** Saldo akun di akhir periode (termasuk transfer & saldo awal). */
  saldo: number;
}

export interface CashByAccount {
  from: string;
  to: string;
  totalMasuk: number;
  totalKeluar: number;
  totalSaldo: number;
  akun: AccountCashRow[];
}

/**
 * Masuk/keluar per akun untuk satu periode. Transfer antar akun tidak dihitung sebagai
 * masuk/keluar (hanya memindah uang), tapi tetap memengaruhi saldo tiap akun.
 * Akun nonaktif ikut tampil bila punya transaksi di periode itu.
 */
export async function cashByAccount(db: D1Database, from: string, to: string): Promise<CashByAccount> {
  assertRange(from, to);
  const { results } = await db
    .prepare(
      `SELECT a.id, a.name,
         COALESCE((SELECT SUM(t.amount) FROM cash_transactions t
                   WHERE t.account_id = a.id AND t.status = 'posted' AND t.direction = 'in'
                     AND t.ref_type <> 'transfer' AND t.tanggal BETWEEN ?1 AND ?2), 0) AS masuk,
         COALESCE((SELECT SUM(t.amount) FROM cash_transactions t
                   WHERE t.account_id = a.id AND t.status = 'posted' AND t.direction = 'out'
                     AND t.ref_type <> 'transfer' AND t.tanggal BETWEEN ?1 AND ?2), 0) AS keluar,
         a.opening_balance + COALESCE((SELECT SUM(CASE t.direction WHEN 'in' THEN t.amount ELSE -t.amount END)
                   FROM cash_transactions t
                   WHERE t.account_id = a.id AND t.status = 'posted' AND t.tanggal <= ?2), 0) AS saldo
       FROM accounts a
       WHERE a.is_active = 1 OR EXISTS (SELECT 1 FROM cash_transactions
                                        WHERE account_id = a.id AND status = 'posted' AND tanggal BETWEEN ?1 AND ?2)
       ORDER BY a.id`,
    )
    .bind(from, to)
    .all<AccountCashRow>();
  return {
    from,
    to,
    totalMasuk: results.reduce((n, r) => n + r.masuk, 0),
    totalKeluar: results.reduce((n, r) => n + r.keluar, 0),
    totalSaldo: results.reduce((n, r) => n + r.saldo, 0),
    akun: results,
  };
}
