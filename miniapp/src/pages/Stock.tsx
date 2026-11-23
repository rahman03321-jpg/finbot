/** Modul stok: daftar stok, restock (pembelian), stok opname, mutasi, riwayat pembelian. */
import { useMemo, useState } from "preact/hooks";
import { api, type Product, type StockMovement, type UpdateCost } from "../api";
import { hariTgl, newUid, PERIOD_LABEL, periodRange, rupiah, tglPendek, type PeriodKey } from "../format";
import { confirmDialog } from "../tg";
import { Chips, Empty, ErrorBox, Field, Loading, MoneyInput, PrimaryAction, Row, Section, useApp, useAsync, useSaver, type AppCtx } from "../ui";

const MOVE_LABEL: Record<StockMovement["type"], string> = {
  sale: "Terjual",
  sale_void: "Batal jual",
  purchase: "Restock",
  purchase_void: "Batal restock",
  adjustment: "Opname",
  opening: "Stok awal",
};

export function StockView() {
  const app = useApp();
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useAsync(() => api.products(), [app.version]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? [])
      .filter((p) => p.track_stock && (!s || p.name.toLowerCase().includes(s)))
      .sort((a, b) => a.stock - a.min_stock - (b.stock - b.min_stock));
  }, [data, q]);
  const low = list.filter((p) => p.stock <= p.min_stock).length;

  return (
    <div>
      {app.isAdmin ? (
        <div class="quick">
          <button class="btn primary" onClick={() => openRestock(app)}>
            + Restock
          </button>
          <button class="btn" onClick={() => openPurchaseList(app)}>
            Riwayat restock
          </button>
        </div>
      ) : null}
      <div class="filters">
        <input type="search" value={q} placeholder="Cari produk" onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : !list.length ? (
        <Empty>Belum ada produk yang dilacak stoknya.</Empty>
      ) : (
        <Section title={low ? `${list.length} produk · ${low} perlu restock` : `${list.length} produk`}>
          {list.map((p) => (
            <Row
              left={p.name}
              sub={p.stock <= 0 ? "habis" : p.stock <= p.min_stock ? `menipis · min ${p.min_stock}` : p.min_stock ? `min ${p.min_stock}` : undefined}
              right={`${p.stock} ${p.unit}`}
              rightClass={p.stock <= 0 ? "neg" : p.stock <= p.min_stock ? "warn-text" : ""}
              onClick={() => app.push({ key: `stock-${p.id}`, title: p.name, render: () => <StockDetail productId={p.id} /> })}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function StockDetail({ productId }: { productId: number }) {
  const app = useApp();
  const products = useAsync(() => api.products(), [app.version]);
  const moves = useAsync(() => (app.isAdmin ? api.movements(productId) : Promise.resolve([])), [productId, app.version]);
  const p = products.data?.find((x) => x.id === productId);
  if (products.loading && !products.data) return <Loading />;
  if (!p) return <ErrorBox message="Produk tidak ditemukan." />;
  return (
    <div class="form">
      <div class="hero">
        <span class="muted">Stok sekarang</span>
        <span class={`hero-amount ${p.stock <= 0 ? "neg" : ""}`}>
          {p.stock} {p.unit}
        </span>
        {p.min_stock ? <span class="muted">minimum {p.min_stock}</span> : null}
      </div>
      {app.isAdmin ? (
        <div class="quick">
          <button class="btn primary" onClick={() => openRestock(app, p)}>
            + Restock
          </button>
          <button class="btn" onClick={() => app.push({ key: `opname-${p.id}-${Date.now()}`, title: "Stok opname", render: () => <OpnameForm product={p} /> })}>
            Stok opname
          </button>
        </div>
      ) : null}
      {app.isAdmin ? (
        <Section title="Mutasi terakhir">
          {moves.loading && !moves.data ? (
            <Loading />
          ) : !moves.data?.length ? (
            <Empty>Belum ada mutasi.</Empty>
          ) : (
            moves.data.map((m) => (
              <Row
                left={MOVE_LABEL[m.type]}
                sub={[tglPendek(m.tanggal), m.note, m.created_by_name].filter(Boolean).join(" · ")}
                right={`${m.qty_change > 0 ? "+" : ""}${m.qty_change}`}
                rightClass={m.qty_change > 0 ? "pos" : "neg"}
              />
            ))
          )}
        </Section>
      ) : null}
    </div>
  );
}

function OpnameForm({ product }: { product: Product }) {
  const app = useApp();
  const [actual, setActual] = useState(String(product.stock));
  const [note, setNote] = useState("");
  const { busy, run } = useSaver();
  const n = Number(actual);
  const valid = actual.trim() !== "" && Number.isInteger(n);
  const diff = valid ? n - product.stock : 0;
  return (
    <div class="form">
      <Field label={`Jumlah fisik sebenarnya (${product.unit})`} hint={`Tercatat ${product.stock}. Selisihnya disimpan sebagai mutasi opname.`}>
        <input type="text" inputMode="numeric" value={actual} onInput={(e) => setActual(e.currentTarget.value.replace(/[^\d-]/g, ""))} />
      </Field>
      {valid && diff !== 0 ? (
        <p class="preview">
          Selisih <b class={diff > 0 ? "pos" : "neg"}>{diff > 0 ? `+${diff}` : diff}</b>
        </p>
      ) : null}
      <Field label="Catatan (opsional)">
        <input type="text" maxLength={200} value={note} placeholder="mis. rusak 2, hitung ulang gudang" onInput={(e) => setNote(e.currentTarget.value)} />
      </Field>
      <PrimaryAction
        text="Simpan stok"
        disabled={!valid || diff === 0}
        busy={busy}
        onClick={() =>
          run(async () => {
            await api.setStock(product.id, n, note.trim() || null);
            app.bump();
            app.pop();
          }, "Stok disimpan")
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Restock
// ---------------------------------------------------------------------------

export function openRestock(app: AppCtx, product?: Product): void {
  app.push({ key: `restock-${Date.now()}`, title: "Restock", render: () => <RestockForm initial={product} /> });
}

interface Line {
  product: Product;
  qty: number;
  cost: number;
}

const UPDATE_COST: { value: UpdateCost; label: string; hint: string }[] = [
  { value: "average", label: "Rata-rata", hint: "HPP baru = rata-rata tertimbang stok lama & pembelian ini (disarankan)." },
  { value: "last", label: "Harga terakhir", hint: "HPP diganti dengan harga beli terakhir." },
  { value: "none", label: "Tidak diubah", hint: "HPP produk tidak berubah." },
];

function RestockForm({ initial }: { initial?: Product }) {
  const app = useApp();
  const { meta } = app;
  const [uid] = useState(newUid);
  const products = useAsync(() => api.products(), []);
  const [q, setQ] = useState("");
  const [lines, setLines] = useState<Line[]>(initial ? [{ product: initial, qty: 1, cost: initial.cost_price ?? 0 }] : []);
  const [supplier, setSupplier] = useState("");
  const [accountId, setAccountId] = useState(meta.accounts[0]?.id ?? 0);
  const [tanggal, setTanggal] = useState(meta.today);
  const [method, setMethod] = useState<UpdateCost>("average");
  const { busy, run } = useSaver();

  const filtered = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (products.data ?? []).filter((p) => !s || p.name.toLowerCase().includes(s)).slice(0, 30);
  }, [products.data, q]);
  const total = lines.reduce((n, l) => n + l.qty * l.cost, 0);
  const account = meta.accounts.find((a) => a.id === accountId);

  const add = (p: Product) =>
    setLines((ls) => (ls.some((l) => l.product.id === p.id) ? ls : [...ls, { product: p, qty: 1, cost: p.cost_price ?? 0 }]));
  const set = (id: number, patch: Partial<Line>) => setLines((ls) => ls.map((l) => (l.product.id === id ? { ...l, ...patch } : l)));

  if (products.loading && !products.data) return <Loading />;
  return (
    <div class="form">
      <Field label="Tambah produk">
        <input type="search" value={q} placeholder="cari produk" onInput={(e) => setQ(e.currentTarget.value)} />
      </Field>
      <div class="pick">
        {filtered.map((p) => (
          <button type="button" class="pick-item" onClick={() => add(p)}>
            <span>{p.name}</span>
            <small>stok {p.stock}</small>
          </button>
        ))}
      </div>

      {lines.length ? (
        <Section title="Dibeli">
          {lines.map((l) => {
            const after = l.product.track_stock && l.product.stock > 0 ? Math.round((l.product.stock * (l.product.cost_price ?? 0) + l.qty * l.cost) / (l.product.stock + l.qty)) : l.cost;
            return (
              <div class="line">
                <div class="line-head">
                  <b>{l.product.name}</b>
                  <button class="link" onClick={() => setLines((ls) => ls.filter((x) => x.product.id !== l.product.id))}>
                    hapus
                  </button>
                </div>
                <div class="line-ctl">
                  <div class="stepper">
                    <button type="button" aria-label="Kurangi" onClick={() => set(l.product.id, { qty: Math.max(1, l.qty - 1) })}>
                      −
                    </button>
                    <input inputMode="numeric" aria-label="Jumlah" value={l.qty} onInput={(e) => set(l.product.id, { qty: Math.max(1, Number(e.currentTarget.value.replace(/\D/g, "")) || 1) })} />
                    <button type="button" aria-label="Tambah" onClick={() => set(l.product.id, { qty: l.qty + 1 })}>
                      +
                    </button>
                  </div>
                  <span class="muted">×</span>
                  <MoneyInput value={l.cost} onChange={(v) => set(l.product.id, { cost: v })} />
                </div>
                <div class="row-sub line-foot">
                  = {rupiah(l.qty * l.cost)}
                  {l.product.track_stock ? ` · stok ${l.product.stock} → ${l.product.stock + l.qty}` : ""}
                  {method === "average" && after !== l.product.cost_price ? ` · HPP ${rupiah(l.product.cost_price ?? 0)} → ${rupiah(after)}` : ""}
                  {method === "last" && l.cost !== l.product.cost_price ? ` · HPP → ${rupiah(l.cost)}` : ""}
                </div>
              </div>
            );
          })}
          <div class="line-sum">
            <Row left={<b>Total</b>} right={<b>{rupiah(total)}</b>} />
          </div>
        </Section>
      ) : (
        <p class="muted center">Ketuk produk di atas untuk menambah.</p>
      )}

      <Field label="Update HPP" hint={UPDATE_COST.find((u) => u.value === method)!.hint}>
        <Chips options={UPDATE_COST.map((u) => ({ value: u.value, label: u.label }))} value={method} onChange={setMethod} />
      </Field>
      <Field label="Dibayar dari">
        <Chips wrap options={meta.accounts.map((a) => ({ value: a.id, label: a.name }))} value={accountId} onChange={setAccountId} />
      </Field>
      {account?.balance !== undefined && total > 0 && account.balance - total < 0 ? <p class="warn">Saldo {account.name} akan jadi {rupiah(account.balance - total)}.</p> : null}
      <Field label="Supplier (opsional)">
        <input type="text" maxLength={80} value={supplier} onInput={(e) => setSupplier(e.currentTarget.value)} />
      </Field>
      <Field label="Tanggal">
        <input type="date" value={tanggal} max={meta.today} onInput={(e) => setTanggal(e.currentTarget.value)} />
      </Field>
      <PrimaryAction
        text={lines.length ? `Simpan ${rupiah(total)}` : "Simpan"}
        disabled={!lines.length || !accountId}
        busy={busy}
        onClick={() =>
          run(async () => {
            const r = await api.createPurchase({
              uid,
              tanggal,
              supplier: supplier.trim() || null,
              items: lines.map((l) => ({ product_id: l.product.id, qty: l.qty, unit_cost: l.cost })),
              account_id: accountId,
              update_cost: method,
              note: null,
            });
            app.bump();
            await app.reloadMeta();
            app.pop();
            if (r.hppChanges?.length) app.toast(`HPP diperbarui: ${r.hppChanges.map((h) => `${h.name} ${rupiah(h.after)}`).join(", ")}`);
          }, "Restock tersimpan")
        }
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Riwayat restock
// ---------------------------------------------------------------------------

function openPurchaseList(app: AppCtx): void {
  app.push({ key: `purchases-${Date.now()}`, title: "Riwayat restock", render: () => <PurchaseList /> });
}

const PERIODS: PeriodKey[] = ["bulan", "bulanlalu", "minggu", "hari"];

function PurchaseList() {
  const app = useApp();
  const [period, setPeriod] = useState<PeriodKey>("bulan");
  const range = periodRange(period, app.meta.today);
  const { data, error, loading, reload } = useAsync(() => api.purchases(range), [period, app.version]);
  return (
    <div>
      <div class="filters">
        <Chips options={PERIODS.map((p) => ({ value: p, label: PERIOD_LABEL[p] }))} value={period} onChange={setPeriod} />
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : !data?.items.length ? (
        <Empty>Belum ada restock di periode ini.</Empty>
      ) : (
        <Section>
          {data.items.map((p) => (
            <Row
              strike={p.status === "void"}
              left={`${p.first_item ?? "-"}${p.item_count > 1 ? ` +${p.item_count - 1}` : ""}`}
              sub={[hariTgl(p.tanggal), p.supplier, p.account_name, p.status === "void" ? "dibatalkan" : null].filter(Boolean).join(" · ")}
              right={rupiah(p.total)}
              onClick={() => app.push({ key: `purchase-${p.id}`, title: "Detail restock", render: () => <PurchaseDetailView id={p.id} /> })}
            />
          ))}
        </Section>
      )}
    </div>
  );
}

function PurchaseDetailView({ id }: { id: number }) {
  const app = useApp();
  const { data: p, error, loading, reload } = useAsync(() => api.getPurchase(id), [id]);
  const { busy, run } = useSaver();
  if (loading && !p) return <Loading />;
  if (error || !p) return <ErrorBox message={error ?? "Tidak ditemukan"} onRetry={reload} />;
  return (
    <div class="form">
      <div class="hero">
        <span class="muted">{hariTgl(p.tanggal)}</span>
        <span class="hero-amount">{rupiah(p.total)}</span>
        {p.status === "void" ? <span class="badge">Dibatalkan{p.void_reason ? `: ${p.void_reason}` : ""}</span> : null}
      </div>
      <Section title="Item">
        {p.items.map((i) => (
          <Row left={i.product_name} sub={`${i.qty} × ${rupiah(i.unit_cost ?? 0)}`} right={rupiah(i.line_total)} />
        ))}
      </Section>
      <Section>
        {p.supplier ? <Row left="Supplier" right={p.supplier} /> : null}
        <Row left="Dibayar dari" right={p.account_name ?? "-"} />
        <Row left="Update HPP" right={UPDATE_COST.find((u) => u.value === p.update_cost)?.label ?? p.update_cost} />
      </Section>
      {p.status === "posted" ? (
        <>
          <p class="footnote">Membatalkan akan mengurangi stok & membatalkan kas keluarnya. HPP produk tidak dihitung ulang otomatis.</p>
          <button
            class="btn danger block"
            disabled={busy}
            onClick={async () => {
              if (!(await confirmDialog("Batalkan restock ini?"))) return;
              await run(async () => {
                const r = await api.voidPurchase(p.id);
                app.bump();
                await app.reloadMeta();
                app.pop();
                if (r.warnings.length) app.toast(r.warnings.join(" "), "err");
              }, "Restock dibatalkan");
            }}
          >
            Batalkan restock
          </button>
        </>
      ) : null}
    </div>
  );
}
