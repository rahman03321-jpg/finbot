# Arsitektur — Bot Laporan Keuangan Telegram + Mini App (Cloudflare)

> Dokumen ini adalah spesifikasi utama untuk Claude Code. Baca seluruhnya sebelum menulis kode.
> Skema database ada di `migrations/0001_init.sql`.

## 1. Tujuan & Prinsip

Bot Telegram dan Telegram Mini App untuk mencatat keuangan usaha kecil. Dipakai sendiri dan oleh teman yang membutuhkan (tidak dijual, tanpa lisensi).

**Kebutuhan inti**
1. Kas masuk & kas keluar (arus kas) per akun (Tunai, bank, e-wallet)
2. Penjualan → omzet & HPP → laba kotor
3. Biaya operasional per kategori → laba rugi
4. Laporan harian, mingguan, bulanan, dan periode bebas (lewat bot & Mini App, plus kiriman otomatis)

**Modul opsional**
- **Stok** (`settings.feature_stock`, default `0` = mati). Kalau mati, tidak ada stok, mutasi, restock, maupun notifikasi stok. Owner bisa mengaktifkannya kapan saja dari Pengaturan.

**Prinsip produk**
- **BYO (Bring Your Own) Cloudflare.** Tiap pengguna men-deploy ke akun Cloudflare dan bot Telegram miliknya sendiri. Kita tidak punya server.
- **1 deployment = 1 usaha (single-tenant).** Beberapa orang dalam usaha yang sama didukung lewat peran `owner/admin/staff`.
- **Harus muat di Cloudflare Free plan.** Kode ringan, agregasi di SQL, semua query laporan memakai index.
- **Data keuangan tidak pernah di-DELETE.** Koreksi dilakukan dengan **void** (`status='void'`) dan dicatat di `audit_log`.

## 2. Stack

| Lapisan | Teknologi |
|---|---|
| Runtime | Cloudflare Workers (TypeScript, ES modules) |
| Router HTTP | Hono |
| Bot | grammY (`webhookCallback(bot, "cloudflare-mod")`) |
| Database | Cloudflare D1 (SQLite) |
| Mini App | Preact + Vite (JSX lewat oxc), CSS biasa dengan variabel tema Telegram, `window.Telegram.WebApp` (±17 KB gzip) |
| Hosting Mini App | Workers Static Assets (satu Worker, satu domain `*.workers.dev`) |
| Jadwal | Cron Triggers (laporan terjadwal, bersih-bersih sesi) |
| Validasi | Zod (shared antara API & Mini App) |
| Tooling | Wrangler, Vitest + `@cloudflare/vitest-pool-workers` |

**Satu Worker saja** yang melayani webhook bot, REST API, halaman setup, dan file statis Mini App. Tidak perlu CORS, dan deploy cukup sekali.

## 3. Diagram Alur

```
                ┌──────────────────────── Akun Cloudflare milik user ───────────────────────┐
 Telegram       │  Worker: finbot                                                           │
 ┌────────┐     │  ┌──────────────────────┐   ┌────────────────────┐   ┌──────────────────┐ │
 │  Chat  │────▶│  │ POST /webhook/tg     │──▶│  services/*        │──▶│  D1: finbot-db   │ │
 │  Bot   │◀────│  │ (grammY handlers)    │   │  (logika bisnis)   │   └──────────────────┘ │
 └────────┘     │  └──────────────────────┘   │                    │            ▲           │
 ┌────────┐     │  ┌──────────────────────┐   │                    │            │           │
 │ Mini   │────▶│  │ /api/* (Hono)        │──▶│                    │────────────┘           │
 │ App    │◀────│  │ auth: initData HMAC  │   └────────────────────┘                        │
 └────────┘     │  └──────────────────────┘             ▲                                   │
     ▲          │  ┌──────────────────────┐   ┌─────────┴──────────┐                        │
     └──────────│──│ Static assets (/)    │   │ scheduled() cron   │── kirim laporan ke TG  │
                │  └──────────────────────┘   └────────────────────┘                        │
                │  GET/POST /setup  (dilindungi SETUP_KEY)                                  │
                └───────────────────────────────────────────────────────────────────────────┘
```

Bot handler dan API **memanggil service yang sama**. Logika bisnis tidak boleh diduplikasi di handler.

## 4. Struktur Folder

```
finbot/
├─ ARCHITECTURE.md
├─ CLAUDE.md
├─ wrangler.jsonc
├─ package.json               # workspace: worker + miniapp
├─ .dev.vars.example          # daftar secret yang diminta saat deploy
├─ .github/workflows/
│  └─ sync-upstream.yml       # tombol "ambil update" untuk repo pengguna (§6)
├─ migrations/
│  ├─ 0001_init.sql
│  ├─ 0002_user_invites.sql   # undangan user sekali pakai
│  └─ 0003_channels.sql       # channel penjualan yang bisa dikelola
├─ worker/
│  ├─ index.ts                # export default { fetch, scheduled }
│  ├─ env.ts                  # tipe Env (bindings & secrets)
│  ├─ routes/
│  │  ├─ webhook.ts           # POST /webhook/tg
│  │  ├─ setup.ts             # GET/POST /setup
│  │  └─ api/                 # cash.ts, sales.ts, products.ts, purchases.ts,
│  │                          # stock.ts, reports.ts, users.ts, settings.ts, meta.ts
│  ├─ bot/
│  │  ├─ bot.ts               # instance grammY + middleware auth user
│  │  ├─ commands/            # start, app, cash (masuk/keluar/transfer), accounts (saldo/akun), sales (omzet/jual), products, list
│  │  ├─ drafts.ts            # kerangka draf + Simpan/Batal/Batalkan, canSeeCost
│  │  ├─ parsers/amount.ts    # "50rb", "1,5jt", "250.000" -> number
│  │  └─ format.ts            # format rupiah & tabel teks
│  ├─ services/               # LOGIKA BISNIS — dipakai bot & API
│  │  ├─ cash.ts
│  │  ├─ sales.ts
│  │  ├─ products.ts
│  │  ├─ purchases.ts         # modul stok
│  │  ├─ stock.ts             # modul stok
│  │  ├─ reports.ts
│  │  ├─ masters.ts           # kategori, akun kas, channel (tambah/ubah/hapus = nonaktif)
│  │  ├─ pdfReport.ts         # laporan PDF A4 (pakai lib/pdf.ts, tanpa dependensi)
│  │  ├─ features.ts          # baca flag (feature_stock, dst.)
│  │  └─ audit.ts
│  ├─ db/
│  │  ├─ migrate.ts           # migrasi idempoten (dipanggil dari /setup & test)
│  │  └─ queries/             # SQL laporan
│  ├─ auth/
│  │  ├─ initData.ts          # validasi HMAC Telegram WebApp
│  │  ├─ session.ts           # token sesi (HMAC, tanpa tabel)
│  │  └─ redact.ts            # buang field HPP/laba untuk staff (satu-satunya tempat)
│  └─ lib/                    # date (WIB + periode laporan), errors, crypto (uid, safeEqual), csv
├─ shared/
│  └─ schemas.ts              # Zod schema + tipe, dipakai worker & miniapp
└─ miniapp/
   ├─ index.html
   └─ src/
      ├─ main.tsx, App.tsx
      ├─ api.ts               # fetch wrapper + header Authorization
      ├─ tg.ts, format.ts, ui.tsx  # pembungkus Telegram, format rupiah/tanggal, komponen & hook bersama
      ├─ pages/               # Home, Cash, Sales, Products, Reports (Stok & Pengaturan menyusul)
      └─ components/
```

