/** Kartu kas masuk / keluar dengan rincian per akun (+ saldo per akun untuk owner/admin). */
import { api, type CashByAccount } from "../api";
import { rupiah } from "../format";
import { ErrorBox, Loading, Section, useApp, useAsync } from "../ui";

function Breakdown({ rows, pick }: { rows: CashByAccount["akun"]; pick: (r: CashByAccount["akun"][number]) => number }) {
  const shown = rows.filter((r) => pick(r) !== 0);
  if (!shown.length) return <span class="acc-none">–</span>;
  return (
    <ul class="acc-list">
      {shown.map((r) => (
        <li>
          <span>{r.name}</span>
          <span>{rupiah(pick(r)).replace("Rp ", "")}</span>
        </li>
      ))}
    </ul>
  );
}

export function CashByAccountCard({ from, to, title, showSaldo = true }: { from: string; to: string; title?: string; showSaldo?: boolean }) {
  const { version } = useApp();
  const { data, error, loading, reload } = useAsync(() => api.cashSummary(from, to), [from, to, version]);
  if (loading && !data) {
    return (
      <Section title={title}>
        <Loading />
      </Section>
    );
  }
  if (error || !data) {
    return (
      <Section title={title}>
        <ErrorBox message={error ?? ""} onRetry={reload} />
      </Section>
    );
  }
  const withSaldo = showSaldo && data.totalSaldo !== undefined;
  return (
    <Section title={title}>
      <div class="flow">
        <div class="flow-col">
          <span class="stat-label">Kas masuk</span>
          <span class="stat-value pos">{rupiah(data.totalMasuk)}</span>
          <Breakdown rows={data.akun} pick={(r) => r.masuk} />
        </div>
        <div class="flow-col">
          <span class="stat-label">Kas keluar</span>
          <span class="stat-value neg">{rupiah(data.totalKeluar)}</span>
          <Breakdown rows={data.akun} pick={(r) => r.keluar} />
        </div>
      </div>
      {withSaldo ? (
        <div class="flow-saldo">
          <div class="flow-saldo-head">
            <span class="stat-label">Saldo per akun</span>
            <b class={(data.totalSaldo ?? 0) < 0 ? "neg" : ""}>{rupiah(data.totalSaldo ?? 0)}</b>
          </div>
          <ul class="acc-list">
            {data.akun.map((r) => (
              <li>
                <span>{r.name}</span>
                <span class={(r.saldo ?? 0) < 0 ? "neg" : ""}>{rupiah(r.saldo ?? 0).replace("Rp ", "")}</span>
              </li>
            ))}
          </ul>
        </div>
      ) : null}
      <p class="footnote">Tanpa transfer antar akun{withSaldo ? "; saldo per akhir periode" : ""}.</p>
    </Section>
  );
}
