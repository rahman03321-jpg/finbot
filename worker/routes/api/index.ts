/** REST API Mini App (ARCHITECTURE.md §11). Respons: { ok: true, data } | { ok: false, error }. */
import { Hono } from "hono";
import type { Env } from "../../env";
import { AppError } from "../../lib/errors";
import { wibDate } from "../../lib/date";
import { validateInitData } from "../../auth/initData";
import { issueSession } from "../../auth/session";
import { InviteBody, PurchaseCreateBody, SettingsPatchBody, StockSetBody, UserPatchBody, AccountCreateBody, AccountPatchBody, AuthBody, CategoryCreateBody, CategoryPatchBody, ChannelBody, CashCreateBody, CashListQuery, ListQuery, PeriodQuery, ProductCreateBody, ProductPatchBody, SaleCreateBody, TransferBody, VoidBody } from "../../../shared/schemas";
import { getAppSettings, getSessionSecret, getSetting, updateAppSettings, type SettingsPatch } from "../../services/settings";
import { createInvite, findActiveUser, listUsers, updateUser } from "../../services/users";
import { getFeatures, requireStock } from "../../services/features";
import {
  accountBalances,
  createCashTransaction,
  createTransfer,
  listAccounts,
  listCash,
  listCategories,
  voidCashTransaction,
} from "../../services/cash";
import { createSale, getSale, listSales, voidSale } from "../../services/sales";
import { createProduct, deleteProduct, listProducts, updateProduct } from "../../services/products";
import { cashByAccount, cashflow, daily, itemsSold, profitLoss, summary } from "../../services/reports";
import { sendExport } from "../../bot/commands/reports";
import { botCommands } from "../../bot/commands/list";
import { listMovements, lowStock, setStockCount } from "../../services/stock";
import { createPurchase, getPurchase, listPurchases, voidPurchase } from "../../services/purchases";
import { addAccount, createCategory, createChannel, deleteAccount, deleteCategory, deleteChannel, listChannels, updateAccount, updateCategory, updateChannel } from "../../services/masters";
import { ok, parseBody, parseQuery, requireAdmin, requireOwner, requireSession, resolvePeriod, telegramApi, type ApiEnv } from "./util";

export const apiRoutes = new Hono<ApiEnv>();

// ---------------------------------------------------------------------------
// Auth (tanpa sesi)
// ---------------------------------------------------------------------------

const publicApi = new Hono<{ Bindings: Env }>();

publicApi.post("/auth", async (c) => {
  const { initData } = await parseBody(c, AuthBody);
  const tg = await validateInitData(initData, c.env.BOT_TOKEN);
  const user = await findActiveUser(c.env.DB, tg.id);
  if (!user) throw new AppError("NOT_REGISTERED", "Akun Telegram kamu belum terdaftar. Minta owner mengundang kamu.", 403);
  const session = await issueSession(user.id, await getSessionSecret(c.env));
  return c.json({
    ok: true,
    data: { token: session.token, expires_at: session.expiresAt, user: { id: user.id, full_name: user.full_name, role: user.role } },
  });
});

apiRoutes.route("/", publicApi);

// ---------------------------------------------------------------------------
// Semua endpoint di bawah ini butuh sesi
// ---------------------------------------------------------------------------

const api = new Hono<ApiEnv>();
api.use("*", requireSession);

function ymdRange(q: { from?: string | undefined; to?: string | undefined }): { from: string; to: string } {
  const today = wibDate();
  return { from: q.from ?? `${today.slice(0, 8)}01`, to: q.to ?? today };
}

api.get("/meta", async (c) => {
  const db = c.env.DB;
  const u = c.var.user;
  const admin = u.role !== "staff";
  const [business, features, accounts, categories, channels] = await Promise.all([
    getSetting(db, "business_name"),
    getFeatures(db),
    admin ? accountBalances(db) : listAccounts(db),
    listCategories(db),
    listChannels(db),
  ]);
  return ok(c, {
    user: { id: u.id, full_name: u.full_name, role: u.role },
    business_name: business ?? "Usaha Saya",
    features,
    accounts,
    categories,
    channels,
    today: wibDate(),
    version: c.env.APP_VERSION,
  });
});