## 5. Konfigurasi Cloudflare

### `wrangler.jsonc` (garis besar)
```jsonc
{
  "name": "finbot",
  "main": "worker/index.ts",
  "compatibility_date": "2026-11-01",
  "compatibility_flags": ["nodejs_compat"],
  "assets": { "directory": "miniapp/dist", "binding": "ASSETS", "not_found_handling": "single-page-application", "run_worker_first": ["/api/*", "/webhook/*", "/setup*"] },
  "d1_databases": [{ "binding": "DB", "database_name": "finbot-db" }],
  "rules": [{ "type": "Text", "globs": ["**/*.sql"], "fallthrough": true }],  // migrasi di-import sebagai teks
  "triggers": { "crons": ["0 * * * *"] },   // tiap jam; logika cek jam WIB di kode
  "vars": { "APP_VERSION": "1.0.0" }
}
```

> **Migrasi hanya lewat `db/migrate.ts`.** Sengaja tidak memakai `migrations_dir` / `wrangler d1 migrations apply`, supaya pengguna awam cukup membuka `/setup` dan tidak ada dua sistem pencatat versi yang bisa berbeda. Dev lokal dan test juga memanggil `migrate.ts`.

### Secrets (diisi user saat deploy)
| Nama | Fungsi |
|---|---|
| `BOT_TOKEN` | Token dari @BotFather |
| `SETUP_KEY` | Password halaman `/setup` (user tentukan sendiri) |
| `WEBHOOK_SECRET` | (opsional) Dibuat otomatis oleh `/setup`, dicek di header `X-Telegram-Bot-Api-Secret-Token` |
| `SESSION_SECRET` | (opsional) Kunci HMAC token sesi Mini App, dibuat otomatis jika kosong |

> Worker tidak bisa menulis secret-nya sendiri, jadi `WEBHOOK_SECRET` dan `SESSION_SECRET` yang dibuat otomatis disimpan di tabel `settings`. Kalau secret env tersedia, nilai env yang dipakai. Nilai rahasia di `settings` **tidak pernah** dikirim ke API mana pun.

### Batas Free plan yang perlu dijaga
- D1: 5 juta row read/hari, 100 ribu row write/hari, 500 MB per database. Error muncul kalau limit lewat; reset 00:00 UTC (07:00 WIB).
- Workers: kuota request harian dan **CPU time per request sangat kecil** (±10 ms). Jangan menghitung laporan di JS dengan loop besar; agregasi di SQL.
- Laporan wajib memakai index `(status, tanggal)`. Jangan `SELECT *` tanpa `WHERE tanggal BETWEEN`.

## 6. Alur Setup & Update (oleh pengguna)

### Setup pertama (target < 15 menit)
1. Buat bot di @BotFather dan salin token.
2. Klik **Deploy to Cloudflare** dari README repo. Cloudflare membuat salinan repo di akun GitHub pengguna, membuat D1, lalu meminta `BOT_TOKEN` dan `SETUP_KEY` (dari `.dev.vars.example`).
3. Buka `https://<worker>.workers.dev/setup`, masukkan `SETUP_KEY`. Server menjalankan langkah idempoten:
   1. `db/migrate.ts` (lihat §6.3).
   2. Buat `WEBHOOK_SECRET` & `SESSION_SECRET` jika belum ada.
   3. `setWebhook` → `https://<host>/webhook/tg`, `secret_token`, `allowed_updates: ["message","callback_query"]`, `drop_pending_updates: true`.
   4. `setChatMenuButton` → tipe `web_app`, URL `https://<host>/`.
   5. `setMyCommands`. Daftar perintah mengikuti flag fitur (mis. `/stok` hanya muncul bila `feature_stock=1`). Dipanggil ulang setiap flag berubah.
   6. Buat `owner_claim_code` acak dan tampilkan tautan `https://t.me/<bot>?start=claim_<code>`.
4. User klik tautan klaim → `/start claim_<code>` → akun Telegram-nya menjadi **owner**, lalu kode dihapus.
5. Halaman setup menampilkan status: webhook OK, DB versi N, owner sudah terklaim.

