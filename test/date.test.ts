import { describe, expect, it } from "vitest";
import { wibDate, wibDayOfMonth, wibHour, wibIsoWeekday } from "../worker/lib/date";

describe("lib/date (WIB)", () => {
  it("pukul 17:30 UTC sudah berganti hari di WIB", () => {
    const d = new Date("2026-11-15T17:30:00Z"); // = 16 Nov 00:30 WIB
    expect(wibDate(d)).toBe("2026-11-16");
    expect(wibHour(d)).toBe(0);
    expect(wibDayOfMonth(d)).toBe(16);
    expect(wibIsoWeekday(d)).toBe(1); // Senin
  });

  it("pukul 16:59 UTC masih hari yang sama di WIB", () => {
    const d = new Date("2026-11-15T16:59:00Z"); // = 15 Nov 23:59 WIB (Minggu)
    expect(wibDate(d)).toBe("2026-11-15");
    expect(wibHour(d)).toBe(23);
    expect(wibIsoWeekday(d)).toBe(7);
  });

  it("pergantian bulan & tahun", () => {
    expect(wibDate(new Date("2026-12-31T17:00:00Z"))).toBe("2027-01-01");
  });
});
