-- =====================================================================
-- Bot Laporan Keuangan Telegram — Skema D1 (SQLite) v1
-- Konvensi:
--   * Uang  : INTEGER rupiah (tanpa desimal). Rp 15.000 -> 15000
--   * Qty   : INTEGER (satuan terkecil, mis. pcs)
--   * Waktu : created_at/updated_at = TEXT ISO-8601 UTC
--             tanggal = TEXT 'YYYY-MM-DD' (zona Asia/Jakarta) -> dipakai laporan
--   * Data keuangan TIDAK dihapus, tapi di-void (status = 'void')
--   * `uid` = UUID dari klien/service, dipakai untuk (1) merujuk baris induk
--     di dalam DB.batch() tanpa perlu membaca id dulu, dan (2) idempotensi
--     (submit ganda dari Mini App/bot tidak membuat transaksi dobel).
--
-- Catatan untuk db/migrate.ts:
--   * Tabel `schema_version` dibuat oleh migrate.ts (CREATE TABLE IF NOT EXISTS),
--     bukan oleh file ini. migrate.ts juga yang menulis baris versinya, di batch
--     yang sama dengan isi migrasi.
--   * File dipecah per statement dengan pemisah ';' di akhir baris. Jangan pakai
--     ';' di dalam string literal atau trigger.
--   * D1 sudah menegakkan foreign key secara default; tidak perlu PRAGMA.
-- =====================================================================

-- ---------------------------------------------------------------------
-- Pengaturan (key-value)
-- ---------------------------------------------------------------------
CREATE TABLE settings (
  key    TEXT PRIMARY KEY,
  value  TEXT NOT NULL
);