### Update versi
Repo hasil tombol Deploy adalah **repo baru, bukan fork**, jadi tidak ada tombol "Sync fork". Solusinya:
1. Repo menyertakan `.github/workflows/sync-upstream.yml` (`workflow_dispatch`, judul **"Ambil update Catetin"**). Workflow ini **tidak me-merge** (riwayat repo pengguna tidak berhubungan dengan repo asal); ia menimpa file dengan isi `main` repo asal (`judienmz/Catetin`), menghapus file yang sudah dihapus di folder terkelola (`worker miniapp migrations shared test`), lalu commit & push.
2. **`wrangler.jsonc` milik pengguna tidak pernah ditimpa**, karena Cloudflare menulis ID database D1 ke file itu saat deploy pertama; menimpanya bisa membuat database baru yang kosong. Bila `wrangler.jsonc` resmi berubah, workflow menulis peringatan di ringkasan run supaya pengguna menyalin perubahan secara manual. Konsekuensinya: **binding atau pengaturan baru di `wrangler.jsonc` harus dihindari**, dan kalau terpaksa, diumumkan di README.
3. Push itu memicu Workers Builds untuk redeploy otomatis.
4. Pengguna membuka `/setup` lagi; migrasi baru akan jalan.

**Fakta tombol Deploy (dicek dari dokumentasi Cloudflare, Fase 7):**
- Repo wajib publik.
- Cloudflare menyalin repo menjadi **repo baru** di akun GitHub pengguna (bukan fork).
- Resource D1 dibuat otomatis, dan ID-nya ditulis ke config.
- Secret diminta dari `.dev.vars.example`, dengan teks bantuan dari `package.json → cloudflare.bindings.<NAMA>.description`.
- Script `build` & `deploy` di `package.json` dipakai sebagai perintah build/deploy.
- Migrasi D1 tidak dijalankan otomatis; ditangani `/setup`.

### 6.3 `db/migrate.ts`
- `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER PRIMARY KEY, applied_at TEXT NOT NULL)`.
- Daftar migrasi di-import statis: `import m0001 from "../../migrations/0001_init.sql"`. Setiap file baru wajib ditambahkan ke daftar ini.
- Untuk tiap versi yang belum ada di `schema_version`: pecah file per statement (`;` di akhir baris, abaikan komentar `--`), jalankan **semuanya + `INSERT INTO schema_version` dalam satu `DB.batch()`**, sehingga satu migrasi berhasil penuh atau tidak sama sekali.
- Jangan pakai `DB.exec()` untuk migrasi (tidak atomik).

## 7. Autentikasi & Otorisasi

### Bot
- Cek header `X-Telegram-Bot-Api-Secret-Token === WEBHOOK_SECRET`; kalau salah → 401.
- Middleware: ambil `ctx.from.id`, cari di `users` yang `is_active=1`. Kalau tidak ada, balas "Kamu belum terdaftar, minta owner menambahkan kamu", kecuali untuk `/start claim_...`.
- **Idempotensi:** `INSERT OR IGNORE INTO processed_updates(update_id)`; kalau baris tidak bertambah, update dilewati. Cron membersihkan baris lebih dari 3 hari.

### Mini App
1. Frontend mengirim `Telegram.WebApp.initData` (string mentah) ke `POST /api/auth`.
2. Server memvalidasi sesuai dokumentasi Telegram:
   - `secret_key = HMAC_SHA256(key="WebAppData", msg=BOT_TOKEN)`
   - `hash == hex(HMAC_SHA256(key=secret_key, msg=data_check_string))`, dengan `data_check_string` = semua field kecuali `hash`, diurutkan, digabung `key=value\n`.
   - Tolak jika `auth_date` lebih dari 24 jam yang lalu.
   - Gunakan Web Crypto (`crypto.subtle`), bukan library Node. Bandingkan hash dengan perbandingan waktu-konstan.
3. Cocokkan `user.id` dengan tabel `users`, lalu kembalikan token sesi `base64url(payload).hmac` (payload: `uid`, `role`, `exp` 12 jam).
4. Semua `/api/*` lain memakai header `Authorization: Bearer <token>`. Peran dibaca ulang dari DB per request (agar user yang dinonaktifkan langsung terkunci).

### Matriks peran
| Aksi | owner | admin | staff |
|---|:-:|:-:|:-:|
| Input kas, penjualan | ✓ | ✓ | ✓ |
| Void transaksi | ✓ | ✓ | hanya miliknya, < 24 jam |
| Kelola produk (HPP/harga) | ✓ | ✓ | – |
| Lihat HPP, laba, laporan | ✓ | ✓ | – |
| Restock / penyesuaian stok *(modul stok)* | ✓ | ✓ | – |
| Kelola user, pengaturan, flag fitur | ✓ | – | – |

> **Staff tidak boleh melihat HPP maupun laba.** Semua respons API untuk staff melewati `auth/redact.ts`, yang membuang `cost_price`, `total_cost`, `hpp`, `laba*`, dan `margin*` di mana pun field itu muncul (produk, penjualan, detail item, dashboard). Jangan menyaring field ini di route satu per satu. Di bot, `/laporan` hanya untuk admin+, dan HPP/laba hanya ditampilkan bila `canSeeCost(ctx)` (`bot/drafts.ts`): pengguna owner/admin **dan** chat pribadi. Di grup, HPP/laba tidak pernah ditampilkan, walau yang mengetik owner, karena semua anggota grup ikut membaca.

## 8. Perintah Bot

