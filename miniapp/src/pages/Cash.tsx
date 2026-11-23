import { useMemo, useState } from "preact/hooks";
import { api, type CashRow, type Direction } from "../api";
import { hariTgl, newUid, PERIOD_LABEL, periodRange, rupiah, type PeriodKey } from "../format";
import { confirmDialog } from "../tg";
import { CashByAccountCard } from "../components/CashByAccount";
import { Chips, Empty, ErrorBox, Field, Loading, MoneyInput, PrimaryAction, Row, Section, Segmented, useApp, useAsync, useSaver, type AppCtx } from "../ui";

const LIST_PERIODS: PeriodKey[] = ["bulan", "minggu", "hari", "bulanlalu"];

export function openCashForm(app: AppCtx, direction: Direction): void {
  app.push({ key: `cash-${direction}-${Date.now()}`, title: direction === "in" ? "Kas masuk" : "Kas keluar", render: () => <CashForm direction={direction} /> });
}

export function openTransferForm(app: AppCtx): void {
  app.push({ key: `transfer-${Date.now()}`, title: "Transfer antar akun", render: () => <TransferForm /> });
}

export function CashPage() {
  const app = useApp();
  const [period, setPeriod] = useState<PeriodKey>("bulan");
  const [dir, setDir] = useState<"all" | Direction>("all");
  const [page, setPage] = useState(1);
  const range = periodRange(period, app.meta.today);
  const { data, error, loading, reload } = useAsync(
    async () => {
      // Muat halaman 1..page agar "Muat lagi" tidak menghapus data sebelumnya.
      const all: CashRow[] = [];
      let hasMore = false;
      for (let p = 1; p <= page; p++) {
        const r = await api.listCash({ ...range, direction: dir === "all" ? undefined : dir, page: p });
        all.push(...r.items);
        hasMore = r.hasMore;
      }
      return { items: all, hasMore };
    },
    [period, dir, page, app.version],
  );

  const groups = useMemo(() => {
    const m = new Map<string, CashRow[]>();
    for (const r of data?.items ?? []) m.set(r.tanggal, [...(m.get(r.tanggal) ?? []), r]);
    return [...m.entries()];
  }, [data]);

  return (
    <div>
      <header class="page-head">
        <h1>Kas</h1>
      </header>
      <div class={app.isAdmin ? "quick three" : "quick"}>
        <button class="btn primary" onClick={() => openCashForm(app, "in")}>
          + Masuk
        </button>
        <button class="btn primary" onClick={() => openCashForm(app, "out")}>
          + Keluar
        </button>
        {app.isAdmin ? (
          <button class="btn" onClick={() => openTransferForm(app)}>
            Transfer
          </button>
        ) : null}
      </div>

      <div class="filters">
        <Chips
          options={LIST_PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))}
          value={period}
          onChange={(v) => {
            setPeriod(v);
            setPage(1);
          }}
        />
        <Segmented
          options={[
            { value: "all", label: "Semua" },
            { value: "in", label: "Masuk" },
            { value: "out", label: "Keluar" },
          ]}
          value={dir}
          onChange={(v) => {
            setDir(v);
            setPage(1);
          }}
        />
      </div>

      {/* Total dari server (semua halaman), bukan hanya baris yang sedang dimuat */}
      <CashByAccountCard from={range.from} to={range.to} title={`Ringkasan ${PERIOD_LABEL[period].toLowerCase()}`} />

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : groups.length === 0 ? (
        <Empty>Belum ada transaksi kas di periode ini.</Empty>
      ) : (
        <>
          {groups.map(([day, rows]) => (
            <Section title={hariTgl(day)}>
              {rows.map((r) => (
                <Row
                  strike={r.status === "void"}
                  left={r.category_name}
                  sub={[r.description, r.account_name, r.status === "void" ? "dibatalkan" : null].filter(Boolean).join(" · ")}
                  right={`${r.direction === "in" ? "+" : "−"}${rupiah(r.amount).replace("Rp ", "Rp ")}`}
                  rightClass={r.direction === "in" ? "pos" : "neg"}
                  onClick={() => app.push({ key: `cashd-${r.id}`, title: "Detail kas", render: () => <CashDetail row={r} /> })}
                />
              ))}
            </Section>
          ))}
          {data?.hasMore ? (
            <button class="btn block" onClick={() => setPage((p) => p + 1)} disabled={loading}>
              {loading ? "Memuat…" : "Muat lagi"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

function CashDetail({ row }: { row: CashRow }) {
  const app = useApp();
  const { busy, run } = useSaver();
  const canVoid = row.status === "posted" && row.ref_type !== "sale" && row.ref_type !== "purchase";
  return (
    <div class="form">
      <div class="hero">
        <span class="muted">{row.direction === "in" ? "Kas masuk" : "Kas keluar"}</span>
        <span class={`hero-amount ${row.direction === "in" ? "pos" : "neg"}`}>{rupiah(row.amount)}</span>
        {row.status === "void" ? <span class="badge">Dibatalkan{row.void_reason ? `: ${row.void_reason}` : ""}</span> : null}
      </div>
      <Section>
        <Row left="Kategori" right={row.category_name} />
        <Row left="Akun" right={row.account_name} />
        <Row left="Tanggal" right={hariTgl(row.tanggal)} />
        {row.description ? <Row left="Catatan" right={row.description} /> : null}
        {row.created_by_name ? <Row left="Dicatat oleh" right={row.created_by_name} /> : null}
      </Section>
      {row.ref_type === "sale" ? <p class="footnote">Kas ini berasal dari penjualan. Batalkan lewat menu Jual → Riwayat.</p> : null}
      {row.ref_type === "transfer" && canVoid ? <p class="footnote">Membatalkan transfer akan membatalkan kedua sisinya.</p> : null}
      {canVoid ? (
        <button
          class="btn danger block"
          disabled={busy}
          onClick={async () => {
            if (!(await confirmDialog("Batalkan transaksi ini? Data tetap tersimpan sebagai riwayat."))) return;
            await run(async () => {
              await api.voidCash(row.id);
              app.bump();
              app.pop();
            }, "Transaksi dibatalkan");
          }}
        >
          Batalkan transaksi
        </button>
      ) : null}
    </div>
  );
}

function CashForm({ direction }: { direction: Direction }) {
  const app = useApp();
  const { meta } = app;
  const [uid] = useState(newUid);
  const categories = meta.categories.filter((c) => c.direction === direction && c.kind !== "sales" && c.kind !== "transfer");
  const [amount, setAmount] = useState(0);
  const [categoryId, setCategoryId] = useState<number>(categories.find((c) => (direction === "in" ? c.kind === "other_income" : c.kind === "expense"))?.id ?? categories[0]?.id ?? 0);
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? 0);
  const [tanggal, setTanggal] = useState(meta.today);
  const [note, setNote] = useState("");
  const { busy, run } = useSaver();

  const account = meta.accounts.find((a) => a.id === accountId);
  const after = direction === "out" && account?.balance !== undefined ? account.balance - amount : null;

  const save = () =>
    run(async () => {
      await api.createCash({ uid, tanggal, direction, amount, category_id: categoryId, account_id: accountId, description: note.trim() || null });
      app.bump();
      await app.reloadMeta();
      app.pop();
    }, direction === "in" ? "Kas masuk tersimpan" : "Kas keluar tersimpan");

  return (
    <div class="form">
      <Field label="Nominal">
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="Kategori">
        <Chips wrap options={categories.map((c) => ({ value: c.id, label: c.name }))} value={categoryId} onChange={setCategoryId} />
      </Field>
      <Field label="Akun">
        <Chips wrap options={meta.accounts.map((a) => ({ value: a.id, label: a.name }))} value={accountId} onChange={setAccountId} />
      </Field>
      {after !== null && amount > 0 && after < 0 ? (
        <p class="warn">
          Saldo {account?.name} akan jadi {rupiah(after)}. Tetap bisa disimpan; pastikan saldo awal / kas masuk sudah dicatat.
        </p>
      ) : null}
      <Field label="Tanggal">
        <input type="date" value={tanggal} max={meta.today} onInput={(e) => setTanggal(e.currentTarget.value)} />
      </Field>
      <Field label="Catatan (opsional)">
        <input type="text" maxLength={200} value={note} placeholder="mis. ongkir JNE" onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <PrimaryAction text="Simpan" onClick={save} disabled={amount <= 0 || !categoryId || !accountId || !tanggal} busy={busy} />
    </div>
  );
}

function TransferForm() {
  const app = useApp();
  const { meta } = app;
  const [uid] = useState(newUid);
  const [amount, setAmount] = useState(0);
  const [fromId, setFromId] = useState(meta.accounts[0]?.id ?? 0);
  const [toId, setToId] = useState(meta.accounts[1]?.id ?? 0);
  const [tanggal, setTanggal] = useState(meta.today);
  const [note, setNote] = useState("");
  const { busy, run } = useSaver();
  const from = meta.accounts.find((a) => a.id === fromId);

  if (meta.accounts.length < 2) {
    return <Empty>Transfer butuh minimal 2 akun kas. Tambahkan akun lewat bot: /akun tambah BCA bank</Empty>;
  }

  const save = () =>
    run(async () => {
      await api.transfer({ uid, tanggal, amount, from_account_id: fromId, to_account_id: toId, description: note.trim() || null });
      app.bump();
      await app.reloadMeta();
      app.pop();
    }, "Transfer tersimpan");

  const opts = meta.accounts.map((a) => ({ value: a.id, label: a.name }));
  return (
    <div class="form">
      <Field label="Nominal">
        <MoneyInput value={amount} onChange={setAmount} autoFocus />
      </Field>
      <Field label="Dari">
        <Chips wrap options={opts} value={fromId} onChange={setFromId} />
      </Field>
      <Field label="Ke">
        <Chips wrap options={opts} value={toId} onChange={setToId} />
      </Field>
      {fromId === toId ? <p class="warn">Akun asal dan tujuan tidak boleh sama.</p> : null}
      {from?.balance !== undefined && amount > 0 && from.balance - amount < 0 ? <p class="warn">Saldo {from.name} akan jadi {rupiah(from.balance - amount)}.</p> : null}
      <Field label="Tanggal">
        <input type="date" value={tanggal} max={meta.today} onInput={(e) => setTanggal(e.currentTarget.value)} />
      </Field>
      <Field label="Catatan (opsional)">
        <input type="text" maxLength={200} value={note} onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <PrimaryAction text="Simpan transfer" onClick={save} disabled={amount <= 0 || fromId === toId} busy={busy} />
    </div>
  );
}
