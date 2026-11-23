import { api, type PeriodSummary } from "../api";
import { pct, rupiah, tgl } from "../format";
import { BarChart, Empty, ErrorBox, Loading, Row, Section, useApp, useAsync } from "../ui";
import { openCashForm } from "./Cash";
import { openCartForm, openQuickSale } from "./Sales";
import { openSettings } from "./Settings";
import { CashByAccountCard } from "../components/CashByAccount";

function delta(now: number, prev: number | undefined): { text: string; cls: string } | null {
  if (prev === undefined) return null;
  if (prev === 0) return now > 0 ? { text: "baru", cls: "up" } : null;
  const d = Math.round(((now - prev) * 100) / Math.abs(prev));
  if (d === 0) return { text: "sama", cls: "" };
  return { text: `${d > 0 ? "▲" : "▼"} ${Math.abs(d)}%`, cls: d > 0 ? "up" : "down" };
}

function Stat({ label, value, sub, tone }: { label: string; value: number; sub?: { text: string; cls: string } | null; tone?: "pos" | "neg" | "auto" }) {
  const cls = tone === "auto" ? (value < 0 ? "neg" : "pos") : (tone ?? "");
  return (
    <div class="stat">
      <span class="stat-label">{label}</span>
      <span class={`stat-value ${cls}`}>{rupiah(value)}</span>
      {sub ? <span class={`stat-sub ${sub.cls}`}>{sub.text} vs bulan lalu</span> : null}
    </div>
  );
}

export function Home({ goTo }: { goTo: (tab: string) => void }) {
  const app = useApp();
  const { meta, isAdmin, version } = app;
  const { data, error, loading, reload } = useAsync(() => api.summary(), [version]);

  return (
    <div>
      <header class="page-head row-head">
        <div>
          <p class="eyebrow">{tgl(meta.today)}</p>
          <h1>{meta.business_name}</h1>
          <p class="muted">Halo, {meta.user.full_name.split(" ")[0]}</p>
        </div>
        {isAdmin ? (
          <button class="icon-btn" onClick={() => openSettings(app)} aria-label="Pengaturan">
            <svg viewBox="0 0 24 24" aria-hidden="true">
              <circle cx="12" cy="12" r="3" />
              <path d="M19.4 15a1.7 1.7 0 0 0 .3 1.8l.1.1a2 2 0 1 1-2.8 2.8l-.1-.1a1.7 1.7 0 0 0-1.8-.3 1.7 1.7 0 0 0-1 1.5V21a2 2 0 1 1-4 0v-.1a1.7 1.7 0 0 0-1.1-1.5 1.7 1.7 0 0 0-1.8.3l-.1.1a2 2 0 1 1-2.8-2.8l.1-.1a1.7 1.7 0 0 0 .3-1.8 1.7 1.7 0 0 0-1.5-1H3a2 2 0 1 1 0-4h.1a1.7 1.7 0 0 0 1.5-1.1 1.7 1.7 0 0 0-.3-1.8l-.1-.1a2 2 0 1 1 2.8-2.8l.1.1a1.7 1.7 0 0 0 1.8.3H9a1.7 1.7 0 0 0 1-1.5V3a2 2 0 1 1 4 0v.1a1.7 1.7 0 0 0 1 1.5 1.7 1.7 0 0 0 1.8-.3l.1-.1a2 2 0 1 1 2.8 2.8l-.1.1a1.7 1.7 0 0 0-.3 1.8V9a1.7 1.7 0 0 0 1.5 1H21a2 2 0 1 1 0 4h-.1a1.7 1.7 0 0 0-1.5 1z" />
            </svg>
          </button>
        ) : null}
      </header>

      <div class="quick">
        <button class="btn primary" onClick={() => openQuickSale(app)}>
          + Penjualan
        </button>
        <button class="btn" onClick={() => openCartForm(app)}>
          Jual produk
        </button>
        <button class="btn" onClick={() => openCashForm(app, "in")}>
          + Masuk
        </button>
        <button class="btn" onClick={() => openCashForm(app, "out")}>
          + Keluar
        </button>
      </div>

      {loading && !data ? <Loading /> : error ? <ErrorBox message={error} onRetry={reload} /> : data ? (
        <>
          <Section title="Hari ini">
            <div class="stats">
              <Stat label="Omzet" value={data.today.omzet} />
              {isAdmin ? <Stat label="Laba bersih" value={data.today.labaBersih ?? 0} tone="auto" /> : <Count p={data.today} />}
            </div>
          </Section>

          <Section title="Bulan ini">
            <div class="stats">
              <Stat label="Omzet" value={data.month.omzet} sub={delta(data.month.omzet, data.prevMonth?.omzet)} />
              {isAdmin ? (
                <>
                  <Stat label="Laba bersih" value={data.month.labaBersih ?? 0} tone="auto" sub={delta(data.month.labaBersih ?? 0, data.prevMonth?.labaBersih)} />
                  <Stat label="Biaya operasional" value={data.month.biaya ?? 0} />
                  <Stat label="Saldo kas" value={data.saldoKas ?? 0} tone="auto" />
                </>
              ) : (
                <Count p={data.month} />
              )}
            </div>
            {isAdmin && data.month.omzet > 0 ? (
              <p class="footnote">
                Margin kotor {pct(data.month.labaKotor ?? 0, data.month.omzet)} · {data.month.jmlTransaksi} transaksi
              </p>
            ) : null}
          </Section>

          <CashByAccountCard from={`${meta.today.slice(0, 8)}01`} to={meta.today} title="Kas bulan ini" />

          <Section title="Omzet 30 hari">
            <BarChart data={data.chart.map((d) => ({ tanggal: d.tanggal, value: d.omzet }))} label="Grafik omzet harian 30 hari terakhir" />
          </Section>

          <Section title="Terlaris bulan ini" action={isAdmin ? <button class="link" onClick={() => goTo("reports")}>Laporan</button> : undefined}>
            {data.topItems.length ? (
              data.topItems.map((i, n) => <Row left={`${n + 1}. ${i.name}`} sub={`${i.qty} terjual`} right={rupiah(i.omzet)} />)
            ) : (
              <Empty>Belum ada penjualan bulan ini.</Empty>
            )}
          </Section>

          {data.lowStock && data.lowStock.length ? (
            <Section title="Stok menipis">
              {data.lowStock.map((p) => (
                <Row left={p.name} sub={`minimum ${p.min_stock}`} right={String(p.stock)} rightClass="neg" />
              ))}
            </Section>
          ) : null}
        </>
      ) : null}
    </div>
  );
}

function Count({ p }: { p: PeriodSummary }) {
  return (
    <div class="stat">
      <span class="stat-label">Transaksi</span>
      <span class="stat-value">{p.jmlTransaksi}</span>
    </div>
  );
}