| Perintah | Contoh | Hasil |
|---|---|---|
| `/start` | – | Sapaan + tombol buka Mini App |
| `/masuk <nominal> [kategori] [catatan]` | `/masuk 500rb modal awal` | Kas masuk (default kategori Pendapatan Lain) |
| `/keluar <nominal> [kategori] [catatan]` | `/keluar 75rb ongkir jne` | Kas keluar (kategori dicocokkan fuzzy, kalau ragu tampilkan tombol pilihan) |
| `/transfer <nominal> <dari> <ke> [catatan]` | `/transfer 1jt tunai bca setor` | Pindah dana antar akun (admin+) |
| `/saldo` | – | Saldo per akun kas + total (admin+) |
| `/akun` · `/akun tambah <nama> [tipe] [saldo awal]` | `/akun tambah BCA bank 2jt` | Daftar akun (admin+) · tambah akun (owner) |
| `/omzet <nominal> [hpp <nominal>] [channel] [catatan]` | `/omzet 1,5jt hpp 900rb shopee` | **Penjualan cepat** tanpa master produk (§9.1) |
| `/jual <produk> [qty] [harga] [channel] [catatan]` | `/jual salep 3` · `/jual salep 2 18rb wa` | Penjualan 1 item dari master produk (qty default 1) |
| `/produk` · `/produk tambah <nama> hpp <x> jual <y>` · `/produk ubah <nama> [hpp <x>] [jual <y>]` | `/produk tambah Salep hpp 12rb jual 20rb` | Daftar (semua; HPP hanya admin+ di chat pribadi) · tambah/ubah (admin+) |
| `/laporan [periode]` | `/laporan bulan` · `/laporan minggu lalu` · `/laporan 1/11 15/11` | Omzet, HPP, laba kotor, biaya per kategori, laba bersih, kas per akun, 5 item terlaris, rincian per hari (≤ 14 hari). Admin+. Di grup tanpa HPP/laba |
| `/export [periode] [csv]` | `/export bulan lalu` · `/export bulan csv` | 1 file **PDF** laporan keuangan (ringkasan, laba rugi, arus kas, per item, harian, daftar penjualan & kas); tambah `csv` untuk 3 file spreadsheet. Default bulan ini. Admin+, chat pribadi saja |
| `/jadwal` · `/jadwal grup` · `/jadwal pribadi` | `/jadwal grup` (di grup) | Lihat jadwal laporan otomatis & pilih tujuannya (owner) |
| `/user` · `/user undang [staff\|admin]` · `/user tambah [staff\|admin]` (reply) · `/user ubah\|nonaktif\|aktif <nama\|@username>` | `/user undang staff` | Kelola anggota (owner). Undangan = tautan `t.me/<bot>?start=join_<kode>`, sekali pakai, 24 jam, hanya dibuat di chat pribadi |
| `/stok [nama]` | `/stok salep` | *(modul stok)* Stok per produk + tanda menipis/habis (semua peran) |
| `/restock <produk> <qty> <harga beli satuan> [supplier]` | `/restock salep 10 12rb toko abc` | *(modul stok, admin+)* Draf → Simpan; HPP rata-rata, kas keluar Belanja Stok; tombol Batalkan = void pembelian |
| `/app` | – | Tombol inline `web_app` |

**Aturan input bot**
- Parser nominal (`bot/parsers/amount.ts`): `250000`, `250k`, `250K`, `50rb`, `50 rb`, `50rbu`, `50ribu`, `50 rebu`, `1jt`, `2 juta`, `1,5jt`, `1.5jt`, `250.000`, `1,250,000`, `Rp 250.000`, `IDR 250000`, `250.000,-`, `250.000,00`. Desimal hanya boleh bersama satuan (`1,5` saja ditolak); hasil selalu integer rupiah.
- Pencocokan kategori/akun (`bot/parsers/match.ts`): nama persis, atau awalan ≥ 3 huruf dari salah satu kata nama (`ong` → Ongkir, `listrik` → Listrik & Internet). Kategori `sales` dan `transfer` tidak bisa dipilih manual.
- Setiap input lewat bot menampilkan **ringkasan + tombol [Simpan] [Batal]** (state di `bot_sessions`, TTL 10 menit, termasuk `uid` yang sudah dibuat sehingga klik Simpan dua kali tidak menghasilkan dua transaksi). Setelah tersimpan, bot menampilkan tombol **[Batalkan]** yang menjalankan void.
- Akun kas default = akun pertama yang aktif; bisa diganti lewat tombol.
- `/omzet` tanpa `hpp` → HPP = 0, dan ringkasan memberi peringatan "laba kotor = omzet karena HPP kosong". Item penjualan cepat disimpan dengan nama `Penjualan cepat`.
- Channel dikenali dari kata mana pun di belakang (`shopee`, `tokopedia`/`tokped`, `tiktok`, `lazada`, `blibli`, `wa`, `ig`, `fb`, `gofood`, `grabfood`, `shopeefood`, `online`, `offline`/`toko`); default `offline`. Kata selain itu jadi catatan.
- Draf kas keluar & transfer menampilkan **peringatan bila saldo akun akan minus** (tetap boleh disimpan). Draf penjualan memperingatkan stok yang akan minus (modul stok).

**Bot di grup**
- Bot boleh dimasukkan ke grup. Dengan privacy mode bawaan BotFather, bot hanya menerima perintah, bukan obrolan biasa.
- Perintah `/x` dan `/x@nama_bot` dilayani; `/x@bot_lain` diabaikan.
- Draf disimpan per user Telegram, jadi tombol Simpan/Batal hanya berlaku untuk pembuat draf. Anggota lain yang menekan mendapat alert "bukan milikmu".
- Anggota yang belum terdaftar dibalas "belum terdaftar" hanya bila mengirim perintah ke bot ini.
- HPP/laba tidak pernah tampil di grup (§7). Laporan terjadwal bisa dikirim ke grup lewat `daily_report_chat_id` (§13).
- `/start` (klaim owner) dan `/app` (tombol Mini App) hanya berfungsi di chat pribadi.

## 9. Aturan Bisnis (WAJIB)

### 9.0 Pola penulisan atomik di D1
`DB.batch()` berjalan dalam satu transaksi, tetapi statement di dalamnya **tidak bisa membaca hasil statement sebelumnya dari JS**. Aturannya:
1. Service membuat `uid` (UUID, `newUid()` di `lib/crypto.ts`) untuk setiap baris induk (`sales`, `purchases`, `cash_transactions`) **sebelum** menyusun batch. Klien (Mini App) boleh mengirim `uid` sendiri sebagai kunci idempotensi.
2. Baris anak merujuk induknya dengan subquery: `sale_id = (SELECT id FROM sales WHERE uid = ?1)`. Jangan mengandalkan `last_insert_rowid()` lintas beberapa insert.
3. Nilai yang bergantung pada data DB (nomor invoice, HPP produk saat ini, stok) dihitung **di dalam SQL** (`INSERT ... SELECT`, `UPDATE ... SET x = x - ?`), bukan dibaca dulu ke JS lalu ditulis.
4. Statement terakhir batch adalah `SELECT` baris induk untuk dikembalikan ke pemanggil.
5. Kalau insert induk gagal karena `uid` sudah ada → kembalikan transaksi yang sudah tersimpan (idempoten), bukan error.

