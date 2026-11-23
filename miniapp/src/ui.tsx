/** Komponen & hook bersama. */
import { createContext, type ComponentChildren, type JSX } from "preact";
import { useCallback, useContext, useEffect, useRef, useState } from "preact/hooks";
import type { Meta } from "./api";
import { ApiError } from "./api";
import { haptic, inTelegramClient, tg } from "./tg";
import { rupiahShort, thousands, tglPendek } from "./format";

// ---------------------------------------------------------------------------
// Konteks aplikasi
// ---------------------------------------------------------------------------

export interface Screen {
  key: string;
  title: string;
  render: () => JSX.Element;
}

export interface AppCtx {
  meta: Meta;
  isAdmin: boolean;
  push(s: Screen): void;
  pop(): void;
  toast(msg: string, kind?: "ok" | "err"): void;
  /** Naik setiap ada data tersimpan → daftar memuat ulang. */
  version: number;
  bump(): void;
  reloadMeta(): Promise<void>;
}

export const Ctx = createContext<AppCtx | null>(null);

export function useApp(): AppCtx {
  const c = useContext(Ctx);
  if (!c) throw new Error("AppCtx belum tersedia");
  return c;
}

// ---------------------------------------------------------------------------
// Data async
// ---------------------------------------------------------------------------

export function errorText(e: unknown): string {
  return e instanceof ApiError ? e.message : "Terjadi kesalahan. Coba lagi.";
}

export function useAsync<T>(fn: () => Promise<T>, deps: unknown[]): { data: T | null; error: string | null; loading: boolean; reload: () => void } {
  const [state, setState] = useState<{ data: T | null; error: string | null; loading: boolean }>({ data: null, error: null, loading: true });
  const [tick, setTick] = useState(0);
  useEffect(() => {
    let alive = true;
    setState((s) => ({ ...s, loading: true, error: null }));
    fn().then(
      (data) => alive && setState({ data, error: null, loading: false }),
      (e: unknown) => alive && setState({ data: null, error: errorText(e), loading: false }),
    );
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, tick]);
  return { ...state, reload: () => setTick((t) => t + 1) };
}

// ---------------------------------------------------------------------------
// Tombol utama: MainButton Telegram bila tersedia, tombol biasa bila tidak
// ---------------------------------------------------------------------------

export function PrimaryAction({ text, onClick, disabled, busy }: { text: string; onClick: () => void; disabled?: boolean; busy?: boolean }) {
  const cb = useRef(onClick);
  cb.current = onClick;

  useEffect(() => {
    const w = tg;
    if (!inTelegramClient || !w) return;
    const handler = () => cb.current();
    w.MainButton.setText(text).show();
    w.MainButton.onClick(handler);
    return () => {
      w.MainButton.offClick(handler);
      w.MainButton.hideProgress();
      w.MainButton.hide();
    };
  }, [text]);

  useEffect(() => {
    if (!inTelegramClient || !tg) return;
    if (busy) tg.MainButton.showProgress(false);
    else tg.MainButton.hideProgress();
    if (disabled || busy) tg.MainButton.disable();
    else tg.MainButton.enable();
  }, [disabled, busy]);

  if (inTelegramClient) return null;
  return (
    <div class="primary-bar">
      <button class="btn primary block" disabled={disabled || busy} onClick={onClick}>
        {busy ? "Menyimpan…" : text}
      </button>
    </div>
  );
}

/** Jalankan aksi simpan dengan status sibuk, haptic, dan toast. */
export function useSaver(): { busy: boolean; run: (fn: () => Promise<void>, okMsg: string) => Promise<void> } {
  const { toast } = useApp();
  const [busy, setBusy] = useState(false);
  const run = useCallback(
    async (fn: () => Promise<void>, okMsg: string) => {
      if (busy) return;
      setBusy(true);
      try {
        await fn();
        haptic("success");
        toast(okMsg);
      } catch (e) {
        haptic("error");
        toast(errorText(e), "err");
      } finally {
        setBusy(false);
      }
    },
    [busy, toast],
  );
  return { busy, run };
}

// ---------------------------------------------------------------------------
// Input
// ---------------------------------------------------------------------------

/** Input rupiah: keyboard angka, titik ribuan saat diketik, nilai integer. */
export function MoneyInput({ value, onChange, placeholder, autoFocus, id }: { value: number; onChange: (v: number) => void; placeholder?: string; autoFocus?: boolean; id?: string }) {
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (autoFocus) setTimeout(() => ref.current?.focus(), 200);
  }, [autoFocus]);
  return (
    <div class="money">
      <span class="money-prefix">Rp</span>
      <input
        id={id}
        ref={ref}
        inputMode="numeric"
        autoComplete="off"
        placeholder={placeholder ?? "0"}
        value={value ? thousands(value) : ""}
        onInput={(e) => {
          const digits = (e.currentTarget.value || "").replace(/\D/g, "").slice(0, 13);
          const n = digits ? Number(digits) : 0;
          onChange(n);
          e.currentTarget.value = n ? thousands(n) : "";
        }}
      />
    </div>
  );
}

