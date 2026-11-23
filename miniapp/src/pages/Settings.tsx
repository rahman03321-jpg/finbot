/** Pengaturan: (owner) usaha, laporan otomatis, user; kategori kas, akun kas, channel penjualan. */
import { useState } from "preact/hooks";
import { api, type Account, type Category, type CategoryKind, type Channel, type Direction } from "../api";
import { rupiah } from "../format";
import { confirmDialog } from "../tg";
import { OwnerSections } from "./SettingsOwner";
import { Chips, Field, MoneyInput, PrimaryAction, Row, Section, Segmented, useApp, useSaver, type AppCtx } from "../ui";

export function openSettings(app: AppCtx): void {
  app.push({ key: `settings-${Date.now()}`, title: "Pengaturan", render: () => <SettingsPage /> });
}

const KIND_LABEL: Record<CategoryKind, string> = {
  other_income: "Pendapatan lain",
  capital_in: "Modal / pinjaman masuk",
  expense: "Biaya operasional",
  stock_purchase: "Belanja stok",
  capital_out: "Prive / bayar pinjaman",
  sales: "Penjualan",
  transfer: "Transfer",
};
const KIND_HINT: Record<CategoryKind, string> = {
  other_income: "Masuk laba rugi sebagai pendapatan lain.",
  capital_in: "Tidak masuk laba rugi (bukan pendapatan).",
  expense: "Masuk laba rugi sebagai biaya.",
  stock_purchase: "Tidak masuk laba rugi (sudah dihitung lewat HPP).",
  capital_out: "Tidak masuk laba rugi (uang pemilik / pokok utang).",
  sales: "",
  transfer: "",
};
const KINDS: Record<Direction, CategoryKind[]> = { in: ["other_income", "capital_in"], out: ["expense", "stock_purchase", "capital_out"] };

const TYPE_LABEL: Record<Account["type"], string> = { cash: "Tunai", bank: "Bank", ewallet: "E-wallet", marketplace: "Saldo marketplace" };

function SettingsPage() {
  const app = useApp();
  const { meta } = app;
  const isOwner = meta.user.role === "owner";
  const [dir, setDir] = useState<Direction>("out");
  const cats = meta.categories.filter((c) => c.direction === dir && c.kind !== "sales" && c.kind !== "transfer");

  return (
    <div>
      {isOwner ? <OwnerSections /> : null}
      <Section
        title="Kategori kas"
        action={
          <button class="link" onClick={() => openCategoryForm(app, dir)}>
            + Tambah
          </button>
        }
      >
        <div class="pad">
          <Segmented
            options={[
              { value: "out", label: "Keluar" },
              { value: "in", label: "Masuk" },
            ]}
            value={dir}
            onChange={setDir}
          />
        </div>
        {cats.map((c) => (
          <Row left={c.name} sub={`${KIND_LABEL[c.kind]}${c.is_system ? " · bawaan" : ""}`} onClick={() => openCategoryForm(app, dir, c)} />
        ))}
      </Section>

      <Section
        title="Akun kas / rekening"
        action={
          isOwner ? (
            <button class="link" onClick={() => openAccountForm(app)}>
              + Tambah
            </button>
          ) : undefined
        }
      >
        {meta.accounts.map((a) => (
          <Row
            left={a.name}
            sub={`${TYPE_LABEL[a.type]}${a.opening_balance ? ` · saldo awal ${rupiah(a.opening_balance)}` : ""}`}
            right={a.balance !== undefined ? rupiah(a.balance) : undefined}
            rightClass={(a.balance ?? 0) < 0 ? "neg" : ""}
            onClick={isOwner ? () => openAccountForm(app, a) : undefined}
          />
        ))}
      </Section>
      {!isOwner ? <p class="footnote">Akun kas hanya bisa diubah oleh owner.</p> : null}

      <Section
        title="Channel penjualan"
        action={
          <button class="link" onClick={() => openChannelForm(app)}>
            + Tambah
          </button>
        }
      >
        {meta.channels.map((ch) => (
          <Row left={ch.name} sub={ch.is_system ? "bawaan" : undefined} onClick={() => openChannelForm(app, ch)} />
        ))}
      </Section>
      <p class="footnote">Menghapus tidak mengubah transaksi lama; datanya tetap ada di laporan.</p>
    </div>
  );
}

// ---------------------------------------------------------------------------

function DeleteButton({ label, confirm, onDelete }: { label: string; confirm: string; onDelete: () => Promise<void> }) {
  const app = useApp();
  const { busy, run } = useSaver();
  return (
    <button
      class="btn danger block"
      disabled={busy}
      onClick={async () => {
        if (!(await confirmDialog(confirm))) return;
        await run(async () => {
          await onDelete();
          await app.reloadMeta();
          app.pop();
        }, "Dihapus");
      }}
    >
      {label}
    </button>
  );
}

function openCategoryForm(app: AppCtx, direction: Direction, category?: Category): void {
  app.push({
    key: `cat-${category?.id ?? "new"}-${Date.now()}`,
    title: category ? "Ubah kategori" : direction === "in" ? "Kategori masuk baru" : "Kategori keluar baru",
    render: () => <CategoryForm direction={direction} category={category} />,
  });
}