### 9.1 Penjualan (`services/sales.ts → createSale`)
Dua mode item, boleh dicampur dalam satu penjualan:
- **Item produk** (`product_id` diisi): `item_name`, `cost_price` di-snapshot dari `products` di dalam SQL; `sell_price` default dari produk, boleh diubah.
- **Item cepat** (`product_id` NULL): `item_name`, `sell_price`, `cost_price` (boleh 0) diisi user. `/omzet` = 1 item cepat dengan `qty=1`.

Dalam **satu `DB.batch([...])`**:
1. Insert `sales` dengan `invoice_no` dihitung di SQL:
   ```sql
   INSERT INTO sales (uid, invoice_no, tanggal, subtotal, discount, total, total_cost, account_id, ...)
   SELECT ?1, 'INV-' || ?2 || '-' || printf('%04d', COALESCE(MAX(CAST(substr(invoice_no, 14) AS INTEGER)), 0) + 1),
          ?3, 0, ?4, 0, 0, ?5, ...
   FROM sales WHERE tanggal = ?3;
   ```
   (`?2` = tanggal tanpa tanda `-`, mis. `20261115`.)
2. Insert `sale_items` (snapshot harga & HPP).
3. `UPDATE sales SET subtotal = (Σ line_total), total = (Σ line_total) − discount, total_cost = (Σ qty*cost_price) WHERE uid = ?`, dengan setiap Σ berupa subquery ke `sale_items`. (Di SQLite, `SET total = subtotal − discount` memakai nilai `subtotal` **lama**, jadi tulis subquery-nya lagi.) Tolak di service bila `discount > subtotal`; untuk item produk, service menghitung perkiraan subtotal dari harga produk sebelum menyusun batch.
4. **Hanya jika `feature_stock=1`** dan produk `track_stock=1`: insert `stock_movements(type='sale', qty_change=-qty)` dan `UPDATE products SET stock = stock - qty`.
5. Insert `cash_transactions(direction='in', kategori Penjualan [kind=sales], amount=total, ref_type='sale', ref_id=(SELECT id ...), source='system')`. Lewati bila `total = 0`.
6. Insert `audit_log`.
7. `SELECT` penjualan yang baru dibuat.

Stok boleh minus bila `allow_negative_stock=1` (default), dengan peringatan di respons.

### 9.2 Void penjualan
Set `sales.status='void'` (+ `voided_at/by`, `void_reason`), void `cash_transactions` terkait, dan bila ada `stock_movements(type='sale')` untuk penjualan itu: insert `stock_movements(type='sale_void', +qty)` dan kembalikan `products.stock`. Semua dalam satu batch. Pengembalian stok mengikuti mutasi yang benar-benar tercatat, bukan flag fitur saat ini.

### 9.3 Kas manual
- `kind='sales'` **tidak boleh** dipilih manual (hanya dibuat sistem).
- `kind='stock_purchase'` boleh dipilih manual (belanja barang dagangan tanpa modul stok); tidak masuk laba rugi.
- **Transfer antar akun** = 2 baris dalam satu batch, keduanya `ref_type='transfer'`:
  1. Insert baris `out` (kategori Transfer Keluar).
  2. Insert baris `in` (kategori Transfer Masuk) dengan `ref_id` = id baris `out`.
  3. `UPDATE` baris `out` SET `ref_id` = id baris `in`.
  Void salah satu = void keduanya.

### 9.4 Modul stok (`feature_stock=1`)
**Mengaktifkan** modul stok (owner, ⚙ Pengaturan → Usaha → Modul stok; menu perintah bot ikut diperbarui): isi stok per produk lewat **Stok opname** (`services/stock.ts → setStockCount`): jumlah fisik di-set langsung, selisihnya dihitung di SQL dan dicatat sebagai mutasi `opening` (bila produk belum punya mutasi) atau `adjustment`. Produk baru dengan `opening_stock` juga mencatat `opening`. Produk `track_stock = 0` (jasa) tidak bisa di-opname.

**Menonaktifkan**: data lama tetap tersimpan; halaman Stok, `/stok`, restock, dan notifikasi disembunyikan; penjualan berhenti menulis mutasi stok.

Saat modul mati, endpoint stok/pembelian membalas `AppError('FEATURE_DISABLED', 'Fitur stok belum diaktifkan', 403)`.

**Pembelian / restock** (satu batch):
1. Insert `purchases` + `purchase_items`.
2. `stock_movements(type='purchase', +qty)` dan update stok.
3. Update HPP sesuai `update_cost`, dihitung di SQL **sebelum** stok bertambah:
   - `average`: `new_cost = round((stock_lama*cost_lama + qty*unit_cost) / (stock_lama+qty))` (kalau stok lama ≤ 0 → pakai `unit_cost`)
   - `last`: `new_cost = unit_cost`
   - `none`: tidak berubah
4. Catat ke `product_price_history(reason='purchase')` jika HPP berubah.
5. `cash_transactions(direction='out', kategori Belanja Stok [kind=stock_purchase], ref_type='purchase')`.

**Void pembelian**: set `purchases.status='void'`, void kas terkait, insert `stock_movements(type='purchase_void', −qty)`, kurangi stok. **HPP tidak dihitung ulang otomatis** (HPP rata-rata tidak bisa dibalik dengan pasti setelah ada penjualan); respons memberi peringatan agar admin memeriksa HPP produk terkait dan mengubahnya manual bila perlu.

**Penyesuaian stok** (= stok opname): `stock_movements(type='adjustment', qty_change, note)` + update stok. Tidak menyentuh kas maupun laba rugi.

**Implementasi pembelian** (`services/purchases.ts`): baris dengan produk yang sama digabung dulu (HPP dihitung sekali per produk). Statement HPP per mode dibuat terpisah karena D1 menuntut jumlah nilai bind = jumlah parameter SQL. Produk tanpa lacak stok tidak mendapat mutasi, tetapi HPP-nya tetap diperbarui dari harga beli.

