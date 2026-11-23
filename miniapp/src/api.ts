/** Klien REST API. Token sesi disimpan di memori; bila kedaluwarsa, login ulang otomatis via initData. */
import { initData } from "./tg";

export type Role = "owner" | "admin" | "staff";
export type Direction = "in" | "out";
export type CategoryKind = "sales" | "other_income" | "capital_in" | "expense" | "stock_purchase" | "capital_out" | "transfer";

export interface Me {
  id: number;
  full_name: string;
  role: Role;
}
export interface Account {
  id: number;
  name: string;
  opening_balance?: number;
  type: "cash" | "bank" | "ewallet" | "marketplace";
  /** Hanya untuk owner/admin. */
  balance?: number;
}
export interface Category {
  id: number;
  name: string;
  direction: Direction;
  kind: CategoryKind;
  is_system: number;
}
export interface Channel {
  id: number;
  code: string;
  name: string;
  is_system: number;
}
export interface Meta {
  user: Me;
  business_name: string;
  features: { stock: boolean };
  accounts: Account[];
  categories: Category[];
  channels: Channel[];
  today: string;
  version: string;
}

export interface CashRow {
  id: number;
  tanggal: string;
  direction: Direction;
  amount: number;
  category_name: string;
  category_kind: CategoryKind;
  account_name: string;
  description: string | null;
  ref_type: "sale" | "purchase" | "transfer" | "manual";
  status: "posted" | "void";
  created_by_name: string | null;
  void_reason: string | null;
}

export interface SaleItem {
  id: number;
  product_id: number | null;
  item_name: string;
  qty: number;
  sell_price: number;
  cost_price?: number;
  line_total: number;
}
export interface Sale {
  id: number;
  invoice_no: string;
  tanggal: string;
  channel: string;
  subtotal: number;
  discount: number;
  total: number;
  total_cost?: number;
  status: "posted" | "void";
  note: string | null;
  account_name?: string | null;
  item_count?: number;
  first_item?: string | null;
  items?: SaleItem[];
  warnings?: string[];
  void_reason: string | null;
}

export interface Product {
  id: number;
  name: string;
  unit: string;
  sell_price: number;
  cost_price?: number;
  stock: number;
  min_stock: number;
  track_stock: number;
}

export interface PeriodSummary {
  omzet: number;
  jmlTransaksi: number;
  hpp?: number;
  labaKotor?: number;
  biaya?: number;
  labaBersih?: number;
}
export interface ItemRow {
  itemKey: string;
  name: string;
  qty: number;
  omzet: number;
  hpp?: number;
  labaKotor?: number;
}
export interface Summary {
  today: PeriodSummary;
  month: PeriodSummary;
  prevMonth?: PeriodSummary;
  saldoKas?: number;
  chart: { tanggal: string; omzet: number; labaBersih?: number }[];
  topItems: ItemRow[];
  lowStock?: { id: number; name: string; stock: number; min_stock: number }[] | null;
}

export interface CategoryTotal {
  id: number;
  name: string;
  kind: CategoryKind;
  direction: Direction;
  total: number;
}
export interface Period {
  code: string;
  from: string;
  to: string;
  label: string;
}
export interface ProfitLoss {
  period: Period;
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
  penjualanTanpaHpp: number;
}
export interface CashFlow {
  period: Period;
  akun: { id: number; name: string; saldoAwal: number; masuk: number; keluar: number; saldoAkhir: number }[];
  masukPerKategori: CategoryTotal[];
  keluarPerKategori: CategoryTotal[];
  totalSaldoAwal: number;
  totalMasuk: number;
  totalKeluar: number;
  totalSaldoAkhir: number;
}
export interface DailyRow {
  tanggal: string;
  omzet: number;
  hpp: number;
  pendapatanLain: number;
  biaya: number;
  labaBersih: number;
}

export class ApiError extends Error {
  constructor(
    public code: string,
    message: string,
    public status: number,
  ) {
    super(message);
  }
}

let token = "";

