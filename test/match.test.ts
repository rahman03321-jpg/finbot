import { describe, expect, it } from "vitest";
import { matchLeading } from "../worker/bot/parsers/match";
import { parseNewAccount } from "../worker/bot/commands/accounts";

const out = [
  { id: 5, name: "Belanja Stok" },
  { id: 6, name: "Iklan" },
  { id: 7, name: "Ongkir" },
  { id: 8, name: "Packing" },
  { id: 9, name: "Gaji" },
  { id: 10, name: "Listrik & Internet" },
  { id: 11, name: "Biaya Admin" },
  { id: 12, name: "Operasional Lain" },
  { id: 13, name: "Prive / Ambil Modal" },
];

const accounts = [
  { id: 1, name: "Tunai" },
  { id: 2, name: "BCA" },
  { id: 3, name: "Bank BRI" },
  { id: 4, name: "BRI Usaha" },
];

describe("matchLeading", () => {
  it("kata pertama cocok persis", () => {
    expect(matchLeading(["ongkir", "jne"], out)).toMatchObject({ match: { id: 7 }, rest: ["jne"] });
  });
  it("awalan ≥ 3 huruf", () => {
    expect(matchLeading(["ong", "jne"], out).match?.id).toBe(7);
    expect(matchLeading(["listrik", "pln"], out)).toMatchObject({ match: { id: 10 }, rest: ["pln"] });
    expect(matchLeading(["admin"], out).match?.id).toBe(11);
    expect(matchLeading(["prive"], out).match?.id).toBe(13);
  });
  it("awalan terlalu pendek tidak dicocokkan", () => {
    expect(matchLeading(["on", "jne"], out)).toMatchObject({ match: null, candidates: [], rest: ["on", "jne"] });
  });
  it("tidak ada yang cocok: semua jadi catatan", () => {
    expect(matchLeading(["bensin", "motor"], out)).toMatchObject({ match: null, candidates: [], rest: ["bensin", "motor"] });
  });
  it("nama multi-kata persis", () => {
    expect(matchLeading(["biaya", "admin", "shopee"], out)).toMatchObject({ match: { id: 11 }, rest: ["shopee"] });
  });
  it("ambigu dipersempit kata kedua", () => {
    expect(matchLeading(["bri", "usaha", "x"], accounts)).toMatchObject({ match: { id: 4 }, rest: ["x"] });
  });
  it("tetap ambigu: kembalikan kandidat", () => {
    const r = matchLeading(["bri", "tunai"], accounts);
    expect(r.match).toBeNull();
    expect(r.candidates.map((c) => c.id)).toEqual([3, 4]);
  });
  it("kosong", () => {
    expect(matchLeading([], out)).toEqual({ match: null, candidates: [], rest: [] });
  });
});

describe("parseNewAccount", () => {
  it("nama, tipe, saldo awal", () => {
    expect(parseNewAccount(["BCA", "bank", "2jt"])).toEqual({ name: "BCA", type: "bank", openingBalance: 2_000_000 });
    expect(parseNewAccount(["Dana", "500rb", "ewallet"])).toEqual({ name: "Dana", type: "ewallet", openingBalance: 500_000 });
    expect(parseNewAccount(["Bank", "Jago"])).toEqual({ name: "Bank Jago", type: "bank", openingBalance: 0 });
    expect(parseNewAccount([])).toBeNull();
  });
});