**Peringatan stok menipis**: cron pada jam laporan, maks 1x/hari (klaim `last_lowstock_report_date`), ke chat pribadi owner: produk aktif & dilacak dengan `stock <= min_stock`.

### 9.5 Perubahan HPP / harga manual
Update `products`, insert `product_price_history(reason='manual')`. **Transaksi lama tidak ikut berubah** karena laporan memakai snapshot di `sale_items`.

## 10. Laporan

Semua laporan menerima `from` & `to` (`YYYY-MM-DD`, WIB) dan hanya menghitung `status='posted'`.

**Periode siap pakai** (dihitung di `lib/date.ts`, zona Asia/Jakarta):
| Kode | Rentang |
|---|---|
| `hari` | hari ini |
| `kemarin` | kemarin |
| `minggu` | Senin–hari ini minggu ini |
| `minggulalu` | Senin–Minggu minggu lalu |
| `bulan` | tanggal 1–hari ini |
| `bulanlalu` | sebulan penuh bulan lalu |
| `custom` | `from`–`to` bebas (maks 366 hari) |

### 10.1 Laba Rugi
```
Omzet (Penjualan bersih) = Σ sales.total
HPP                      = Σ sales.total_cost
Laba Kotor               = Omzet − HPP
Pendapatan Lain          = Σ cash in  WHERE kind='other_income'
Biaya Operasional        = Σ cash out WHERE kind='expense'   (rinci per kategori)
Laba Bersih              = Laba Kotor + Pendapatan Lain − Biaya Operasional
Margin Kotor %           = Laba Kotor / Omzet   (0 bila omzet 0; dihitung di tampilan)
```
Kategori `sales`, `stock_purchase`, `capital_in`, `capital_out`, dan `transfer` **tidak** masuk laba rugi.

> Catatan untuk pengguna (tampilkan di halaman Laporan): laba rugi memakai HPP yang diisi di penjualan. Kalau HPP tidak diisi, laba akan terlihat lebih besar dari sebenarnya. "Belanja Stok" tercatat di arus kas, bukan di laba rugi.

```sql
-- Penjualan
SELECT COALESCE(SUM(total),0) AS omzet, COALESCE(SUM(total_cost),0) AS hpp,
       COALESCE(SUM(discount),0) AS diskon, COUNT(*) AS jml_transaksi
FROM sales WHERE status='posted' AND tanggal BETWEEN ?1 AND ?2;

-- Kas per kategori (untuk biaya & pendapatan lain)
SELECT c.kind, c.name, t.direction, SUM(t.amount) AS total
FROM cash_transactions t JOIN categories c ON c.id=t.category_id
WHERE t.status='posted' AND t.tanggal BETWEEN ?1 AND ?2
GROUP BY c.id ORDER BY total DESC;
```

### 10.2 Arus Kas
```
Saldo awal per akun  = opening_balance + Σ(in) − Σ(out) sebelum `from`
Masuk / Keluar       = per kategori dalam periode
Saldo akhir          = saldo awal + masuk − keluar
```

### 10.3 Ringkasan per hari (tren)
Omzet, HPP, biaya, dan laba bersih per tanggal dalam periode (untuk grafik & laporan mingguan/bulanan):
```sql
SELECT tanggal, SUM(total) AS omzet, SUM(total_cost) AS hpp
FROM sales WHERE status='posted' AND tanggal BETWEEN ?1 AND ?2
GROUP BY tanggal ORDER BY tanggal;
-- digabung dengan biaya per tanggal dari cash_transactions (kind='expense')
```

### 10.4 Penjualan per item
Bekerja dengan atau tanpa master produk (item cepat dikelompokkan per `item_name`):
```sql
SELECT COALESCE(CAST(i.product_id AS TEXT), 'q:' || i.item_name) AS item_key,
       MAX(i.item_name) AS name, SUM(i.qty) AS qty, SUM(i.line_total) AS omzet,
       SUM(i.qty*i.cost_price) AS hpp, SUM(i.line_total - i.qty*i.cost_price) AS laba_kotor
FROM sale_items i JOIN sales s ON s.id=i.sale_id
WHERE s.status='posted' AND s.tanggal BETWEEN ?1 AND ?2
GROUP BY item_key ORDER BY omzet DESC;
```
Catatan: diskon ada di level `sales`, jadi `omzet` per item = sebelum diskon. Tampilkan total diskon terpisah.

### 10.5 Dashboard (Mini App)
Kartu ringkasan hari ini dan bulan ini (dibanding bulan lalu): omzet, laba bersih, biaya, saldo kas total, jumlah transaksi. Grafik omzet & laba harian 30 hari terakhir, top 5 item. Bila modul stok aktif: daftar stok menipis (`stock <= min_stock`).

## 11. REST API

Semua respons berbentuk JSON `{ ok: true, data }` atau `{ ok: false, error: { code, message } }`. Uang selalu integer. Respons untuk staff selalu melewati `redact.ts`.

