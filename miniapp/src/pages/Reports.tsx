import { useState } from "preact/hooks";
import { api, type CategoryTotal } from "../api";
import { pct, PERIOD_LABEL, periodRange, rangeLabel, rupiah, tglPendek, type PeriodKey } from "../format";
import { BarChart, Chips, Empty, ErrorBox, Loading, Row, Section, Segmented, useApp, useAsync, useSaver } from "../ui";

type Tab = "pl" | "cash" | "daily" | "items";
const PERIODS: (PeriodKey | "custom")[] = ["hari", "kemarin", "minggu", "minggulalu", "bulan", "bulanlalu", "custom"];

export function ReportsPage() {
  const { meta, version } = useApp();
  const [period, setPeriod] = useState<PeriodKey | "custom">("bulan");
  const [custom, setCustom] = useState({ from: `${meta.today.slice(0, 8)}01`, to: meta.today });
  const [tab, setTab] = useState<Tab>("pl");
  const range = period === "custom" ? custom : periodRange(period, meta.today);
  const validCustom = custom.from <= custom.to;
  const { busy, run } = useSaver();

  return (
    <div>
      <header class="page-head">
        <h1>Laporan</h1>
        <p class="muted">{rangeLabel(range.from, range.to)}</p>
      </header>
      <div class="filters">
        <Chips options={PERIODS.map((p) => ({ value: p, label: p === "custom" ? "Pilih tanggal" : PERIOD_LABEL[p] }))} value={period} onChange={setPeriod} />
        {period === "custom" ? (
          <div class="daterange">
            <input type="date" value={custom.from} max={meta.today} aria-label="Dari tanggal" onInput={(e) => setCustom({ ...custom, from: e.currentTarget.value })} />
            <span>–</span>
            <input type="date" value={custom.to} max={meta.today} aria-label="Sampai tanggal" onInput={(e) => setCustom({ ...custom, to: e.currentTarget.value })} />
          </div>
        ) : null}
        <Segmented
          options={[
            { value: "pl", label: "Laba rugi" },
            { value: "cash", label: "Arus kas" },
            { value: "daily", label: "Harian" },
            { value: "items", label: "Per item" },
          ]}
          value={tab}
          onChange={setTab}
        />
      </div>

      {!validCustom ? (
        <ErrorBox message="Tanggal akhir harus setelah tanggal awal." />
      ) : (
        <>
          {tab === "pl" && <ProfitLossView from={range.from} to={range.to} v={version} />}
          {tab === "cash" && <CashflowView from={range.from} to={range.to} v={version} />}
          {tab === "daily" && <DailyView from={range.from} to={range.to} v={version} />}
          {tab === "items" && <ItemsView from={range.from} to={range.to} v={version} />}
          <button
            class="btn block"
            disabled={busy}
            onClick={() =>
              run(async () => {
                await api.exportReport(range.from, range.to);
              }, "Laporan PDF dikirim ke chat bot")
            }
          >
            {busy ? "Mengirim…" : "Kirim laporan PDF ke chat bot"}
          </button>
          <p class="footnote center">Berisi laba rugi, arus kas, penjualan per item, rincian harian, dan daftar transaksi.</p>
        </>
      )}
    </div>
  );
}

interface ViewProps {
  from: string;
  to: string;
  v: number;
}

function Breakdown({ rows }: { rows: CategoryTotal[] }) {
  return (
    <>
      {rows.map((c) => (
        <Row left={<span class="indent">{c.name}</span>} right={rupiah(c.total)} />
      ))}
    </>
  );
}

