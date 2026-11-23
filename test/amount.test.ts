import { describe, expect, it } from "vitest";
import { parseAmount, takeAmount } from "../worker/bot/parsers/amount";
import { rupiah } from "../worker/bot/format";

describe("parseAmount", () => {
  const valid: [string, number][] = [
    ["250000", 250_000],
    ["250k", 250_000],
    ["250K", 250_000],
    ["50rb", 50_000],
    ["50 rb", 50_000],
    ["50rbu", 50_000],
    ["50ribu", 50_000],
    ["50 rebu", 50_000],
    ["1jt", 1_000_000],
    ["1JT", 1_000_000],
    ["2 juta", 2_000_000],
    ["1,5jt", 1_500_000],
    ["1.5jt", 1_500_000],
    ["1,25jt", 1_250_000],
    ["2,5k", 2_500],
    ["1.500rb", 1_500_000],
    ["250.000", 250_000],
    ["1.250.000", 1_250_000],
    ["1,250,000", 1_250_000],
    ["Rp 250.000", 250_000],
    ["Rp250.000", 250_000],
    ["rp. 75.000", 75_000],
    ["IDR 250000", 250_000],
    ["250.000,-", 250_000],
    ["250.000,00", 250_000],
    ["250000.00", 250_000],
    ["5000", 5_000],
  ];
  it.each(valid)("%s → %d", (input, expected) => {
    expect(parseAmount(input)).toBe(expected);
  });

  const invalid = ["", "abc", "0", "0rb", "-5000", "1,5", "12.50", "250.000,50", "1.2.3", "5x", "1,0000001jt", "9999999jt", "1..000"];
  it.each(invalid)("%s → null", (input) => {
    expect(parseAmount(input)).toBeNull();
  });
});

describe("takeAmount", () => {
  it("satuan terpisah digabung", () => {
    expect(takeAmount(["75", "rb", "ongkir", "jne"])).toEqual({ amount: 75_000, rest: ["ongkir", "jne"] });
  });
  it("angka biasa diikuti kata yang bukan satuan", () => {
    expect(takeAmount(["75000", "ongkir"])).toEqual({ amount: 75_000, rest: ["ongkir"] });
  });
  it("tidak ada nominal", () => {
    expect(takeAmount(["ongkir", "75rb"])).toBeNull();
  });
});

describe("rupiah", () => {
  it("format ribuan dengan titik", () => {
    expect(rupiah(1_250_000)).toBe("Rp 1.250.000");
    expect(rupiah(500)).toBe("Rp 500");
    expect(rupiah(0)).toBe("Rp 0");
    expect(rupiah(-75_000)).toBe("-Rp 75.000");
  });
});
