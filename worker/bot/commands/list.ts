import type { BotCommand } from "grammy/types";

export interface CommandFlags {
  featureStock: boolean;
}

/**
 * Daftar perintah untuk setMyCommands. Hanya perintah yang SUDAH diimplementasikan.
 * Perintah modul stok hanya muncul bila flag aktif (dipasang ulang saat flag diubah).
 */
export function botCommands(flags: CommandFlags): BotCommand[] {
  return [
    { command: "laporan", description: "Laporan: hari, minggu, bulan, bulan lalu, atau tanggal" },
    { command: "omzet", description: "Catat penjualan cepat, mis. /omzet 1,5jt hpp 900rb" },
    { command: "jual", description: "Jual produk, mis. /jual salep 3" },
    { command: "masuk", description: "Catat kas masuk, mis. /masuk 500rb modal" },
    { command: "keluar", description: "Catat kas keluar, mis. /keluar 75rb ongkir" },
    { command: "transfer", description: "Pindah dana antar akun, mis. /transfer 1jt tunai bca" },
    { command: "saldo", description: "Lihat saldo per akun kas" },
    ...(flags.featureStock
      ? [
          { command: "stok", description: "Lihat stok, mis. /stok salep" },
          { command: "restock", description: "Catat belanja stok, mis. /restock salep 10 12rb" },
        ]
      : []),
    { command: "produk", description: "Daftar & kelola produk" },
    { command: "export", description: "Kirim laporan PDF (default bulan ini)" },
    { command: "akun", description: "Daftar & tambah akun kas" },
    { command: "user", description: "Kelola user & undangan (owner)" },
    { command: "jadwal", description: "Laporan otomatis: lihat & pilih tujuan (owner)" },
    { command: "app", description: "Buka aplikasi" },
    { command: "start", description: "Mulai" },
  ];
}
