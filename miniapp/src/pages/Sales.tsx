import { useMemo, useState } from "preact/hooks";
import { api, type Channel, type Product, type Sale } from "../api";
import { hariTgl, newUid, PERIOD_LABEL, periodRange, rupiah, type PeriodKey } from "../format";
import { confirmDialog } from "../tg";
import { Chips, Empty, ErrorBox, Field, Loading, MoneyInput, PrimaryAction, Row, Section, useApp, useAsync, useSaver, type AppCtx } from "../ui";

/** Nama channel dari kode (channel yang sudah dihapus tampil sebagai kodenya). */
const channelLabel = (channels: Channel[], code: string) => channels.find((c) => c.code === code)?.name ?? code;

export function openQuickSale(app: AppCtx): void {
  app.push({ key: `quick-${Date.now()}`, title: "Penjualan cepat", render: () => <QuickSaleForm /> });
}

export function openCartForm(app: AppCtx): void {
  app.push({ key: `cart-${Date.now()}`, title: "Jual produk", render: () => <CartForm /> });
}

function openSale(app: AppCtx, id: number): void {
  app.push({ key: `sale-${id}`, title: "Detail penjualan", render: () => <SaleDetail id={id} /> });
}

const LIST_PERIODS: PeriodKey[] = ["bulan", "minggu", "hari", "bulanlalu"];