// --- Kas ---------------------------------------------------------------------

/** Kas masuk/keluar per akun (tanpa transfer) + saldo per akun. Staff tidak menerima saldo. */
api.get("/cash/summary", async (c) => {
  const q = parseQuery(c, ListQuery);
  const r = ymdRange(q);
  const s = await cashByAccount(c.env.DB, r.from, r.to);
  if (c.var.user.role === "staff") {
    return ok(c, {
      from: s.from,
      to: s.to,
      totalMasuk: s.totalMasuk,
      totalKeluar: s.totalKeluar,
      akun: s.akun.map(({ id, name, masuk, keluar }) => ({ id, name, masuk, keluar })),
    });
  }
  return ok(c, s);
});

api.get("/cash", async (c) => {
  const q = parseQuery(c, CashListQuery);
  return ok(c, await listCash(c.env.DB, { ...ymdRange(q), direction: q.direction, accountId: q.account_id, categoryId: q.category_id, page: q.page, limit: q.limit }));
});

api.post("/cash", async (c) => {
  const b = await parseBody(c, CashCreateBody);
  const tx = await createCashTransaction(
    c.env.DB,
    { uid: b.uid, tanggal: b.tanggal, direction: b.direction, amount: b.amount, categoryId: b.category_id, accountId: b.account_id, description: b.description ?? null, source: "miniapp" },
    c.var.actor,
  );
  return ok(c, tx, 201);
});

api.post("/cash/transfer", async (c) => {
  const b = await parseBody(c, TransferBody);
  const t = await createTransfer(
    c.env.DB,
    { uid: b.uid, tanggal: b.tanggal, amount: b.amount, fromAccountId: b.from_account_id, toAccountId: b.to_account_id, description: b.description ?? null, source: "miniapp" },
    c.var.actor,
  );
  return ok(c, t, 201);
});

api.post("/cash/:id/void", async (c) => {
  const b = await parseBody(c, VoidBody);
  return ok(c, await voidCashTransaction(c.env.DB, Number(c.req.param("id")), b.reason ?? "Dibatalkan lewat aplikasi", c.var.actor));
});

// --- Penjualan -----------------------------------------------------------------

api.get("/sales", async (c) => {
  const q = parseQuery(c, ListQuery);
  return ok(c, await listSales(c.env.DB, { ...ymdRange(q), page: q.page, limit: q.limit }));
});

api.get("/sales/:id", async (c) => {
  const s = await getSale(c.env.DB, Number(c.req.param("id")));
  if (!s) throw new AppError("NOT_FOUND", "Penjualan tidak ditemukan.", 404);
  return ok(c, s);
});

api.post("/sales", async (c) => {
  const b = await parseBody(c, SaleCreateBody);
  const sale = await createSale(
    c.env.DB,
    {
      uid: b.uid,
      tanggal: b.tanggal,
      channel: b.channel,
      customerName: b.customer_name ?? null,
      items: b.items.map((i) =>
        "product_id" in i
          ? { productId: i.product_id, qty: i.qty, ...(i.sell_price !== undefined ? { sellPrice: i.sell_price } : {}) }
          : { itemName: i.item_name, qty: i.qty, sellPrice: i.sell_price, costPrice: i.cost_price ?? 0 },
      ),
      discount: b.discount ?? 0,
      accountId: b.account_id,
      note: b.note ?? null,
      source: "miniapp",
    },
    c.var.actor,
  );
  return ok(c, sale, 201);
});

