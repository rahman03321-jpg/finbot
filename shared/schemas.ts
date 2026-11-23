/**
 * Skema body/query REST API (ARCHITECTURE.md §11). Dipakai worker untuk validasi.
 * Mini App cukup mengimpor TIPE-nya (`import type`), supaya zod tidak ikut ke bundle.
 */
import { z } from "zod";

const MAX_AMOUNT = 1_000_000_000_000;

export const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "Format tanggal YYYY-MM-DD");
export const money = z.int().min(0).max(MAX_AMOUNT);
export const positiveMoney = z.int().min(1).max(MAX_AMOUNT);
const id = z.int().positive();
const uid = z.string().min(8).max(64).regex(/^[A-Za-z0-9:_-]+$/);
const note = z.string().max(200).nullish();

export const AuthBody = z.object({ initData: z.string().min(1).max(4096) });

export const CashCreateBody = z.object({
  uid: uid.optional(),
  tanggal: ymd,
  direction: z.enum(["in", "out"]),
  amount: positiveMoney,
  category_id: id,
  account_id: id,
  description: note,
});

export const TransferBody = z.object({
  uid: uid.optional(),
  tanggal: ymd,
  amount: positiveMoney,
  from_account_id: id,
  to_account_id: id,
  description: note,
});

export const VoidBody = z.object({ reason: z.string().max(200).optional() });

const ProductItem = z.object({
  product_id: id,
  qty: z.int().min(1).max(1_000_000),
  sell_price: money.optional(),
});
const QuickItem = z.object({
  item_name: z.string().trim().min(1).max(80),
  qty: z.int().min(1).max(1_000_000),
  sell_price: money,
  cost_price: money.optional(),
});

export const SaleCreateBody = z.object({
  uid: uid.optional(),
  tanggal: ymd,
  channel: z.string().trim().max(30).optional(),
  customer_name: z.string().max(80).nullish(),
  items: z.array(z.union([ProductItem, QuickItem])).min(1).max(50),
  discount: money.optional(),
  account_id: id,
  note,
});

const qty = z.int().min(0).max(1_000_000_000);

export const ProductCreateBody = z.object({
  name: z.string().trim().min(1).max(80),
  cost_price: money,
  sell_price: money,
  unit: z.string().trim().max(20).optional(),
  sku: z.string().trim().max(40).nullish(),
  track_stock: z.boolean().optional(),
  min_stock: qty.optional(),
  /** Stok awal (hanya dipakai bila modul stok aktif). */
  opening_stock: qty.optional(),
});

export const ProductPatchBody = z
  .object({
    name: z.string().trim().min(1).max(80).optional(),
    cost_price: money.optional(),
    sell_price: money.optional(),
    unit: z.string().trim().max(20).optional(),
    track_stock: z.boolean().optional(),
    min_stock: qty.optional(),
  })
  .refine((v) => Object.values(v).some((x) => x !== undefined), "Tidak ada perubahan");

/** Query periode laporan: `period` (kode/teks) ATAU `from` & `to`. */
export const PeriodQuery = z.object({
  period: z.string().max(60).optional(),
  from: ymd.optional(),
  to: ymd.optional(),
});

export const ListQuery = z.object({
  from: ymd.optional(),
  to: ymd.optional(),
  page: z.coerce.number().int().min(1).max(10_000).optional(),
  limit: z.coerce.number().int().min(1).max(100).optional(),
});

export const CashListQuery = ListQuery.extend({
  direction: z.enum(["in", "out"]).optional(),
  account_id: z.coerce.number().int().positive().optional(),
  category_id: z.coerce.number().int().positive().optional(),
});

export type CashCreateInput = z.infer<typeof CashCreateBody>;
export type TransferInput = z.infer<typeof TransferBody>;
export type SaleCreateInput = z.infer<typeof SaleCreateBody>;
export type ProductCreateInput = z.infer<typeof ProductCreateBody>;
export type ProductPatchInput = z.infer<typeof ProductPatchBody>;

// --- Data master (Pengaturan) -------------------------------------------------

const categoryKind = z.enum(["other_income", "capital_in", "expense", "stock_purchase", "capital_out"]);
const accountType = z.enum(["cash", "bank", "ewallet", "marketplace"]);
const signedMoney = z.int().min(-MAX_AMOUNT).max(MAX_AMOUNT);

export const CategoryCreateBody = z.object({
  name: z.string().trim().min(1).max(40),
  direction: z.enum(["in", "out"]),
  kind: categoryKind,
});
export const CategoryPatchBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  kind: categoryKind.optional(),
});

export const AccountCreateBody = z.object({
  name: z.string().trim().min(1).max(40),
  type: accountType,
  opening_balance: signedMoney.optional(),
});
export const AccountPatchBody = z.object({
  name: z.string().trim().min(1).max(40).optional(),
  type: accountType.optional(),
  opening_balance: signedMoney.optional(),
});

export const ChannelBody = z.object({ name: z.string().trim().min(1).max(30) });

// --- Pengaturan usaha & user (owner) --------------------------------------------

export const SettingsPatchBody = z.object({
  business_name: z.string().trim().min(1).max(60).optional(),
  daily_report_enabled: z.boolean().optional(),
  weekly_report_enabled: z.boolean().optional(),
  monthly_report_enabled: z.boolean().optional(),
  report_hour: z.int().min(0).max(23).optional(),
  report_target: z.literal("owner").optional(),
  feature_stock: z.boolean().optional(),
});

export const InviteBody = z.object({ role: z.enum(["admin", "staff"]) });

export const UserPatchBody = z
  .object({ role: z.enum(["admin", "staff"]).optional(), is_active: z.boolean().optional() })
  .refine((v) => v.role !== undefined || v.is_active !== undefined, "Tidak ada perubahan");

// --- Modul stok -----------------------------------------------------------------

export const StockSetBody = z.object({
  actual: z.int().min(-1_000_000_000).max(1_000_000_000),
  note: z.string().max(200).nullish(),
  tanggal: ymd.optional(),
});

export const PurchaseCreateBody = z.object({
  uid: uid.optional(),
  tanggal: ymd,
  supplier: z.string().max(80).nullish(),
  items: z.array(z.object({ product_id: id, qty: z.int().min(1).max(1_000_000), unit_cost: money })).min(1).max(50),
  account_id: id,
  update_cost: z.enum(["average", "last", "none"]).optional(),
  note,
});