export function SalesPage() {
  const app = useApp();
  const [period, setPeriod] = useState<PeriodKey>("bulan");
  const [page, setPage] = useState(1);
  const range = periodRange(period, app.meta.today);
  const { data, error, loading, reload } = useAsync(
    async () => {
      const all: Sale[] = [];
      let hasMore = false;
      for (let p = 1; p <= page; p++) {
        const r = await api.listSales({ ...range, page: p });
        all.push(...r.items);
        hasMore = r.hasMore;
      }
      return { items: all, hasMore };
    },
    [period, page, app.version],
  );
  const total = (data?.items ?? []).filter((s) => s.status === "posted").reduce((n, s) => n + s.total, 0);
  const count = (data?.items ?? []).filter((s) => s.status === "posted").length;

  return (
    <div>
      <header class="page-head">
        <h1>Penjualan</h1>
      </header>
      <div class="quick">
        <button class="btn primary" onClick={() => openQuickSale(app)}>
          Penjualan cepat
          <small>isi omzet saja</small>
        </button>
        <button class="btn primary" onClick={() => openCartForm(app)}>
          Jual produk
          <small>pilih dari daftar</small>
        </button>
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
      </div>
      {data && !loading ? (
        <div class="totals">
          <span>
            {count} transaksi · omzet <b>{rupiah(total)}</b>
          </span>
        </div>
      ) : null}

      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : !data?.items.length ? (
        <Empty>Belum ada penjualan di periode ini.</Empty>
      ) : (
        <>
          <Section title="Riwayat">
            {data.items.map((s) => (
              <Row
                strike={s.status === "void"}
                left={`${s.first_item ?? "-"}${(s.item_count ?? 1) > 1 ? ` +${(s.item_count ?? 1) - 1}` : ""}`}
                sub={[s.invoice_no, hariTgl(s.tanggal), s.channel !== "offline" ? channelLabel(app.meta.channels, s.channel) : null, s.status === "void" ? "dibatalkan" : null]
                  .filter(Boolean)
                  .join(" · ")}
                right={rupiah(s.total)}
                onClick={() => openSale(app, s.id)}
              />
            ))}
          </Section>
          {data.hasMore ? (
            <button class="btn block" onClick={() => setPage((p) => p + 1)} disabled={loading}>
              {loading ? "Memuat…" : "Muat lagi"}
            </button>
          ) : null}
        </>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------

function CommonFields({
  channel,
  setChannel,
  accountId,
  setAccountId,
  tanggal,
  setTanggal,
  note,
  setNote,
}: {
  channel: string;
  setChannel: (v: string) => void;
  accountId: number;
  setAccountId: (v: number) => void;
  tanggal: string;
  setTanggal: (v: string) => void;
  note: string;
  setNote: (v: string) => void;
}) {
  const { meta } = useApp();
  return (
    <>
      <Field label="Channel">
        <Chips wrap options={meta.channels.map((c) => ({ value: c.code, label: c.name }))} value={channel} onChange={setChannel} />
      </Field>
      <Field label="Uang masuk ke">
        <Chips wrap options={meta.accounts.map((a) => ({ value: a.id, label: a.name }))} value={accountId} onChange={setAccountId} />
      </Field>
      <Field label="Tanggal">
        <input type="date" value={tanggal} max={meta.today} onInput={(e) => setTanggal(e.currentTarget.value)} />
      </Field>
      <Field label="Catatan (opsional)">
        <input type="text" maxLength={200} value={note} placeholder="mis. nama pembeli" onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
    </>
  );
}

function QuickSaleForm() {
  const app = useApp();
  const { meta, isAdmin } = app;
  const [uid] = useState(newUid);
  const [omzet, setOmzet] = useState(0);
  const [hpp, setHpp] = useState(0);
  const [channel, setChannel] = useState("offline");
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? 0);
  const [tanggal, setTanggal] = useState(meta.today);
  const [note, setNote] = useState("");
  const { busy, run } = useSaver();

  const save = () =>
    run(async () => {
      const s = await api.createSale({
        uid,
        tanggal,
        channel,
        items: [{ item_name: "Penjualan cepat", qty: 1, sell_price: omzet, cost_price: hpp }],
        discount: 0,
        account_id: accountId,
        note: note.trim() || null,
      });
      app.bump();
      await app.reloadMeta();
      app.pop();
      app.toast(`${s.invoice_no} tersimpan`);
    }, "Penjualan tersimpan");

  return (
    <div class="form">
      <Field label="Omzet (uang diterima)">
        <MoneyInput value={omzet} onChange={setOmzet} autoFocus />
      </Field>
      <Field label="HPP / modal barang" hint={hpp === 0 ? "Kosongkan kalau tidak tahu, tapi laba akan terlihat = omzet." : undefined}>
        <MoneyInput value={hpp} onChange={setHpp} />
      </Field>
      {isAdmin && omzet > 0 ? (
        <p class="preview">
          Laba kotor <b class={omzet - hpp < 0 ? "neg" : "pos"}>{rupiah(omzet - hpp)}</b>
        </p>
      ) : null}
      <CommonFields {...{ channel, setChannel, accountId, setAccountId, tanggal, setTanggal, note, setNote }} />
      <PrimaryAction text={omzet > 0 ? `Simpan ${rupiah(omzet)}` : "Simpan"} onClick={save} disabled={omzet <= 0 || !accountId} busy={busy} />
    </div>
  );
}

interface CartLine {
  product: Product;
  qty: number;
  price: number;
}

function CartForm() {
  const app = useApp();
  const { meta, isAdmin } = app;
  const [uid] = useState(newUid);
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<CartLine[]>([]);
  const [discount, setDiscount] = useState(0);
  const [channel, setChannel] = useState("offline");
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? 0);
  const [tanggal, setTanggal] = useState(meta.today);
  const [note, setNote] = useState("");
  const { busy, run } = useSaver();
  const products = useAsync(() => api.products(), []);

  const filtered = useMemo(() => {
    const all = products.data ?? [];
    const s = q.trim().toLowerCase();
    return (s ? all.filter((p) => p.name.toLowerCase().includes(s)) : all).slice(0, 30);
  }, [products.data, q]);

  const subtotal = lines.reduce((n, l) => n + l.qty * l.price, 0);
  const hpp = lines.reduce((n, l) => n + l.qty * (l.product.cost_price ?? 0), 0);
  const total = subtotal - discount;

  function add(p: Product) {
    setLines((ls) => {
      const i = ls.findIndex((l) => l.product.id === p.id);
      if (i >= 0) return ls.map((l, n) => (n === i ? { ...l, qty: l.qty + 1 } : l));
      return [...ls, { product: p, qty: 1, price: p.sell_price }];
    });
  }
  function setQty(id: number, qty: number) {
    setLines((ls) => (qty <= 0 ? ls.filter((l) => l.product.id !== id) : ls.map((l) => (l.product.id === id ? { ...l, qty } : l))));
  }

  const save = () =>
    run(async () => {
      const s = await api.createSale({
        uid,
        tanggal,
        channel,
        items: lines.map((l) => ({ product_id: l.product.id, qty: l.qty, ...(l.price !== l.product.sell_price ? { sell_price: l.price } : {}) })),
        discount,
        account_id: accountId,
        note: note.trim() || null,
      });
      app.bump();
      await app.reloadMeta();
      app.pop();
      if (s.warnings?.length) app.toast(s.warnings.join(" "), "err");
    }, "Penjualan tersimpan");

  if (products.loading && !products.data) return <Loading />;
  if (products.error) return <ErrorBox message={products.error} onRetry={products.reload} />;
  if (!products.data?.length) {
    return (
      <Empty>
        Belum ada produk.{app.isAdmin ? " Tambahkan dulu di menu Produk," : ""} atau pakai Penjualan cepat.
      </Empty>
    );
  }

  return (
    <div class="form">
      <Field label="Cari produk">
        <input type="search" value={q} placeholder="ketik nama produk" onInput={(e) => setQ(e.currentTarget.value)} />
      </Field>
      <div class="pick">
        {filtered.map((p) => (
          <button type="button" class="pick-item" onClick={() => add(p)}>
            <span>{p.name}</span>
            <small>{rupiah(p.sell_price)}</small>
          </button>
        ))}
        {filtered.length === 0 ? <span class="muted">Tidak ada yang cocok.</span> : null}
      </div>

      {lines.length ? (
        <Section title="Keranjang">
          {lines.map((l) => (
            <div class="line">
              <div class="line-head">
                <b>{l.product.name}</b>
                <span>{rupiah(l.qty * l.price)}</span>
              </div>
              <div class="line-ctl">
                <div class="stepper">
                  <button type="button" aria-label="Kurangi" onClick={() => setQty(l.product.id, l.qty - 1)}>
                    −
                  </button>
                  <input
                    inputMode="numeric"
                    value={l.qty}
                    aria-label="Jumlah"
                    onInput={(e) => setQty(l.product.id, Math.max(0, Number(e.currentTarget.value.replace(/\D/g, "")) || 0))}
                  />
                  <button type="button" aria-label="Tambah" onClick={() => setQty(l.product.id, l.qty + 1)}>
                    +
                  </button>
                </div>
                <span class="muted">×</span>
                <MoneyInput value={l.price} onChange={(v) => setLines((ls) => ls.map((x) => (x.product.id === l.product.id ? { ...x, price: v } : x)))} />
              </div>
            </div>
          ))}
          <div class="line-sum">
            <Row left="Subtotal" right={rupiah(subtotal)} />
            <div class="row">
              <div class="row-main">
                <div class="row-title">Diskon</div>
              </div>
              <div class="row-right narrow">
                <MoneyInput value={discount} onChange={setDiscount} />
              </div>
            </div>
            <Row left={<b>Total</b>} right={<b>{rupiah(total)}</b>} />
            {isAdmin ? <Row left="Laba kotor" right={rupiah(total - hpp)} rightClass={total - hpp < 0 ? "neg" : "pos"} /> : null}
          </div>
        </Section>
      ) : (
        <p class="muted center">Ketuk produk di atas untuk menambah ke keranjang.</p>
      )}
      {discount > subtotal ? <p class="warn">Diskon melebihi subtotal.</p> : null}

      <CommonFields {...{ channel, setChannel, accountId, setAccountId, tanggal, setTanggal, note, setNote }} />
      <PrimaryAction text={lines.length ? `Simpan ${rupiah(total)}` : "Simpan"} onClick={save} disabled={!lines.length || discount > subtotal || !accountId} busy={busy} />
    </div>
  );
}

function SaleDetail({ id }: { id: number }) {
  const app = useApp();
  const { data: s, error, loading, reload } = useAsync(() => api.getSale(id), [id]);
  const { busy, run } = useSaver();
  if (loading && !s) return <Loading />;
  if (error || !s) return <ErrorBox message={error ?? "Tidak ditemukan"} onRetry={reload} />;
  const hpp = s.total_cost;
  return (
    <div class="form">
      <div class="hero">
        <span class="muted">{s.invoice_no}</span>
        <span class="hero-amount">{rupiah(s.total)}</span>
        {s.status === "void" ? <span class="badge">Dibatalkan{s.void_reason ? `: ${s.void_reason}` : ""}</span> : null}
      </div>
      <Section title="Item">
        {(s.items ?? []).map((i) => (
          <Row left={i.item_name} sub={`${i.qty} × ${rupiah(i.sell_price)}`} right={rupiah(i.line_total)} />
        ))}
        {s.discount > 0 ? <Row left="Diskon" right={`−${rupiah(s.discount)}`} /> : null}
        <Row left={<b>Total</b>} right={<b>{rupiah(s.total)}</b>} />
        {hpp !== undefined ? (
          <>
            <Row left="HPP" right={rupiah(hpp)} />
            <Row left="Laba kotor" right={rupiah(s.total - hpp)} rightClass={s.total - hpp < 0 ? "neg" : "pos"} />
          </>
        ) : null}
      </Section>
      <Section>
        <Row left="Tanggal" right={hariTgl(s.tanggal)} />
        <Row left="Channel" right={channelLabel(app.meta.channels, s.channel)} />
        {s.note ? <Row left="Catatan" right={s.note} /> : null}
      </Section>
      {s.status === "posted" ? (
        <button
          class="btn danger block"
          disabled={busy}
          onClick={async () => {
            if (!(await confirmDialog(`Batalkan ${s.invoice_no}? Kas penjualannya ikut dibatalkan.`))) return;
            await run(async () => {
              await api.voidSale(s.id);
              app.bump();
              await app.reloadMeta();
              app.pop();
            }, "Penjualan dibatalkan");
          }}
        >
          Batalkan penjualan
        </button>
      ) : null}
    </div>
  );
}