| Method | Path | Peran | Keterangan |
|---|---|---|---|
| POST | `/api/auth` | – | body `{ initData }` → `{ token, user }` |
| GET | `/api/meta` | semua | akun, kategori, flag fitur, settings publik, versi |
| GET/POST | `/api/cash` | semua | `?from&to&direction&category_id&account_id&page`; POST body boleh membawa `uid` |
| POST | `/api/cash/:id/void` | lihat matriks | `{ reason }` |
| POST | `/api/cash/transfer` | admin+ | antar akun |
| GET/POST | `/api/sales` | semua | POST: `{ uid?, tanggal, channel, items:[{product_id?, item_name?, qty, sell_price?, cost_price?}], discount, account_id }` |
| GET | `/api/sales/:id` | semua | detail + item |
| POST | `/api/sales/:id/void` | lihat matriks | `{ reason }` |
| GET | `/api/products` | semua | `?q=&active=` |
| POST | `/api/products` | admin+ | |
| PATCH | `/api/products/:id` | admin+ | ubah HPP/harga → history |
| DELETE | `/api/products/:id` | admin+ | nonaktifkan produk (penjualan lama tetap); juga `/produk hapus <nama>` di bot |
| GET | `/api/cash/summary` | semua | `?from&to`: kas masuk/keluar per akun (tanpa transfer) + saldo per akun di akhir periode (saldo tidak dikirim ke staff) |
| GET · GET :id · POST | `/api/purchases[/:id]` | admin+ | *(modul stok)* restock: `{ uid?, tanggal, supplier?, items:[{product_id, qty, unit_cost}], account_id, update_cost: average\|last\|none, note? }` → termasuk `hppChanges` |
| POST | `/api/purchases/:id/void` | admin+ | *(modul stok)* stok & kas dibalik; HPP tidak dihitung ulang (ada `warnings`) |
| POST | `/api/products/:id/stock` | admin+ | *(modul stok)* stok opname `{ actual, note?, tanggal? }` → `{ product, change }` |
| GET | `/api/products/:id/movements` | admin+ | *(modul stok)* 100 mutasi terakhir |
| GET | `/api/stock/low` | semua | *(modul stok)* produk dengan `stock <= min_stock` |
| GET | `/api/reports/summary` | semua | dashboard; staff hanya menerima omzet, jumlah transaksi, grafik omzet, item terlaris |
| GET | `/api/reports/profit-loss` | admin+ | `?period=` atau `?from&to` |
| GET | `/api/reports/cashflow` | admin+ | `?period=` atau `?from&to` |
| GET | `/api/reports/daily` | admin+ | tren per hari |
| GET | `/api/reports/items` | admin+ | penjualan per item |
| POST | `/api/reports/export` | admin+ | `?period=` atau `?from&to`; bot mengirim 3 file CSV ke chat pribadi user (unduhan langsung di webview Telegram tidak andal) |
| GET · PATCH | `/api/users[/:id]` | owner | daftar user; PATCH `{ role?: admin\|staff, is_active? }` (owner & diri sendiri tidak bisa diubah) |
| POST | `/api/users/invite` | owner | `{ role }` → `{ link: t.me/<bot>?start=join_<kode>, expires_at }` (sekali pakai, 24 jam) |
| POST · PATCH · DELETE | `/api/categories[/:id]` | admin+ | `{ name, direction, kind }`; DELETE = nonaktif; kategori bawaan tidak bisa dihapus/diganti jenis; Penjualan & Transfer tidak bisa diubah |
| POST · PATCH · DELETE | `/api/accounts[/:id]` | owner | `{ name, type, opening_balance }`; DELETE = nonaktif, hanya bila saldo 0 dan bukan akun aktif terakhir |
| GET · POST · PATCH · DELETE | `/api/channels[/:id]` | GET semua, ubah admin+ | `{ name }`; `code` dibuat otomatis & tetap (disimpan di `sales.channel`); Offline tidak bisa dihapus |
| GET · PATCH | `/api/settings` | GET admin+, PATCH owner | `{ business_name, daily/weekly/monthly_report_enabled, report_hour, report_target: "owner" }` (grup dipilih lewat `/jadwal grup`). *(Fase 6:)* flag `feature_stock` |

Paginasi: `?page=1&limit=50` (maks 100). Validasi semua body dengan Zod dari `shared/schemas.ts`.

## 12. Mini App — Halaman

| Halaman | Isi |
|---|---|
| **Dashboard** | Kartu ringkasan, grafik 30 hari, top item, stok menipis *(modul stok)* |
| **Kas** | List transaksi (filter tanggal/kategori/akun), tombol tambah masuk/keluar, transfer |
| **Penjualan** | Mode cepat (nominal + HPP opsional) dan mode keranjang (cari produk, qty, harga bisa diubah, diskon); riwayat, detail, void |
| **Produk** | List, tambah/edit (HPP, harga jual, margin otomatis), riwayat harga |
| **Stok** *(modul stok)* | Di tab Produk (pilihan Produk/Stok): daftar stok urut paling kritis, detail produk (stok opname, mutasi), Restock (multi-item, pilihan update HPP, perkiraan HPP & stok baru), Riwayat restock + batalkan. Form produk: lacak stok, stok minimum, satuan, stok awal |
| **Laporan** | Tab Laba Rugi / Arus Kas / Harian / Per Item, pemilih periode (§10), ekspor CSV |
| **Pengaturan** (ikon ⚙ di Beranda, admin+) | Owner: nama usaha, laporan otomatis (harian/mingguan/bulanan, jam, tujuan), user (undang lewat tautan + bagikan, ubah peran, nonaktifkan). Admin+: kategori kas (masuk/keluar + jenis), channel penjualan. Owner: akun kas/rekening (saldo awal). *(Fase 6:)* modul stok |

Menu yang terkait modul stok disembunyikan bila `feature_stock=0` (dibaca dari `/api/meta`).

**UX Telegram**
- Ikuti `themeParams` agar warna mengikuti tema Telegram (gelap/terang).
- Pakai `MainButton` untuk aksi utama (Simpan) dan `BackButton` untuk navigasi.
- Panggil `HapticFeedback` saat sukses atau error, dan `expand()` saat dibuka.
- Input nominal pakai keyboard angka (`inputmode="numeric"`) dengan format ribuan saat diketik.
- Form membuat `uid` saat dibuka; submit ulang memakai `uid` yang sama.
- Bundle sekecil mungkin (Preact). Navigasi = tab bawah + tumpukan layar di memori (bukan hash router, karena Telegram memakai hash URL untuk parameter peluncuran).
- Di luar klien Telegram (mis. browser biasa saat pengembangan), MainButton/BackButton diganti tombol biasa di halaman.

## 13. Cron (`scheduled`)