api.post("/sales/:id/void", async (c) => {
  const b = await parseBody(c, VoidBody);
  return ok(c, await voidSale(c.env.DB, Number(c.req.param("id")), b.reason ?? "Dibatalkan lewat aplikasi", c.var.actor, { voidDate: wibDate() }));
});

// --- Produk ------------------------------------------------------------------

api.get("/products", async (c) => {
  const q = c.req.query("q");
  const active = c.req.query("active") !== "0";
  return ok(c, await listProducts(c.env.DB, { q, activeOnly: active }));
});

api.post("/products", async (c) => {
  requireAdmin(c);
  const b = await parseBody(c, ProductCreateBody);
  let p = await createProduct(
    c.env.DB,
    {
      name: b.name,
      costPrice: b.cost_price,
      sellPrice: b.sell_price,
      unit: b.unit,
      sku: b.sku ?? null,
      ...(b.track_stock !== undefined ? { trackStock: b.track_stock } : {}),
      ...(b.min_stock !== undefined ? { minStock: b.min_stock } : {}),
    },
    c.var.actor,
  );
  // Stok awal → mutasi 'opening' (hanya bila modul stok aktif & produk dilacak).
  if (b.opening_stock && p.track_stock && (await getFeatures(c.env.DB)).stock) {
    p = (await setStockCount(c.env.DB, p.id, b.opening_stock, { tanggal: wibDate(), note: "Stok awal" }, c.var.actor)).product;
  }
  return ok(c, p, 201);
});

api.patch("/products/:id", async (c) => {
  requireAdmin(c);
  const b = await parseBody(c, ProductPatchBody);
  return ok(
    c,
    await updateProduct(
      c.env.DB,
      Number(c.req.param("id")),
      {
        ...(b.name !== undefined ? { name: b.name } : {}),
        ...(b.cost_price !== undefined ? { costPrice: b.cost_price } : {}),
        ...(b.sell_price !== undefined ? { sellPrice: b.sell_price } : {}),
        ...(b.unit !== undefined ? { unit: b.unit } : {}),
        ...(b.track_stock !== undefined ? { trackStock: b.track_stock } : {}),
        ...(b.min_stock !== undefined ? { minStock: b.min_stock } : {}),
      },
      c.var.actor,
    ),
  );
});

api.delete("/products/:id", async (c) => {
  requireAdmin(c);
  await deleteProduct(c.env.DB, Number(c.req.param("id")), c.var.actor);
  return ok(c, { deleted: true });
});

// --- Modul stok ----------------------------------------------------------------

api.post("/products/:id/stock", async (c) => {
  const b = await parseBody(c, StockSetBody);
  return ok(c, await setStockCount(c.env.DB, Number(c.req.param("id")), b.actual, { tanggal: b.tanggal ?? wibDate(), note: b.note ?? null }, c.var.actor));
});

api.get("/products/:id/movements", async (c) => {
  requireAdmin(c);
  return ok(c, await listMovements(c.env.DB, Number(c.req.param("id"))));
});

api.get("/stock/low", async (c) => {
  await requireStock(c.env.DB);
  return ok(c, await lowStock(c.env.DB));
});

api.get("/purchases", async (c) => {
  requireAdmin(c);
  await requireStock(c.env.DB);
  const q = parseQuery(c, ListQuery);
  return ok(c, await listPurchases(c.env.DB, { ...ymdRange(q), page: q.page, limit: q.limit }));
});

api.get("/purchases/:id", async (c) => {
  requireAdmin(c);
  const p = await getPurchase(c.env.DB, Number(c.req.param("id")));
  if (!p) throw new AppError("NOT_FOUND", "Pembelian tidak ditemukan.", 404);
  return ok(c, p);
});

api.post("/purchases", async (c) => {
  const b = await parseBody(c, PurchaseCreateBody);
  return ok(
    c,
    await createPurchase(
      c.env.DB,
      {
        uid: b.uid,
        tanggal: b.tanggal,
        supplier: b.supplier ?? null,
        items: b.items.map((i) => ({ productId: i.product_id, qty: i.qty, unitCost: i.unit_cost })),
        accountId: b.account_id,
        updateCost: b.update_cost ?? "average",
        note: b.note ?? null,
        source: "miniapp",
      },
      c.var.actor,
    ),
    201,
  );
});

