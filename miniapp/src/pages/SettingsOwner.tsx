/** Bagian Pengaturan khusus owner: nama usaha, laporan otomatis, user & undangan. */
import { useState } from "preact/hooks";
import { api, type AppSettings, type UserRow } from "../api";
import { haptic, shareLink } from "../tg";
import { Chips, Empty, ErrorBox, Field, Loading, PrimaryAction, Row, Section, useApp, useAsync, useSaver, type AppCtx } from "../ui";

const ROLE_LABEL = { owner: "Owner", admin: "Admin", staff: "Staff" } as const;
const ROLE_HINT = {
  admin: "Input transaksi, kelola produk & pengaturan, lihat HPP/laba & laporan.",
  staff: "Input transaksi saja. Tidak melihat HPP, laba, saldo, maupun laporan.",
} as const;

export function OwnerSections() {
  const app = useApp();
  const s = useAsync(() => api.settings(), [app.version]);
  const users = useAsync(() => api.users(), [app.version]);

  return (
    <>
      {s.loading && !s.data ? <Loading /> : s.error ? <ErrorBox message={s.error} onRetry={s.reload} /> : s.data ? <BusinessAndReports settings={s.data} /> : null}

      <Section
        title="User"
        action={
          <button class="link" onClick={() => openInvite(app)}>
            + Undang
          </button>
        }
      >
        {users.loading && !users.data ? (
          <Loading />
        ) : users.error ? (
          <ErrorBox message={users.error} onRetry={users.reload} />
        ) : !users.data?.length ? (
          <Empty>Belum ada user.</Empty>
        ) : (
          users.data.map((u) => (
            <Row
              strike={!u.is_active}
              left={u.full_name}
              sub={[u.username ? `@${u.username}` : null, ROLE_LABEL[u.role], u.is_active ? null : "nonaktif"].filter(Boolean).join(" · ")}
              onClick={u.role === "owner" ? undefined : () => openUserForm(app, u)}
            />
          ))
        )}
      </Section>
    </>
  );
}

function BusinessAndReports({ settings }: { settings: AppSettings }) {
  const app = useApp();
  const { busy, run } = useSaver();
  const save = (patch: Parameters<typeof api.updateSettings>[0], msg: string) =>
    run(async () => {
      await api.updateSettings(patch);
      await app.reloadMeta();
      app.bump();
    }, msg);

  const target = settings.report_target.type === "group" ? `Grup "${settings.report_target.title ?? ""}"` : "Chat pribadi owner";

  return (
    <>
      <Section title="Usaha">
        <Row left="Nama usaha" right={settings.business_name} onClick={() => openBusinessName(app, settings.business_name)} />
        <Toggle
          label="Modul stok"
          sub="Stok berkurang saat terjual, restock dengan HPP rata-rata, peringatan stok menipis"
          on={settings.feature_stock}
          disabled={busy}
          onChange={(v) => save({ feature_stock: v }, v ? "Modul stok aktif. Isi stok awal lewat Produk → Stok → Stok opname." : "Modul stok dimatikan (data stok tetap tersimpan)")}
        />
      </Section>

      <Section title="Laporan otomatis">
        <Toggle label="Harian" sub="Ringkasan hari ini" on={settings.daily_report_enabled} disabled={busy} onChange={(v) => save({ daily_report_enabled: v }, v ? "Laporan harian aktif" : "Laporan harian mati")} />
        <Toggle label="Mingguan" sub="Tiap Senin, minggu lalu + perbandingan" on={settings.weekly_report_enabled} disabled={busy} onChange={(v) => save({ weekly_report_enabled: v }, v ? "Laporan mingguan aktif" : "Laporan mingguan mati")} />
        <Toggle label="Bulanan" sub="Tiap tanggal 1, bulan lalu + PDF" on={settings.monthly_report_enabled} disabled={busy} onChange={(v) => save({ monthly_report_enabled: v }, v ? "Laporan bulanan aktif" : "Laporan bulanan mati")} />
        <div class="row">
          <div class="row-main">
            <div class="row-title">Jam kirim (WIB)</div>
          </div>
          <select
            class="select"
            value={String(settings.report_hour)}
            disabled={busy}
            aria-label="Jam kirim laporan"
            onChange={(e) => save({ report_hour: Number(e.currentTarget.value) }, "Jam laporan disimpan")}
          >
            {Array.from({ length: 24 }, (_, h) => (
              <option value={h}>{`${String(h).padStart(2, "0")}.00`}</option>
            ))}
          </select>
        </div>
        <Row
          left="Dikirim ke"
          sub={settings.report_target.type === "group" ? "HPP & laba disembunyikan di grup" : "Lengkap dengan HPP & laba"}
          right={target}
        />
        {settings.report_target.type === "group" ? (
          <div class="pad">
            <button class="btn block" disabled={busy} onClick={() => save({ report_target: "owner" }, "Laporan dikirim ke chat pribadi")}>
              Kirim ke chat pribadi saja
            </button>
          </div>
        ) : null}
      </Section>
      <p class="footnote">Untuk mengirim laporan ke grup: masukkan bot ke grup, lalu ketik /jadwal grup di grup itu.</p>
    </>
  );
}