export function Field({ label, children, hint }: { label: string; children: ComponentChildren; hint?: ComponentChildren }) {
  return (
    <label class="field">
      <span class="field-label">{label}</span>
      {children}
      {hint ? <span class="field-hint">{hint}</span> : null}
    </label>
  );
}

export function Chips<T extends string | number>({ options, value, onChange, wrap }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void; wrap?: boolean }) {
  return (
    <div class={wrap ? "chips wrap" : "chips"} role="radiogroup">
      {options.map((o) => (
        <button
          type="button"
          role="radio"
          aria-checked={o.value === value}
          class={o.value === value ? "chip on" : "chip"}
          onClick={() => {
            haptic("select");
            onChange(o.value);
          }}
        >
          {o.label}
        </button>
      ))}
    </div>
  );
}

export function Segmented<T extends string>({ options, value, onChange }: { options: { value: T; label: string }[]; value: T; onChange: (v: T) => void }) {
  return (
    <div class="segmented" role="tablist">
      {options.map((o) => (
        <button type="button" role="tab" aria-selected={o.value === value} class={o.value === value ? "on" : ""} onClick={() => onChange(o.value)}>
          {o.label}
        </button>
      ))}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Tampilan
// ---------------------------------------------------------------------------

export function Loading() {
  return (
    <div class="state">
      <div class="spinner" aria-label="Memuat" />
    </div>
  );
}

export function ErrorBox({ message, onRetry }: { message: string; onRetry?: () => void }) {
  return (
    <div class="state">
      <p class="err-text">{message}</p>
      {onRetry ? (
        <button class="btn" onClick={onRetry}>
          Coba lagi
        </button>
      ) : null}
    </div>
  );
}

export function Empty({ children }: { children: ComponentChildren }) {
  return <div class="state muted">{children}</div>;
}

export function Section({ title, action, children }: { title?: string; action?: ComponentChildren; children: ComponentChildren }) {
  return (
    <section class="section">
      {title ? (
        <div class="section-head">
          <h2>{title}</h2>
          {action}
        </div>
      ) : null}
      <div class="card">{children}</div>
    </section>
  );
}

export function Row({ left, sub, right, rightClass, onClick, strike }: { left: ComponentChildren; sub?: ComponentChildren; right?: ComponentChildren; rightClass?: string; onClick?: () => void; strike?: boolean }) {
  const Tag = onClick ? "button" : "div";
  return (
    <Tag class={`row${onClick ? " tappable" : ""}${strike ? " strike" : ""}`} onClick={onClick} type={onClick ? "button" : undefined}>
      <div class="row-main">
        <div class="row-title">{left}</div>
        {sub ? <div class="row-sub">{sub}</div> : null}
      </div>
      {right !== undefined ? <div class={`row-right ${rightClass ?? ""}`}>{right}</div> : null}
    </Tag>
  );
}

/** Grafik batang SVG sederhana. Nilai negatif digambar ke bawah garis nol. */
export function BarChart({ data, label }: { data: { tanggal: string; value: number }[]; label: string }) {
  const W = 320;
  const H = 120;
  const max = Math.max(1, ...data.map((d) => Math.abs(d.value)));
  const hasNeg = data.some((d) => d.value < 0);
  const zero = hasNeg ? H / 2 : H - 2;
  const scale = (hasNeg ? H / 2 - 4 : H - 6) / max;
  const bw = W / data.length;
  const peak = data.reduce((a, b) => (b.value > a.value ? b : a), data[0] ?? { tanggal: "", value: 0 });
  return (
    <figure class="chart">
      <svg viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label} preserveAspectRatio="none">
        <line x1="0" x2={W} y1={zero} y2={zero} class="chart-axis" />
        {data.map((d, i) => {
          const h = Math.max(d.value === 0 ? 0 : 1.5, Math.abs(d.value) * scale);
          const y = d.value >= 0 ? zero - h : zero;
          return (
            <rect x={i * bw + bw * 0.15} y={y} width={bw * 0.7} height={h} rx="1.5" class={d.value < 0 ? "bar neg" : "bar"}>
              <title>{`${tglPendek(d.tanggal)}: ${rupiahShort(d.value)}`}</title>
            </rect>
          );
        })}
      </svg>
      <figcaption class="chart-cap">
        <span>{data[0] ? tglPendek(data[0].tanggal) : ""}</span>
        <span>tertinggi {peak.value > 0 ? `${rupiahShort(peak.value)} (${tglPendek(peak.tanggal)})` : "–"}</span>
        <span>{data.length ? tglPendek(data[data.length - 1]!.tanggal) : ""}</span>
      </figcaption>
    </figure>
  );
}