async function raw<T>(method: string, path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`/api${path}`, {
      method,
      headers: { "content-type": "application/json", ...(token ? { Authorization: `Bearer ${token}` } : {}) },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
    });
  } catch {
    throw new ApiError("NETWORK", "Tidak ada koneksi. Coba lagi.", 0);
  }
  let json: { ok: boolean; data?: T; error?: { code: string; message: string } };
  try {
    json = await res.json();
  } catch {
    throw new ApiError("BAD_RESPONSE", "Server tidak merespons dengan benar.", res.status);
  }
  if (!json.ok) throw new ApiError(json.error?.code ?? "ERROR", json.error?.message ?? "Terjadi kesalahan.", res.status);
  return json.data as T;
}

async function req<T>(method: string, path: string, body?: unknown): Promise<T> {
  try {
    return await raw<T>(method, path, body);
  } catch (e) {
    // Sesi 12 jam habis → login ulang sekali dengan initData lalu ulangi.
    if (e instanceof ApiError && e.status === 401 && e.code === "UNAUTHORIZED" && initData()) {
      await login(initData());
      return raw<T>(method, path, body);
    }
    throw e;
  }
}

export async function login(data: string): Promise<Me> {
  const r = await raw<{ token: string; user: Me }>("POST", "/auth", { initData: data });
  token = r.token;
  return r.user;
}

function qs(params: Record<string, string | number | undefined>): string {
  const p = new URLSearchParams();
  for (const [k, v] of Object.entries(params)) if (v !== undefined && v !== "") p.set(k, String(v));
  const s = p.toString();
  return s ? `?${s}` : "";
}

export interface Page<T> {
  items: T[];
  hasMore: boolean;
}

export const api = {
  meta: () => req<Meta>("GET", "/meta"),
  summary: () => req<Summary>("GET", "/reports/summary"),

  listCash: (q: { from: string; to: string; direction?: Direction; page?: number }) => req<Page<CashRow>>("GET", `/cash${qs(q)}`),
  cashSummary: (from: string, to: string) => req<CashByAccount>("GET", `/cash/summary${qs({ from, to })}`),
  createCash: (b: { uid: string; tanggal: string; direction: Direction; amount: number; category_id: number; account_id: number; description: string | null }) =>
    req<CashRow>("POST", "/cash", b),
  transfer: (b: { uid: string; tanggal: string; amount: number; from_account_id: number; to_account_id: number; description: string | null }) =>
    req<unknown>("POST", "/cash/transfer", b),
  voidCash: (id: number, reason?: string) => req<unknown>("POST", `/cash/${id}/void`, { reason }),

  listSales: (q: { from: string; to: string; page?: number }) => req<Page<Sale>>("GET", `/sales${qs(q)}`),
  getSale: (id: number) => req<Sale>("GET", `/sales/${id}`),
  createSale: (b: {
    uid: string;
    tanggal: string;
    channel: string;
    items: ({ product_id: number; qty: number; sell_price?: number } | { item_name: string; qty: number; sell_price: number; cost_price?: number })[];
    discount: number;
    account_id: number;
    note: string | null;
  }) => req<Sale>("POST", "/sales", b),
  voidSale: (id: number, reason?: string) => req<Sale>("POST", `/sales/${id}/void`, { reason }),

  products: (q?: string) => req<Product[]>("GET", `/products${qs({ q })}`),
  createProduct: (b: ProductInput & { opening_stock?: number }) => req<Product>("POST", "/products", b),
  updateProduct: (id: number, b: Partial<ProductInput>) => req<Product>("PATCH", `/products/${id}`, b),
  deleteProduct: (id: number) => req<unknown>("DELETE", `/products/${id}`),
  setStock: (id: number, actual: number, note: string | null) => req<{ product: Product; change: number }>("POST", `/products/${id}/stock`, { actual, note }),
  movements: (id: number) => req<StockMovement[]>("GET", `/products/${id}/movements`),
  purchases: (q: { from: string; to: string; page?: number }) => req<Page<PurchaseRow>>("GET", `/purchases${qs(q)}`),
  getPurchase: (id: number) => req<PurchaseDetail>("GET", `/purchases/${id}`),
  createPurchase: (b: { uid: string; tanggal: string; supplier: string | null; items: { product_id: number; qty: number; unit_cost: number }[]; account_id: number; update_cost: UpdateCost; note: string | null }) =>
    req<PurchaseDetail>("POST", "/purchases", b),
  voidPurchase: (id: number) => req<PurchaseDetail>("POST", `/purchases/${id}/void`, {}),

  profitLoss: (from: string, to: string) => req<ProfitLoss>("GET", `/reports/profit-loss${qs({ from, to })}`),
  cashflow: (from: string, to: string) => req<CashFlow>("GET", `/reports/cashflow${qs({ from, to })}`),
  daily: (from: string, to: string) => req<{ period: Period; rows: DailyRow[] }>("GET", `/reports/daily${qs({ from, to })}`),
  items: (from: string, to: string) => req<{ period: Period; rows: ItemRow[] }>("GET", `/reports/items${qs({ from, to })}`),
  exportReport: (from: string, to: string) => req<{ sent: boolean }>("POST", `/reports/export${qs({ from, to })}`),

  createCategory: (b: { name: string; direction: Direction; kind: CategoryKind }) => req<Category>("POST", "/categories", b),
  updateCategory: (id: number, b: { name?: string; kind?: CategoryKind }) => req<Category>("PATCH", `/categories/${id}`, b),
  deleteCategory: (id: number) => req<unknown>("DELETE", `/categories/${id}`),
  createAccount: (b: { name: string; type: Account["type"]; opening_balance: number }) => req<Account>("POST", "/accounts", b),
  updateAccount: (id: number, b: { name?: string; type?: Account["type"]; opening_balance?: number }) => req<Account>("PATCH", `/accounts/${id}`, b),
  deleteAccount: (id: number) => req<unknown>("DELETE", `/accounts/${id}`),
  createChannel: (name: string) => req<Channel>("POST", "/channels", { name }),
  updateChannel: (id: number, name: string) => req<Channel>("PATCH", `/channels/${id}`, { name }),
  deleteChannel: (id: number) => req<unknown>("DELETE", `/channels/${id}`),
  settings: () => req<AppSettings>("GET", "/settings"),
  updateSettings: (b: Partial<Omit<AppSettings, "report_target">> & { report_target?: "owner" }) => req<AppSettings>("PATCH", "/settings", b),
  users: () => req<UserRow[]>("GET", "/users"),
  invite: (role: "admin" | "staff") => req<{ link: string; expires_at: string }>("POST", "/users/invite", { role }),
  updateUser: (id: number, b: { role?: "admin" | "staff"; is_active?: boolean }) => req<UserRow>("PATCH", `/users/${id}`, b),
};