Cron berjalan **setiap jam** (`0 * * * *`). Di dalam handler (semua jam & tanggal dalam WIB):
- Jika jam sekarang = `daily_report_hour_wib`:
  - `daily_report_enabled=1` → kirim ringkasan **hari ini**.
  - Hari Senin dan `weekly_report_enabled=1` → kirim ringkasan **minggu lalu** (Senin–Minggu) + perbandingan dengan minggu sebelumnya.
  - Tanggal 1 dan `monthly_report_enabled=1` → kirim ringkasan **bulan lalu** + perbandingan dengan bulan sebelumnya, **ditambah file PDF** (§ ekspor) yang selalu dikirim ke chat pribadi owner.
  - Tujuan: chat pribadi owner (lengkap dengan HPP/laba), atau grup yang dipilih owner lewat `/jadwal grup` (`daily_report_chat_id` + `daily_report_chat_title`; tanpa HPP/laba). `/jadwal pribadi` atau tombol di Mini App mengembalikan ke owner.
- *(Fase 6)* Modul stok aktif → kirim peringatan stok menipis (maks 1x/hari).
- Bersihkan `bot_sessions` yang kedaluwarsa dan `processed_updates` yang lebih dari 3 hari.
- Cegah kiriman dobel: tiap jenis laporan **diklaim dulu** secara atomik (`UPDATE settings SET value = <hari ini> WHERE key = 'last_<jenis>_report_date' AND value <> <hari ini>`); hanya pemenang klaim yang mengirim. Bila pengiriman gagal (mis. bot dikeluarkan dari grup), kegagalan dicatat di log Worker dan laporan itu dilewati sampai hari berikutnya.
- Implementasi: `worker/bot/scheduled.ts` (`runScheduled(env, api, now)`), dipanggil dari `scheduled()` di `worker/index.ts` dengan `controller.scheduledTime`.

## 14. Konvensi Kode (untuk Claude Code)

- TypeScript `strict`. Tanpa `any` kecuali di batas eksternal.
- **Uang = integer rupiah.** Tidak ada float di perhitungan uang. Format tampilan: `Rp 1.250.000`.
- **Tanggal transaksi** (kas, penjualan, restock, opname) divalidasi `txDateError()` di `lib/date.ts`: harus tanggal kalender yang ada, ≥ 2000-01-01, dan **tidak melewati hari ini (WIB)**.
- `/setup`: password salah diperlambat 1,5 detik; lebih dari 20 kali salah dalam satu jam (UTC) → dikunci (429) sampai jam berikutnya (`settings.setup_fail`).
- `test/simulation.test.ts`: simulasi acak ±400 operasi (sebagian bersamaan) lalu mencocokkan silang semua laporan dengan hitungan langsung dari data mentah + invarian integritas (stok = Σ mutasi, kas penjualan/pembelian, pasangan transfer, invoice tanpa celah, audit). Jalankan setiap mengubah service atau query laporan.
- **Tanggal:** semua "hari ini" & periode dihitung di zona `Asia/Jakarta` lewat helper `lib/date.ts`; jangan pakai `new Date().toISOString().slice(0,10)` (itu UTC).
- Semua SQL memakai parameter binding (`?1`), tidak boleh string concat.
- Operasi multi-tabel **wajib** memakai `env.DB.batch()` dengan pola §9.0.
- Handler bot & route API hanya validasi input + memanggil `services/*`.
- Fitur modul stok selalu dicek lewat `services/features.ts`, tidak membaca `settings` langsung.
- Setiap mutasi menulis `audit_log`.
- Error bisnis memakai class `AppError(code, message, status)`; pesan untuk user dalam Bahasa Indonesia.
- Test: Vitest untuk `parsers/amount.ts`, `auth/initData.ts`, `auth/redact.ts`, `lib/date.ts` (periode), `services/sales.ts`, `services/cash.ts`, dan `services/reports.ts` (pakai D1 lokal dari `vitest-pool-workers`, skema via `migrate.ts`).

## 15. Roadmap

| Fase | Cakupan | Selesai jika |
|---|---|---|
| **0. Fondasi** ✅ | Scaffold, wrangler, `migrate.ts`, `/setup`, webhook, klaim owner | Bot membalas `/start` di akun CF sendiri |
| **1. Kas via bot** ✅ | `/masuk`, `/keluar`, parser nominal, konfirmasi, void, transfer, `/saldo`, `/akun`, peringatan saldo minus | Transaksi tersimpan & bisa dibatalkan |
| **2. Penjualan** ✅ | `/omzet` (penjualan cepat), `/produk`, `/jual`, snapshot HPP, kas penjualan otomatis, bot di grup | Omzet & HPP tercatat, kas penjualan otomatis |
| **3. Laporan** ✅ | Periode (§10), laba rugi, arus kas, harian, per item, `/laporan`, `/export` CSV lewat bot. Kelola user lewat `/user` (dimajukan dari Fase 5) | Angka cocok dengan perhitungan manual |
| **4. Mini App** ✅ | Auth initData, token sesi, `redact.ts`, REST API, Beranda, Kas (+transfer), Jual (cepat & keranjang), Produk, Laporan (4 tab + kirim PDF). Tambahan: Pengaturan kategori/akun kas/channel, ekspor PDF | Semua input & laporan bisa lewat Mini App |
| **5. Multi-user & cron** ✅ | Kelola user di Mini App, redact staff di API, nama usaha, laporan harian/mingguan/bulanan terjadwal (+PDF bulanan), `/jadwal` | Laporan terkirim otomatis tanpa dobel |
| **6. Modul stok (opsional)** ✅ | Flag `feature_stock`, stok awal, mutasi, restock, HPP average, void pembelian, penyesuaian, notifikasi | Aktif/nonaktif tanpa merusak data; HPP benar setelah restock |
| **7. Distribusi** ✅ | Repo publik `judienmz/Catetin`, tombol Deploy to Cloudflare, `.dev.vars.example` + deskripsi secret di `package.json`, workflow "Ambil update Catetin", README setup & update (tanpa lisensi, karena dipakai pribadi & teman) | Teman yang awam bisa setup < 15 menit dan update sendiri |

**Kandidat v2:** sync/backup ke Google Sheets (cron malam), utang-piutang, multi-cabang, import pesanan Shopee/TikTok, struk penjualan (gambar/PDF) dikirim ke chat.
