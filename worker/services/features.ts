import { AppError } from "../lib/errors";
import { getSetting } from "./settings";

export interface Features {
  stock: boolean;
}

/** Satu-satunya tempat membaca flag fitur (lihat ARCHITECTURE.md §9.4). */
export async function getFeatures(db: D1Database): Promise<Features> {
  return { stock: (await getSetting(db, "feature_stock")) === "1" };
}

/** Lempar FEATURE_DISABLED bila modul stok mati (ARCHITECTURE.md §9.4). */
export async function requireStock(db: D1Database): Promise<void> {
  if (!(await getFeatures(db)).stock) {
    throw new AppError("FEATURE_DISABLED", "Fitur stok belum diaktifkan. Aktifkan di Pengaturan → Usaha → Modul stok.", 403);
  }
}