-- ---------------------------------------------------------------------
-- Pengguna (multi-user dalam satu usaha)
-- ---------------------------------------------------------------------
CREATE TABLE users (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  telegram_id   INTEGER NOT NULL UNIQUE,
  username      TEXT,
  full_name     TEXT NOT NULL,
  role          TEXT NOT NULL DEFAULT 'staff'
                CHECK (role IN ('owner','admin','staff')),
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------
-- Akun kas (Tunai, BCA, Dana, dll)
-- ---------------------------------------------------------------------
CREATE TABLE accounts (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  name            TEXT NOT NULL UNIQUE,
  type            TEXT NOT NULL DEFAULT 'cash'
                  CHECK (type IN ('cash','bank','ewallet','marketplace')),
  opening_balance INTEGER NOT NULL DEFAULT 0,
  is_active       INTEGER NOT NULL DEFAULT 1,
  created_at      TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------
-- Kategori kas — kolom `kind` MENENTUKAN perlakuan di laporan laba rugi
--   sales          : kas masuk dari penjualan (dibuat otomatis oleh tabel sales)
--                    -> TIDAK dihitung lagi di laba rugi (sudah lewat sales)
--   other_income   : pendapatan lain (bunga, komisi affiliate, dll) -> masuk L/R
--   capital_in     : setoran modal / pinjaman masuk -> TIDAK masuk L/R
--   expense        : biaya operasional (iklan, ongkir, gaji, listrik) -> masuk L/R
--   stock_purchase : belanja barang dagangan -> TIDAK masuk L/R (sudah lewat HPP)
--   capital_out    : prive / bayar pokok pinjaman -> TIDAK masuk L/R
--   transfer       : pindah antar akun -> TIDAK masuk L/R
-- ---------------------------------------------------------------------
CREATE TABLE categories (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  name        TEXT NOT NULL,
  direction   TEXT NOT NULL CHECK (direction IN ('in','out')),
  kind        TEXT NOT NULL CHECK (kind IN (
                'sales','other_income','capital_in',
                'expense','stock_purchase','capital_out','transfer')),
  is_system   INTEGER NOT NULL DEFAULT 0,   -- kategori bawaan, tidak bisa dinonaktifkan
  is_active   INTEGER NOT NULL DEFAULT 1,
  UNIQUE (name, direction)
);

-- ---------------------------------------------------------------------
-- Produk (opsional dipakai; penjualan cepat tidak butuh produk)
-- ---------------------------------------------------------------------
CREATE TABLE products (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  sku           TEXT UNIQUE,
  name          TEXT NOT NULL,
  unit          TEXT NOT NULL DEFAULT 'pcs',
  cost_price    INTEGER NOT NULL DEFAULT 0,  -- HPP per unit saat ini
  sell_price    INTEGER NOT NULL DEFAULT 0,  -- harga jual default
  -- Kolom stok hanya dipakai bila settings.feature_stock = '1'.
  stock         INTEGER NOT NULL DEFAULT 0,  -- cache; sumber kebenaran = stock_movements
  min_stock     INTEGER NOT NULL DEFAULT 0,  -- untuk notifikasi stok menipis
  track_stock   INTEGER NOT NULL DEFAULT 1,  -- 0 = jasa / tanpa stok
  is_active     INTEGER NOT NULL DEFAULT 1,
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  updated_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_products_name ON products(name);

-- Riwayat perubahan HPP / harga jual (audit, bukan untuk hitung laporan)
CREATE TABLE product_price_history (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  cost_price  INTEGER NOT NULL,
  sell_price  INTEGER NOT NULL,
  reason      TEXT NOT NULL DEFAULT 'manual'
              CHECK (reason IN ('manual','purchase')),
  changed_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_price_history_product ON product_price_history(product_id, created_at);

-- ---------------------------------------------------------------------
-- Penjualan (header + item)
-- ---------------------------------------------------------------------
CREATE TABLE sales (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,           -- UUID; rujukan di batch & idempotensi
  invoice_no    TEXT NOT NULL UNIQUE,           -- INV-YYYYMMDD-NNNN, dibuat di SQL
  tanggal       TEXT NOT NULL,                  -- YYYY-MM-DD (WIB)
  channel       TEXT NOT NULL DEFAULT 'offline' -- offline/shopee/tiktok/wa/dll
                CHECK (length(channel) <= 30),
  customer_name TEXT,
  subtotal      INTEGER NOT NULL,               -- Σ item.line_total
  discount      INTEGER NOT NULL DEFAULT 0 CHECK (discount >= 0),
  total         INTEGER NOT NULL,               -- subtotal - discount  (= OMZET)
  total_cost    INTEGER NOT NULL,               -- Σ item.qty * item.cost_price (= HPP)
  account_id    INTEGER NOT NULL REFERENCES accounts(id), -- akun penerima uang
  source        TEXT NOT NULL DEFAULT 'miniapp'
                CHECK (source IN ('bot','miniapp')),
  status        TEXT NOT NULL DEFAULT 'posted'
                CHECK (status IN ('posted','void')),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_at     TEXT,
  voided_by     INTEGER REFERENCES users(id),
  void_reason   TEXT
);
CREATE INDEX idx_sales_tanggal ON sales(status, tanggal);
CREATE INDEX idx_sales_day     ON sales(tanggal);          -- penomoran invoice per hari

-- Item penjualan. product_id NULL = "penjualan cepat" (tanpa master produk):
-- nama, harga jual, dan HPP diisi manual oleh user.
CREATE TABLE sale_items (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  sale_id     INTEGER NOT NULL REFERENCES sales(id),
  product_id  INTEGER REFERENCES products(id),
  item_name   TEXT NOT NULL,      -- SNAPSHOT nama produk / teks bebas
  qty         INTEGER NOT NULL CHECK (qty > 0),
  sell_price  INTEGER NOT NULL CHECK (sell_price >= 0),  -- SNAPSHOT harga jual
  cost_price  INTEGER NOT NULL CHECK (cost_price >= 0),  -- SNAPSHOT HPP (WAJIB, boleh 0)
  line_total  INTEGER NOT NULL    -- qty * sell_price
);
CREATE INDEX idx_sale_items_sale    ON sale_items(sale_id);
CREATE INDEX idx_sale_items_product ON sale_items(product_id);

-- ---------------------------------------------------------------------
-- Transaksi kas (buku kas) — semua uang masuk/keluar
-- ---------------------------------------------------------------------
CREATE TABLE cash_transactions (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,          -- UUID; rujukan di batch & idempotensi
  tanggal       TEXT NOT NULL,                 -- YYYY-MM-DD (WIB)
  direction     TEXT NOT NULL CHECK (direction IN ('in','out')),
  amount        INTEGER NOT NULL CHECK (amount > 0),
  category_id   INTEGER NOT NULL REFERENCES categories(id),
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  description   TEXT,
  ref_type      TEXT NOT NULL DEFAULT 'manual'
                CHECK (ref_type IN ('sale','purchase','transfer','manual')),
  ref_id        INTEGER,                       -- id sales / purchases / baris pasangan transfer
  source        TEXT NOT NULL DEFAULT 'miniapp'
                CHECK (source IN ('bot','miniapp','system')),
  status        TEXT NOT NULL DEFAULT 'posted'
                CHECK (status IN ('posted','void')),
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_at     TEXT,
  voided_by     INTEGER REFERENCES users(id),
  void_reason   TEXT
);
CREATE INDEX idx_cash_tanggal  ON cash_transactions(status, tanggal);
CREATE INDEX idx_cash_category ON cash_transactions(category_id, tanggal);
CREATE INDEX idx_cash_account  ON cash_transactions(account_id, tanggal);
CREATE INDEX idx_cash_ref      ON cash_transactions(ref_type, ref_id);

-- ---------------------------------------------------------------------
-- Pembelian stok (restock) — hanya dipakai bila feature_stock = '1'
-- ---------------------------------------------------------------------
CREATE TABLE purchases (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  uid           TEXT NOT NULL UNIQUE,
  tanggal       TEXT NOT NULL,
  supplier      TEXT,
  total         INTEGER NOT NULL,
  account_id    INTEGER NOT NULL REFERENCES accounts(id),
  update_cost   TEXT NOT NULL DEFAULT 'average'
                CHECK (update_cost IN ('none','last','average')), -- cara update HPP
  status        TEXT NOT NULL DEFAULT 'posted' CHECK (status IN ('posted','void')),
  note          TEXT,
  created_by    INTEGER REFERENCES users(id),
  created_at    TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now')),
  voided_at     TEXT,
  voided_by     INTEGER REFERENCES users(id),
  void_reason   TEXT
);
CREATE INDEX idx_purchases_tanggal ON purchases(status, tanggal);

CREATE TABLE purchase_items (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id  INTEGER NOT NULL REFERENCES purchases(id),
  product_id   INTEGER NOT NULL REFERENCES products(id),
  qty          INTEGER NOT NULL CHECK (qty > 0),
  unit_cost    INTEGER NOT NULL CHECK (unit_cost >= 0),
  line_total   INTEGER NOT NULL
);
CREATE INDEX idx_purchase_items_purchase ON purchase_items(purchase_id);

-- ---------------------------------------------------------------------
-- Mutasi stok — sumber kebenaran stok (hanya ditulis bila feature_stock = '1')
-- ---------------------------------------------------------------------
CREATE TABLE stock_movements (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id  INTEGER NOT NULL REFERENCES products(id),
  tanggal     TEXT NOT NULL,
  type        TEXT NOT NULL CHECK (type IN (
                'sale','sale_void','purchase','purchase_void','adjustment','opening')),
  qty_change  INTEGER NOT NULL,     -- + masuk, - keluar
  ref_type    TEXT,
  ref_id      INTEGER,
  note        TEXT,
  created_by  INTEGER REFERENCES users(id),
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_stock_product ON stock_movements(product_id, tanggal);

-- ---------------------------------------------------------------------
-- Audit log & state percakapan bot
-- ---------------------------------------------------------------------
CREATE TABLE audit_log (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER REFERENCES users(id),
  action      TEXT NOT NULL,        -- 'sale.create','cash.void','product.update', ...
  entity      TEXT NOT NULL,
  entity_id   INTEGER,
  payload     TEXT,                 -- JSON ringkas (before/after)
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);
CREATE INDEX idx_audit_created ON audit_log(created_at);

-- State multi-step bot (mis. konfirmasi sebelum simpan). TTL dibersihkan via cron.
CREATE TABLE bot_sessions (
  telegram_id  INTEGER PRIMARY KEY,
  state        TEXT NOT NULL,       -- JSON
  expires_at   TEXT NOT NULL
);

-- Idempotensi webhook (Telegram bisa kirim ulang update yang sama)
CREATE TABLE processed_updates (
  update_id    INTEGER PRIMARY KEY,
  processed_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

-- ---------------------------------------------------------------------
-- Data awal
-- ---------------------------------------------------------------------
INSERT INTO accounts (name, type) VALUES ('Tunai', 'cash');

INSERT INTO categories (name, direction, kind, is_system) VALUES
  ('Penjualan',          'in',  'sales',          1),
  ('Pendapatan Lain',    'in',  'other_income',   1),
  ('Modal Masuk',        'in',  'capital_in',     1),
  ('Transfer Masuk',     'in',  'transfer',       1),
  ('Belanja Stok',       'out', 'stock_purchase', 1),
  ('Iklan',              'out', 'expense',        0),
  ('Ongkir',             'out', 'expense',        0),
  ('Packing',            'out', 'expense',        0),
  ('Gaji',               'out', 'expense',        0),
  ('Listrik & Internet', 'out', 'expense',        0),
  ('Biaya Admin',        'out', 'expense',        0),
  ('Operasional Lain',   'out', 'expense',        0),
  ('Prive / Ambil Modal','out', 'capital_out',    1),
  ('Transfer Keluar',    'out', 'transfer',       1);

INSERT INTO settings (key, value) VALUES
  ('business_name',          'Usaha Saya'),
  ('timezone',               'Asia/Jakarta'),
  ('currency',               'IDR'),
  ('feature_stock',          '0'),   -- modul stok: '0' mati (default), '1' aktif
  ('allow_negative_stock',   '1'),
  ('daily_report_enabled',   '1'),
  ('weekly_report_enabled',  '1'),   -- dikirim hari Senin
  ('monthly_report_enabled', '1'),   -- dikirim tanggal 1
  ('daily_report_hour_wib',  '21');