api.post("/purchases/:id/void", async (c) => {
  const b = await parseBody(c, VoidBody);
  return ok(c, await voidPurchase(c.env.DB, Number(c.req.param("id")), b.reason ?? "Dibatalkan lewat aplikasi", c.var.actor, { voidDate: wibDate() }));
});

// --- Laporan -----------------------------------------------------------------

api.get("/reports/summary", async (c) => {
  const features = await getFeatures(c.env.DB);
  const s = await summary(c.env.DB, wibDate(), { stock: features.stock });
  if (c.var.user.role === "staff") {
    // Staff: hanya omzet & jumlah transaksi (tanpa saldo, biaya, atau laba).
    return ok(c, {
      today: { omzet: s.today.omzet, jmlTransaksi: s.today.jmlTransaksi },
      month: { omzet: s.month.omzet, jmlTransaksi: s.month.jmlTransaksi },
      chart: s.chart.map((d) => ({ tanggal: d.tanggal, omzet: d.omzet })),
      topItems: s.topItems,
    });
  }
  return ok(c, s);
});

api.get("/reports/profit-loss", async (c) => {
  requireAdmin(c);
  const p = resolvePeriod(parseQuery(c, PeriodQuery));
  return ok(c, { period: p, ...(await profitLoss(c.env.DB, p.from, p.to)) });
});

api.get("/reports/cashflow", async (c) => {
  requireAdmin(c);
  const p = resolvePeriod(parseQuery(c, PeriodQuery));
  return ok(c, { period: p, ...(await cashflow(c.env.DB, p.from, p.to)) });
});

api.get("/reports/daily", async (c) => {
  requireAdmin(c);
  const p = resolvePeriod(parseQuery(c, PeriodQuery));
  return ok(c, { period: p, rows: await daily(c.env.DB, p.from, p.to) });
});

api.get("/reports/items", async (c) => {
  requireAdmin(c);
  const p = resolvePeriod(parseQuery(c, PeriodQuery));
  return ok(c, { period: p, rows: await itemsSold(c.env.DB, p.from, p.to, 100) });
});

/** Kirim CSV ke chat pribadi user lewat bot (unduhan langsung di webview Telegram tidak andal). */
api.post("/reports/export", async (c) => {
  requireAdmin(c);
  const p = resolvePeriod(parseQuery(c, PeriodQuery));
  await sendExport(telegramApi(c.env), c.var.user.telegram_id, c.env.DB, p);
  return ok(c, { sent: true, period: p });
});

// --- Data master (Pengaturan) -------------------------------------------------

const idParam = (c: { req: { param(k: string): string } }) => Number(c.req.param("id"));

api.post("/categories", async (c) => {
  const b = await parseBody(c, CategoryCreateBody);
  return ok(c, await createCategory(c.env.DB, b, c.var.actor), 201);
});
api.patch("/categories/:id", async (c) => {
  const b = await parseBody(c, CategoryPatchBody);
  return ok(c, await updateCategory(c.env.DB, idParam(c), { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.kind !== undefined ? { kind: b.kind } : {}) }, c.var.actor));
});
api.delete("/categories/:id", async (c) => {
  await deleteCategory(c.env.DB, idParam(c), c.var.actor);
  return ok(c, { deleted: true });
});