export interface AppSettings {
  business_name: string;
  daily_report_enabled: boolean;
  weekly_report_enabled: boolean;
  monthly_report_enabled: boolean;
  report_hour: number;
  report_target: { type: "owner" | "group"; chatId: number | null; title: string | null };
  feature_stock: boolean;
}

export interface UserRow {
  id: number;
  telegram_id: number;
  username: string | null;
  full_name: string;
  role: Role;
  is_active: number;
}


export interface ProductInput {
  name: string;
  cost_price: number;
  sell_price: number;
  unit?: string;
  track_stock?: boolean;
  min_stock?: number;
}

export type UpdateCost = "average" | "last" | "none";

export interface StockMovement {
  id: number;
  tanggal: string;
  type: "sale" | "sale_void" | "purchase" | "purchase_void" | "adjustment" | "opening";
  qty_change: number;
  note: string | null;
  created_by_name: string | null;
}

export interface PurchaseRow {
  id: number;
  tanggal: string;
  supplier: string | null;
  total: number;
  status: "posted" | "void";
  account_name: string | null;
  item_count: number;
  first_item: string | null;
}

export interface PurchaseDetail extends PurchaseRow {
  update_cost: UpdateCost;
  note: string | null;
  void_reason: string | null;
  items: { id: number; product_id: number; product_name: string; qty: number; unit_cost?: number; line_total: number }[];
  hppChanges?: { product_id: number; name: string; before: number; after: number }[];
  warnings: string[];
}

/** Kas masuk/keluar per akun (tanpa transfer). `saldo` hanya untuk owner/admin. */
export interface CashByAccount {
  from: string;
  to: string;
  totalMasuk: number;
  totalKeluar: number;
  totalSaldo?: number;
  akun: { id: number; name: string; masuk: number; keluar: number; saldo?: number }[];
}
