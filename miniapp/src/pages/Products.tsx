import { useMemo, useState } from "preact/hooks";
import { api, type Product } from "../api";
import { pct, rupiah } from "../format";
import { Empty, ErrorBox, Field, Loading, MoneyInput, PrimaryAction, Row, Section, Segmented, useApp, useAsync, useSaver, type AppCtx } from "../ui";
import { StockView } from "./Stock";
import { confirmDialog } from "../tg";

function openProductForm(app: AppCtx, product?: Product): void {
  app.push({ key: `product-${product?.id ?? "new"}-${Date.now()}`, title: product ? "Ubah produk" : "Produk baru", render: () => <ProductForm product={product} /> });
}

export function ProductsPage() {
  const app = useApp();
  const stockOn = app.meta.features.stock;
  const [view, setView] = useState<"products" | "stock">("products");

  return (
    <div>
      <header class="page-head row-head">
        <h1>{view === "stock" ? "Stok" : "Produk"}</h1>
        {app.isAdmin && view === "products" ? (
          <button class="btn primary small" onClick={() => openProductForm(app)}>
            + Produk
          </button>
        ) : null}
      </header>
      {stockOn ? (
        <div class="filters">
          <Segmented
            options={[
              { value: "products", label: "Produk" },
              { value: "stock", label: "Stok" },
            ]}
            value={view}
            onChange={setView}
          />
        </div>
      ) : null}
      {view === "stock" && stockOn ? <StockView /> : <ProductList />}
    </div>
  );
}

function ProductList() {
  const app = useApp();
  const stockOn = app.meta.features.stock;
  const [q, setQ] = useState("");
  const { data, error, loading, reload } = useAsync(() => api.products(), [app.version]);
  const list = useMemo(() => {
    const s = q.trim().toLowerCase();
    return (data ?? []).filter((p) => !s || p.name.toLowerCase().includes(s));
  }, [data, q]);

  return (
    <>
      <div class="filters">
        <input type="search" value={q} placeholder="Cari produk" onInput={(e) => setQ(e.currentTarget.value)} />
      </div>
      {loading && !data ? (
        <Loading />
      ) : error ? (
        <ErrorBox message={error} onRetry={reload} />
      ) : !list.length ? (
        <Empty>{data?.length ? "Tidak ada yang cocok." : "Belum ada produk. Penjualan tanpa produk bisa dicatat lewat Penjualan cepat."}</Empty>
      ) : (
        <Section title={`${list.length} produk`}>
          {list.map((p) => {
            const parts = [
              p.cost_price !== undefined ? `HPP ${rupiah(p.cost_price)} · margin ${pct(p.sell_price - p.cost_price, p.sell_price)}` : null,
              stockOn && p.track_stock ? `stok ${p.stock}` : null,
            ].filter(Boolean);
            return <Row left={p.name} sub={parts.join(" · ") || undefined} right={rupiah(p.sell_price)} onClick={app.isAdmin ? () => openProductForm(app, p) : undefined} />;
          })}
        </Section>
      )}
    </>
  );
}

function ProductForm({ product }: { product?: Product }) {
  const app = useApp();
  const stockOn = app.meta.features.stock;
  const [name, setName] = useState(product?.name ?? "");
  const [cost, setCost] = useState(product?.cost_price ?? 0);
  const [sell, setSell] = useState(product?.sell_price ?? 0);
  const [unit, setUnit] = useState(product?.unit ?? "pcs");
  const [track, setTrack] = useState(product ? !!product.track_stock : true);
  const [minStock, setMinStock] = useState(String(product?.min_stock ?? 0));
  const [opening, setOpening] = useState("0");
  const { busy, run } = useSaver();
  const margin = sell - cost;
  const num = (s: string) => Math.max(0, Number(s.replace(/\D/g, "")) || 0);

  const save = () =>
    run(async () => {
      const base = { name: name.trim(), cost_price: cost, sell_price: sell, unit: unit.trim() || "pcs", ...(stockOn ? { track_stock: track, min_stock: num(minStock) } : {}) };
      if (product) await api.updateProduct(product.id, base);
      else await api.createProduct({ ...base, ...(stockOn && track && num(opening) > 0 ? { opening_stock: num(opening) } : {}) });
      app.bump();
      app.pop();
    }, product ? "Produk diperbarui" : "Produk ditambahkan");

  return (
    <div class="form">
      <Field label="Nama produk">
        <input type="text" maxLength={80} value={name} placeholder="mis. Salep Kulit 30g" onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      <Field label="HPP / modal per unit" hint={stockOn && product ? "Diperbarui otomatis saat restock (rata-rata)." : undefined}>
        <MoneyInput value={cost} onChange={setCost} />
      </Field>
      <Field label="Harga jual">
        <MoneyInput value={sell} onChange={setSell} />
      </Field>
      {sell > 0 ? (
        <p class="preview">
          Untung per unit <b class={margin < 0 ? "neg" : "pos"}>{rupiah(margin)}</b> · margin {pct(margin, sell)}
        </p>
      ) : null}
      <Field label="Satuan">
        <input type="text" maxLength={20} value={unit} placeholder="pcs, botol, kg" onInput={(e) => setUnit(e.currentTarget.value)} />
      </Field>
      {stockOn ? (
        <Section title="Stok">
          <label class="row toggle-row">
            <div class="row-main">
              <div class="row-title">Lacak stok</div>
              <div class="row-sub">Matikan untuk jasa / produk tanpa stok</div>
            </div>
            <input type="checkbox" role="switch" class="switch" checked={track} onChange={(e) => setTrack(e.currentTarget.checked)} />
          </label>
          {track ? (
            <>
              <div class="row">
                <div class="row-main">
                  <div class="row-title">Stok minimum</div>
                  <div class="row-sub">Peringatan bila stok ≤ angka ini</div>
                </div>
                <input class="num-input" inputMode="numeric" aria-label="Stok minimum" value={minStock} onInput={(e) => setMinStock(e.currentTarget.value.replace(/\D/g, ""))} />
              </div>
              {!product ? (
                <div class="row">
                  <div class="row-main">
                    <div class="row-title">Stok awal</div>
                    <div class="row-sub">Jumlah yang ada sekarang</div>
                  </div>
                  <input class="num-input" inputMode="numeric" aria-label="Stok awal" value={opening} onInput={(e) => setOpening(e.currentTarget.value.replace(/\D/g, ""))} />
                </div>
              ) : null}
            </>
          ) : null}
        </Section>
      ) : null}
      {product ? <p class="footnote">Mengubah harga tidak mengubah penjualan yang sudah tercatat.{stockOn ? " Ubah jumlah stok lewat Stok → Stok opname." : ""}</p> : null}
      {product ? (
        <button
          class="btn danger block"
          disabled={busy}
          onClick={async () => {
            if (!(await confirmDialog(`Hapus produk "${product.name}"? Penjualan lama tetap tercatat.`))) return;
            await run(async () => {
              await api.deleteProduct(product.id);
              app.bump();
              app.pop();
            }, "Produk dihapus");
          }}
        >
          Hapus produk
        </button>
      ) : null}
      <PrimaryAction text="Simpan" onClick={save} disabled={!name.trim() || sell <= 0} busy={busy} />
    </div>
  );
}
