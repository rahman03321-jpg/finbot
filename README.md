# Catetin

**Catat keuangan usaha langsung dari Telegram.** Kas masuk & keluar, penjualan, omzet, HPP, laba rugi, stok, dan laporan harian/mingguan/bulanan, lewat chat bot maupun Mini App, dan bisa dipakai bersama tim di grup.

Berjalan **di akun Cloudflare milikmu sendiri** (gratis, Free plan). Data keuangan, token bot, dan semua pengaturan hanya ada di akunmu, bukan di server orang lain.

[![Deploy to Cloudflare](https://deploy.workers.cloudflare.com/button)](https://deploy.workers.cloudflare.com/?url=https://github.com/judienmz/Catetin)

---

## Fitur

- **Kas**: `/masuk 500rb modal`, `/keluar 75rb ongkir jne`, transfer antar akun (Tunai, BCA, Dana, …), saldo per akun, peringatan saldo minus.
- **Penjualan**: `/omzet 1,5jt hpp 900rb shopee` (tanpa daftar produk) atau `/jual salep 3` (dari daftar produk). Nomor invoice otomatis, kas masuk otomatis.
- **Laporan**: laba rugi, arus kas, rincian harian, penjualan per item, per periode bebas. Ekspor **PDF** (atau CSV).
- **Laporan otomatis**: harian, mingguan (Senin), bulanan (tanggal 1, plus PDF), ke chat pribadi atau grup.
- **Mini App**: dashboard, form penjualan & kas, produk, laporan, pengaturan, dengan tampilan mengikuti tema Telegram.
- **Tim**: peran Owner / Admin / Staff. Staff tidak pernah melihat HPP & laba. Undang anggota lewat tautan.
- **Stok (opsional)**: stok berkurang saat terjual, restock dengan HPP rata-rata, stok opname, peringatan stok menipis.
- Format nominal bebas: `50rb`, `250k`, `1,5jt`, `250.000`, `Rp 250.000`.
- Data tidak pernah dihapus permanen: transaksi yang salah dibatalkan (void) dan tetap tercatat di riwayat.

## Yang kamu butuhkan

- Akun **Telegram**
- Akun **GitHub** (gratis): [github.com/signup](https://github.com/signup)
- Akun **Cloudflare** (gratis): [dash.cloudflare.com/sign-up](https://dash.cloudflare.com/sign-up)

Tidak perlu komputer khusus, dan semua langkah bisa dari browser.

---

## Cara pasang (±15 menit)

### 1. Buat bot Telegram

1. Buka [@BotFather](https://t.me/BotFather) di Telegram, ketik `/newbot`.
2. Isi nama bot (bebas, mis. *Catetan Toko Sari*) dan username (harus diakhiri `bot`, mis. `catetan_toko_sari_bot`).
3. BotFather memberi **token** seperti `123456789:AAH...`. Salin, jangan dibagikan ke siapa pun.

### 2. Deploy ke Cloudflare

1. Klik tombol **Deploy to Cloudflare** di atas.
2. Login ke Cloudflare, lalu hubungkan akun GitHub kalau diminta (Cloudflare akan membuat salinan repo ini di GitHub-mu).
3. Di halaman pengaturan:
   - **Database (DB)**: biarkan dibuat otomatis.
   - **BOT_TOKEN**: tempel token dari BotFather.
   - **SETUP_KEY**: buat password sendiri, **minimal 12 karakter**. Catat, nanti dipakai di langkah 3.
4. Klik **Create and deploy**, lalu tunggu 1–2 menit sampai selesai.
5. Catat alamat Worker-mu, bentuknya `https://<nama>.<subdomain-kamu>.workers.dev`.

### 3. Jalankan setup

1. Buka `https://<alamat-worker>/setup` di browser.
2. Masukkan **SETUP_KEY**, lalu klik **Jalankan setup**.
3. Semua langkah harus bertanda ✓ hijau (database, bot, webhook, tombol menu, perintah).

### 4. Jadi owner

1. Di halaman setup yang sama, klik **Klaim sebagai owner** dari HP/Telegram yang akan jadi pemilik.
2. Telegram membuka bot-mu, lalu tekan **Start**. Bot membalas *"Kamu sekarang owner usaha ini"*.

Selesai! 🎉 Coba ketik `/omzet 100rb` atau buka aplikasi lewat tombol **Buka App** di kiri bawah chat.

### 5. Pengaturan awal (disarankan)

Buka Mini App, tekan ⚙ di Beranda:
- **Nama usaha**: ganti dari "Usaha Saya".
- **Akun kas / rekening**: isi **saldo awal** Tunai, tambah rekening bank / e-wallet.
- **Kategori** & **channel penjualan**: sesuaikan dengan usahamu.
- **Laporan otomatis**: pilih jam kirim.
- **Modul stok**: nyalakan kalau perlu melacak stok barang.

### 6. Pasang tombol update (sekali saja, ±2 menit)

Saat menyalin repo, Cloudflare **tidak ikut menyalin folder `.github`**, jadi tombol update belum ada di repo-mu. Tambahkan sekali:

1. Buka repo milikmu di GitHub (yang dibuat Cloudflare saat deploy) → **Add file → Create new file**.
2. Nama file, ketik persis: `.github/workflows/sync-upstream.yml`
3. Buka [sync-upstream.yml di repo Catetin](https://github.com/judienmz/Catetin/blob/main/.github/workflows/sync-upstream.yml), tekan ikon **Copy raw file** (kanan atas), lalu tempel ke isi file baru.
4. Tekan **Commit changes**. Cloudflare akan deploy ulang otomatis (aman, datamu tidak tersentuh).

Setelah ini, tab **Actions** punya **Ambil update Catetin** untuk mengambil versi baru kapan saja.

---

## Pakai bersama tim

- **Undang anggota**: Mini App → ⚙ → User → **+ Undang** (pilih Staff/Admin), lalu kirim tautannya. Atau di bot: `/user undang staff`.
- **Di grup**: masukkan bot ke grup usaha. Anggota yang terdaftar bisa mencatat langsung di grup. Di grup, HPP & laba tidak pernah ditampilkan.
- **Laporan otomatis ke grup**: ketik `/jadwal grup` di grup tersebut (owner).

| Peran | Bisa |
|---|---|
| Owner | Semua, termasuk user, akun kas, dan pengaturan usaha |
| Admin | Input transaksi, kelola produk/kategori/channel, lihat HPP, laba & laporan |
| Staff | Input transaksi saja. Tidak melihat HPP, laba, saldo, maupun laporan |

## Perintah bot

| Perintah | Contoh |
|---|---|
| `/omzet` | `/omzet 1,5jt hpp 900rb shopee` |
| `/jual` | `/jual salep 3` · `/jual salep 2 18rb wa` |
| `/masuk` · `/keluar` | `/masuk 500rb modal` · `/keluar 75rb ongkir` |
| `/transfer` | `/transfer 1jt tunai bca` |
| `/saldo` | saldo per akun |
| `/laporan` | `/laporan` · `/laporan bulan` · `/laporan 1/11 15/11` |
| `/export` | `/export bulan lalu` (PDF) · `/export bulan csv` |
| `/produk` | `/produk tambah Salep hpp 12rb jual 20rb` |
| `/stok` · `/restock` | `/restock salep 10 12rb` (modul stok) |
| `/akun` | `/akun tambah BCA bank 2jt` |
| `/user` | `/user undang staff` |
| `/jadwal` | `/jadwal grup` · `/jadwal pribadi` |
| `/app` | buka Mini App |

Setiap input menampilkan ringkasan dulu dengan tombol **Simpan / Batal**. Setelah tersimpan, ada tombol **Batalkan** kalau ternyata salah.

---

## Update ke versi terbaru

1. Buka repo Catetin **milikmu** di GitHub (yang dibuat Cloudflare saat deploy).
2. Tab **Actions** → pilih **Ambil update Catetin** → **Run workflow** → **Run workflow**.
   - Tidak ada **Ambil update Catetin**? Pasang dulu sekali (lihat [langkah 6](#6-pasang-tombol-update-sekali-saja-2-menit)).
   - Pertama kali, GitHub mungkin meminta kamu mengaktifkan Actions. Klik tombol hijau untuk mengizinkan.
3. Tunggu sampai centang hijau. Cloudflare akan deploy ulang otomatis dalam 1–2 menit.
4. Buka `https://<alamat-worker>/setup` dan jalankan setup sekali lagi (supaya database ikut diperbarui).

Data keuanganmu tidak tersentuh, dan file `wrangler.jsonc` (berisi ID database-mu) tidak pernah ditimpa oleh update.

---

## Tanya jawab

**Berapa biayanya?**
Gratis selama pemakaian masih dalam batas Cloudflare Free plan (sangat cukup untuk usaha kecil–menengah: ratusan ribu request per hari, database sampai 500 MB).

**Lupa SETUP_KEY?**
Dashboard Cloudflare → Workers & Pages → worker-mu → **Settings → Variables and Secrets** → ubah `SETUP_KEY`.

**Ganti token bot / token bocor?**
Di @BotFather: `/mybots` → pilih bot → **API Token → Revoke**. Lalu ganti `BOT_TOKEN` di Variables and Secrets (seperti di atas) dan jalankan `/setup` lagi.

**Data saya aman?**
Database ada di akun Cloudflare-mu sendiri. Pemilik repo ini tidak punya akses apa pun ke datamu. Akses bot & Mini App dibatasi ke akun Telegram yang terdaftar.

**Backup?**
Kirim laporan PDF/CSV berkala (`/export`). Cloudflare D1 juga menyimpan riwayat pemulihan untuk beberapa hari terakhir (Time Travel di dashboard D1).

**Salah input?**
Tekan **Batalkan** di pesan bot, atau buka transaksinya di Mini App → **Batalkan**. Transaksi ditandai batal, tidak dihapus.

---

## Untuk pengembang

Butuh Node.js 20+.

```bash
npm install
cp .dev.vars.example .dev.vars   # isi BOT_TOKEN & SETUP_KEY
npm run dev                      # build Mini App + wrangler dev
npm test                         # 190+ test di runtime Workers (D1 lokal)
npm run typecheck
npm run deploy                   # deploy manual dengan `wrangler login`
```

- Spesifikasi lengkap: [ARCHITECTURE.md](ARCHITECTURE.md) · konvensi kode: [CLAUDE.md](CLAUDE.md)
- Stack: Cloudflare Workers + D1, Hono, grammY, Zod, Preact + Vite.
- Migrasi database berjalan lewat halaman `/setup` (`worker/db/migrate.ts`), bukan `wrangler d1 migrations`.
- Webhook Telegram butuh HTTPS publik, jadi logika bot dites lewat `npm test`, bukan `wrangler dev`.