function CategoryForm({ direction, category }: { direction: Direction; category?: Category }) {
  const app = useApp();
  const [name, setName] = useState(category?.name ?? "");
  const [kind, setKind] = useState<CategoryKind>(category?.kind ?? KINDS[direction][0]!);
  const { busy, run } = useSaver();
  const locked = !!category?.is_system;

  const save = () =>
    run(async () => {
      if (category) await api.updateCategory(category.id, { name: name.trim(), ...(locked ? {} : { kind }) });
      else await api.createCategory({ name: name.trim(), direction, kind });
      await app.reloadMeta();
      app.bump();
      app.pop();
    }, category ? "Kategori diperbarui" : "Kategori ditambahkan");

  return (
    <div class="form">
      <Field label="Nama kategori">
        <input type="text" maxLength={40} value={name} placeholder={direction === "out" ? "mis. Sewa tempat" : "mis. Komisi affiliate"} onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      <Field label="Jenis" hint={locked ? "Jenis kategori bawaan tidak bisa diubah." : KIND_HINT[kind]}>
        {locked ? (
          <div class="readonly">{KIND_LABEL[kind]}</div>
        ) : (
          <Chips wrap options={KINDS[direction].map((k) => ({ value: k, label: KIND_LABEL[k] }))} value={kind} onChange={setKind} />
        )}
      </Field>
      {category && !locked && kind !== category.kind ? <p class="warn">Mengganti jenis juga mengubah laporan periode lalu yang memakai kategori ini.</p> : null}
      {category && !locked ? (
        <DeleteButton label="Hapus kategori" confirm={`Hapus kategori "${category.name}"? Transaksi lama tetap tersimpan.`} onDelete={() => api.deleteCategory(category.id).then(() => undefined)} />
      ) : null}
      <PrimaryAction text="Simpan" onClick={save} disabled={!name.trim()} busy={busy} />
    </div>
  );
}

function openAccountForm(app: AppCtx, account?: Account): void {
  app.push({ key: `acc-${account?.id ?? "new"}-${Date.now()}`, title: account ? "Ubah akun kas" : "Akun kas baru", render: () => <AccountForm account={account} /> });
}

function AccountForm({ account }: { account?: Account }) {
  const app = useApp();
  const [name, setName] = useState(account?.name ?? "");
  const [type, setType] = useState<Account["type"]>(account?.type ?? "bank");
  const [opening, setOpening] = useState(Math.abs(account?.opening_balance ?? 0));
  const [negative, setNegative] = useState((account?.opening_balance ?? 0) < 0);
  const { busy, run } = useSaver();
  const openingValue = negative ? -opening : opening;

  const save = () =>
    run(async () => {
      if (account) await api.updateAccount(account.id, { name: name.trim(), type, opening_balance: openingValue });
      else await api.createAccount({ name: name.trim(), type, opening_balance: openingValue });
      await app.reloadMeta();
      app.bump();
      app.pop();
    }, account ? "Akun diperbarui" : "Akun ditambahkan");

  return (
    <div class="form">
      <Field label="Nama">
        <input type="text" maxLength={40} value={name} placeholder="mis. BCA, Dana, Saldo Shopee" onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      <Field label="Tipe">
        <Chips wrap options={(Object.keys(TYPE_LABEL) as Account["type"][]).map((t) => ({ value: t, label: TYPE_LABEL[t] }))} value={type} onChange={setType} />
      </Field>
      <Field label="Saldo awal" hint="Saldo saat mulai memakai aplikasi, sebelum transaksi pertama dicatat.">
        <MoneyInput value={opening} onChange={setOpening} />
      </Field>
      <label class="check">
        <input type="checkbox" checked={negative} onChange={(e) => setNegative(e.currentTarget.checked)} /> Saldo awal minus (mis. kartu kredit / utang)
      </label>
      {account && openingValue !== (account.opening_balance ?? 0) ? (
        <p class="warn">Mengubah saldo awal menggeser saldo akun ini di semua laporan sebesar {rupiah(openingValue - (account.opening_balance ?? 0))}.</p>
      ) : null}
      {account ? (
        <DeleteButton
          label="Hapus akun"
          confirm={`Hapus akun "${account.name}"? Hanya bisa bila saldonya 0. Transaksi lama tetap tersimpan.`}
          onDelete={() => api.deleteAccount(account.id).then(() => undefined)}
        />
      ) : null}
      <PrimaryAction text="Simpan" onClick={save} disabled={!name.trim()} busy={busy} />
    </div>
  );
}

function openChannelForm(app: AppCtx, channel?: Channel): void {
  app.push({ key: `ch-${channel?.id ?? "new"}-${Date.now()}`, title: channel ? "Ubah channel" : "Channel baru", render: () => <ChannelForm channel={channel} /> });
}

function ChannelForm({ channel }: { channel?: Channel }) {
  const app = useApp();
  const [name, setName] = useState(channel?.name ?? "");
  const { busy, run } = useSaver();
  const save = () =>
    run(async () => {
      if (channel) await api.updateChannel(channel.id, name.trim());
      else await api.createChannel(name.trim());
      await app.reloadMeta();
      app.bump();
      app.pop();
    }, channel ? "Channel diperbarui" : "Channel ditambahkan");
  return (
    <div class="form">
      <Field label="Nama channel" hint="Di bot, tulis nama channel tanpa spasi, mis. /omzet 100rb pasarpagi">
        <input type="text" maxLength={30} value={name} placeholder="mis. Pasar Pagi, Reseller" onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      {channel && !channel.is_system ? (
        <DeleteButton label="Hapus channel" confirm={`Hapus channel "${channel.name}"? Penjualan lama tetap tersimpan.`} onDelete={() => api.deleteChannel(channel.id).then(() => undefined)} />
      ) : null}
      <PrimaryAction text="Simpan" onClick={save} disabled={!name.trim()} busy={busy} />
    </div>
  );
}