function ProfitLossView({ from, to, v }: ViewProps) {
  const { data: d, error, loading, reload } = useAsync(() => api.profitLoss(from, to), [from, to, v]);
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBox message={error ?? ""} onRetry={reload} />;
  return (
    <>
      <div class="hero">
        <span class="muted">Laba bersih</span>
        <span class={`hero-amount ${d.labaBersih < 0 ? "neg" : "pos"}`}>{rupiah(d.labaBersih)}</span>
        <span class="muted">{d.jmlTransaksi} transaksi penjualan</span>
      </div>
      <Section title="Penjualan">
        <Row left="Omzet" sub={d.diskon > 0 ? `sudah dikurangi diskon ${rupiah(d.diskon)}` : undefined} right={rupiah(d.omzet)} />
        <Row left="HPP" right={`−${rupiah(d.hpp)}`} />
        <Row left={<b>Laba kotor</b>} sub={`margin ${pct(d.labaKotor, d.omzet)}`} right={<b>{rupiah(d.labaKotor)}</b>} />
      </Section>
      <Section title="Biaya & pendapatan lain">
        {d.pendapatanLain > 0 ? (
          <>
            <Row left="Pendapatan lain" right={`+${rupiah(d.pendapatanLain)}`} rightClass="pos" />
            <Breakdown rows={d.pendapatanLainPerKategori} />
          </>
        ) : null}
        <Row left="Biaya operasional" right={`−${rupiah(d.biaya)}`} rightClass={d.biaya > 0 ? "neg" : ""} />
        <Breakdown rows={d.biayaPerKategori} />
        <Row left={<b>Laba bersih</b>} right={<b class={d.labaBersih < 0 ? "neg" : "pos"}>{rupiah(d.labaBersih)}</b>} />
      </Section>
      {d.penjualanTanpaHpp > 0 ? (
        <p class="warn">{d.penjualanTanpaHpp} penjualan tanpa HPP, jadi laba bisa terlihat lebih besar dari sebenarnya.</p>
      ) : null}
      <p class="footnote">Modal masuk, belanja stok, prive, dan transfer tidak dihitung di laba rugi; lihat tab Arus kas.</p>
    </>
  );
}

function CashflowView({ from, to, v }: ViewProps) {
  const { data: d, error, loading, reload } = useAsync(() => api.cashflow(from, to), [from, to, v]);
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBox message={error ?? ""} onRetry={reload} />;
  return (
    <>
      <Section title="Ringkasan">
        <Row left="Saldo awal" right={rupiah(d.totalSaldoAwal)} />
        <Row left="Masuk" right={`+${rupiah(d.totalMasuk)}`} rightClass="pos" />
        <Row left="Keluar" right={`−${rupiah(d.totalKeluar)}`} rightClass="neg" />
        <Row left={<b>Saldo akhir</b>} right={<b>{rupiah(d.totalSaldoAkhir)}</b>} />
      </Section>
      <Section title="Per akun">
        {d.akun.map((a) => (
          <Row left={a.name} sub={`awal ${rupiah(a.saldoAwal)} · +${rupiah(a.masuk)} · −${rupiah(a.keluar)}`} right={rupiah(a.saldoAkhir)} rightClass={a.saldoAkhir < 0 ? "neg" : ""} />
        ))}
      </Section>
      <Section title="Masuk per kategori">{d.masukPerKategori.length ? <Breakdown rows={d.masukPerKategori} /> : <Empty>Tidak ada.</Empty>}</Section>
      <Section title="Keluar per kategori">{d.keluarPerKategori.length ? <Breakdown rows={d.keluarPerKategori} /> : <Empty>Tidak ada.</Empty>}</Section>
    </>
  );
}

function DailyView({ from, to, v }: ViewProps) {
  const { data: d, error, loading, reload } = useAsync(() => api.daily(from, to), [from, to, v]);
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBox message={error ?? ""} onRetry={reload} />;
  if (!d.rows.length) return <Empty>Tidak ada aktivitas di periode ini.</Empty>;
  return (
    <>
      {d.rows.length > 1 ? (
        <Section title="Laba bersih per hari">
          <BarChart data={d.rows.map((r) => ({ tanggal: r.tanggal, value: r.labaBersih }))} label="Grafik laba bersih per hari" />
        </Section>
      ) : null}
      <Section title="Rincian">
        {[...d.rows].reverse().map((r) => (
          <Row
            left={tglPendek(r.tanggal)}
            sub={`omzet ${rupiah(r.omzet)} · HPP ${rupiah(r.hpp)}${r.biaya ? ` · biaya ${rupiah(r.biaya)}` : ""}`}
            right={rupiah(r.labaBersih)}
            rightClass={r.labaBersih < 0 ? "neg" : "pos"}
          />
        ))}
      </Section>
    </>
  );
}

function ItemsView({ from, to, v }: ViewProps) {
  const { data: d, error, loading, reload } = useAsync(() => api.items(from, to), [from, to, v]);
  if (loading && !d) return <Loading />;
  if (error || !d) return <ErrorBox message={error ?? ""} onRetry={reload} />;
  if (!d.rows.length) return <Empty>Belum ada penjualan di periode ini.</Empty>;
  return (
    <Section title={`${d.rows.length} item`}>
      {d.rows.map((r) => (
        <Row left={r.name} sub={`${r.qty} terjual · laba ${rupiah(r.labaKotor ?? 0)} (${pct(r.labaKotor ?? 0, r.omzet)})`} right={rupiah(r.omzet)} />
      ))}
    </Section>
  );
}
