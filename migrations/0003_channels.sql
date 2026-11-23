-- =====================================================================
-- v3: channel penjualan bisa dikelola (tambah/ubah/hapus)
-- sales.channel menyimpan `code` (tetap, tidak berubah walau nama diganti).
-- "Hapus" = is_active = 0, supaya penjualan lama tetap punya label.
-- =====================================================================

CREATE TABLE channels (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  code        TEXT NOT NULL UNIQUE CHECK (length(code) BETWEEN 1 AND 30),
  name        TEXT NOT NULL,
  is_system   INTEGER NOT NULL DEFAULT 0,   -- 'offline' = default, tidak bisa dihapus
  is_active   INTEGER NOT NULL DEFAULT 1,
  sort        INTEGER NOT NULL DEFAULT 100,
  created_at  TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ','now'))
);

INSERT INTO channels (code, name, is_system, sort) VALUES
  ('offline',    'Offline',     1, 0),
  ('shopee',     'Shopee',      0, 10),
  ('tokopedia',  'Tokopedia',   0, 20),
  ('tiktok',     'TikTok',      0, 30),
  ('lazada',     'Lazada',      0, 40),
  ('blibli',     'Blibli',      0, 50),
  ('whatsapp',   'WhatsApp',    0, 60),
  ('instagram',  'Instagram',   0, 70),
  ('facebook',   'Facebook',    0, 80),
  ('gofood',     'GoFood',      0, 90),
  ('grabfood',   'GrabFood',    0, 100),
  ('shopeefood', 'ShopeeFood',  0, 110),
  ('online',     'Online lain', 0, 120);

-- Channel lain yang sudah terlanjur dipakai penjualan lama ikut didaftarkan.
INSERT OR IGNORE INTO channels (code, name) SELECT DISTINCT channel, channel FROM sales;
