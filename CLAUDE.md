# CLAUDE.md

Proyek: Bot Telegram + Mini App pencatatan keuangan usaha (kas, omzet, laba rugi, biaya, laporan harian/mingguan/bulanan), berjalan di Cloudflare Workers + D1 (Free plan), di-deploy di akun Cloudflare & bot milik tiap pengguna. Untuk pemakaian pribadi dan teman, tidak dijual (tanpa lisensi).

**Sumber kebenaran:** `ARCHITECTURE.md` (spesifikasi) dan `migrations/0001_init.sql` (skema). Baca keduanya sebelum mengerjakan apa pun.

## Aturan wajib
- Uang = integer rupiah. Tidak ada float.
- "Hari ini" dan periode laporan = zona Asia/Jakarta via `worker/lib/date.ts`.
- Operasi multi-tabel pakai `env.DB.batch()` dengan pola §9.0: `uid` dibuat sebelum batch, baris anak merujuk induk via `(SELECT id ... WHERE uid=?)`, nilai turunan DB (invoice, HPP, stok) dihitung di SQL.
- Data keuangan tidak di-DELETE, gunakan void.
- HPP & harga jual di-snapshot ke `sale_items` saat penjualan. Penjualan cepat (`product_id` NULL) tetap wajib punya `cost_price` (boleh 0).
- Modul stok opsional (`feature_stock`, default mati). Cek selalu lewat `services/features.ts`; saat mati, jangan menulis `stock_movements`.
- Logika bisnis hanya di `worker/services/*`; bot & API cukup memanggilnya.
- Staff tidak boleh menerima field HPP/laba dari API; penyaringan hanya di `worker/auth/redact.ts`.
- Setiap mutasi menulis `audit_log`.
- Migrasi hanya lewat `worker/db/migrate.ts` (bukan `wrangler d1 migrations`). Jangan ubah migrasi yang sudah pernah dirilis; buat file `migrations/000N_*.sql` baru dan daftarkan di `db/migrate.ts`.

## Perintah
- `npm run dev`: wrangler dev + vite dev
- `npm run build`: build Mini App ke `miniapp/dist`
- `npm run deploy`: build + `wrangler deploy`
- `npm test`: vitest

## Cara kerja
Kerjakan per fase sesuai §15 Roadmap di ARCHITECTURE.md. Selesaikan dan tes satu fase sebelum lanjut ke fase berikutnya.