api.post("/accounts", async (c) => {
  const b = await parseBody(c, AccountCreateBody);
  return ok(c, await addAccount(c.env.DB, { name: b.name, type: b.type, openingBalance: b.opening_balance ?? 0 }, c.var.actor), 201);
});
api.patch("/accounts/:id", async (c) => {
  const b = await parseBody(c, AccountPatchBody);
  return ok(
    c,
    await updateAccount(
      c.env.DB,
      idParam(c),
      { ...(b.name !== undefined ? { name: b.name } : {}), ...(b.type !== undefined ? { type: b.type } : {}), ...(b.opening_balance !== undefined ? { openingBalance: b.opening_balance } : {}) },
      c.var.actor,
    ),
  );
});
api.delete("/accounts/:id", async (c) => {
  await deleteAccount(c.env.DB, idParam(c), c.var.actor);
  return ok(c, { deleted: true });
});

api.get("/channels", async (c) => ok(c, await listChannels(c.env.DB)));
api.post("/channels", async (c) => {
  const b = await parseBody(c, ChannelBody);
  return ok(c, await createChannel(c.env.DB, b, c.var.actor), 201);
});
api.patch("/channels/:id", async (c) => {
  const b = await parseBody(c, ChannelBody);
  return ok(c, await updateChannel(c.env.DB, idParam(c), b, c.var.actor));
});
api.delete("/channels/:id", async (c) => {
  await deleteChannel(c.env.DB, idParam(c), c.var.actor);
  return ok(c, { deleted: true });
});

// --- Pengaturan usaha & user ---------------------------------------------------

api.get("/settings", async (c) => {
  requireAdmin(c);
  return ok(c, await getAppSettings(c.env.DB));
});

api.patch("/settings", async (c) => {
  const b = await parseBody(c, SettingsPatchBody);
  const patch: SettingsPatch = {};
  if (b.business_name !== undefined) patch.business_name = b.business_name;
  if (b.daily_report_enabled !== undefined) patch.daily_report_enabled = b.daily_report_enabled;
  if (b.weekly_report_enabled !== undefined) patch.weekly_report_enabled = b.weekly_report_enabled;
  if (b.monthly_report_enabled !== undefined) patch.monthly_report_enabled = b.monthly_report_enabled;
  if (b.report_hour !== undefined) patch.report_hour = b.report_hour;
  if (b.report_target !== undefined) patch.report_target = b.report_target;
  if (b.feature_stock !== undefined) patch.feature_stock = b.feature_stock;
  const s = await updateAppSettings(c.env.DB, patch, c.var.actor);
  if (b.feature_stock !== undefined) {
    // Menu perintah bot ikut berubah (/stok & /restock). Gagal = tidak fatal; /setup juga memasangnya.
    await telegramApi(c.env)
      .setMyCommands(botCommands({ featureStock: s.feature_stock }))
      .catch((e: unknown) => console.warn("setMyCommands gagal", e));
  }
  return ok(c, s);
});

api.get("/users", async (c) => {
  requireOwner(c);
  return ok(c, await listUsers(c.env.DB));
});

api.post("/users/invite", async (c) => {
  const b = await parseBody(c, InviteBody);
  const inv = await createInvite(c.env.DB, b.role, c.var.actor);
  const raw = await getSetting(c.env.DB, "bot_info");
  const username = raw ? (JSON.parse(raw) as { username?: string }).username : undefined;
  if (!username) throw new AppError("NO_BOT_INFO", "Info bot belum ada. Jalankan /setup dulu.", 409);
  return ok(c, { link: `https://t.me/${username}?start=join_${inv.code}`, role: inv.role, expires_at: inv.expires_at }, 201);
});

api.patch("/users/:id", async (c) => {
  const b = await parseBody(c, UserPatchBody);
  if (Number(c.req.param("id")) === c.var.user.id) throw new AppError("SELF", "Tidak bisa mengubah akun sendiri.", 409);
  return ok(
    c,
    await updateUser(c.env.DB, Number(c.req.param("id")), { ...(b.role !== undefined ? { role: b.role } : {}), ...(b.is_active !== undefined ? { isActive: b.is_active } : {}) }, c.var.actor),
  );
});

apiRoutes.route("/", api);