function Toggle({ label, sub, on, disabled, onChange }: { label: string; sub: string; on: boolean; disabled?: boolean; onChange: (v: boolean) => void }) {
  return (
    <label class="row toggle-row">
      <div class="row-main">
        <div class="row-title">{label}</div>
        <div class="row-sub">{sub}</div>
      </div>
      <input type="checkbox" role="switch" class="switch" checked={on} disabled={disabled} onChange={(e) => onChange(e.currentTarget.checked)} />
    </label>
  );
}

// ---------------------------------------------------------------------------

function openBusinessName(app: AppCtx, current: string): void {
  app.push({ key: `bizname-${Date.now()}`, title: "Nama usaha", render: () => <BusinessNameForm current={current} /> });
}

function BusinessNameForm({ current }: { current: string }) {
  const app = useApp();
  const [name, setName] = useState(current);
  const { busy, run } = useSaver();
  return (
    <div class="form">
      <Field label="Nama usaha" hint="Tampil di Beranda, laporan bot, dan judul PDF.">
        <input type="text" maxLength={60} value={name} onInput={(e) => setName(e.currentTarget.value)} />
      </Field>
      <PrimaryAction
        text="Simpan"
        disabled={!name.trim() || name.trim() === current}
        busy={busy}
        onClick={() =>
          run(async () => {
            await api.updateSettings({ business_name: name.trim() });
            await app.reloadMeta();
            app.bump();
            app.pop();
          }, "Nama usaha disimpan")
        }
      />
    </div>
  );
}

function openInvite(app: AppCtx): void {
  app.push({ key: `invite-${Date.now()}`, title: "Undang user", render: () => <InviteForm /> });
}

function InviteForm() {
  const app = useApp();
  const [role, setRole] = useState<"staff" | "admin">("staff");
  const [link, setLink] = useState<string | null>(null);
  const { busy, run } = useSaver();

  return (
    <div class="form">
      <Field label="Peran" hint={ROLE_HINT[role]}>
        <Chips
          options={[
            { value: "staff", label: "Staff" },
            { value: "admin", label: "Admin" },
          ]}
          value={role}
          onChange={(v) => {
            setRole(v);
            setLink(null);
          }}
        />
      </Field>
      {link ? (
        <>
          <Section title="Tautan undangan">
            <div class="pad mono">{link}</div>
          </Section>
          <p class="footnote">Sekali pakai, berlaku 24 jam. Orang yang membuka tautan ini lalu menekan Start langsung terdaftar sebagai {ROLE_LABEL[role]}.</p>
          <button
            class="btn primary block"
            onClick={async () => {
              const r = await shareLink(link, `Kamu diundang sebagai ${ROLE_LABEL[role]} di ${app.meta.business_name}. Buka tautan ini lalu tekan Start:`);
              haptic("success");
              if (r === "copied") app.toast("Tautan disalin");
              else if (r === "failed") app.toast("Salin tautan di atas secara manual", "err");
            }}
          >
            Kirim tautan
          </button>
        </>
      ) : (
        <PrimaryAction
          text="Buat tautan undangan"
          busy={busy}
          onClick={() =>
            run(async () => {
              const r = await api.invite(role);
              setLink(r.link);
            }, "Tautan dibuat")
          }
        />
      )}
    </div>
  );
}

function openUserForm(app: AppCtx, user: UserRow): void {
  app.push({ key: `user-${user.id}-${Date.now()}`, title: user.full_name, render: () => <UserForm user={user} /> });
}

function UserForm({ user }: { user: UserRow }) {
  const app = useApp();
  const [role, setRole] = useState<"staff" | "admin">(user.role === "admin" ? "admin" : "staff");
  const { busy, run } = useSaver();
  const done = async () => {
    app.bump();
    app.pop();
  };
  return (
    <div class="form">
      <Section>
        <Row left="Nama" right={user.full_name} />
        {user.username ? <Row left="Username" right={`@${user.username}`} /> : null}
        <Row left="Status" right={user.is_active ? "Aktif" : "Nonaktif"} rightClass={user.is_active ? "pos" : "neg"} />
      </Section>
      <Field label="Peran" hint={ROLE_HINT[role]}>
        <Chips
          options={[
            { value: "staff", label: "Staff" },
            { value: "admin", label: "Admin" },
          ]}
          value={role}
          onChange={setRole}
        />
      </Field>
      <button
        class={user.is_active ? "btn danger block" : "btn block"}
        disabled={busy}
        onClick={() =>
          run(async () => {
            await api.updateUser(user.id, { is_active: !user.is_active });
            await done();
          }, user.is_active ? "User dinonaktifkan" : "User diaktifkan")
        }
      >
        {user.is_active ? "Nonaktifkan (tidak bisa memakai bot & aplikasi)" : "Aktifkan lagi"}
      </button>
      <PrimaryAction
        text="Simpan peran"
        disabled={role === user.role}
        busy={busy}
        onClick={() =>
          run(async () => {
            await api.updateUser(user.id, { role });
            await done();
          }, "Peran disimpan")
        }
      />
    </div>
  );
}
