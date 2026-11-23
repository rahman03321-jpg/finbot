import { useCallback, useEffect, useMemo, useRef, useState } from "preact/hooks";
import { api, ApiError, login, type Meta } from "./api";
import { initData, inTelegramClient, tg } from "./tg";
import { Ctx, ErrorBox, Loading, type AppCtx, type Screen } from "./ui";
import { Home } from "./pages/Home";
import { CashPage } from "./pages/Cash";
import { SalesPage } from "./pages/Sales";
import { ProductsPage } from "./pages/Products";
import { ReportsPage } from "./pages/Reports";

type Tab = "home" | "cash" | "sales" | "products" | "reports";

const TABS: { key: Tab; label: string; icon: string; admin?: boolean }[] = [
  { key: "home", label: "Beranda", icon: "M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z" },
  { key: "sales", label: "Jual", icon: "M4 5h16l-1.5 9H6L4 5zm2 13a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0zm9 0a1.5 1.5 0 1 0 3 0 1.5 1.5 0 0 0-3 0z" },
  { key: "cash", label: "Kas", icon: "M3 7h18v12H3zM3 7l3-3h12l3 3M16 13h2" },
  { key: "products", label: "Produk", icon: "M4 8l8-4 8 4v8l-8 4-8-4zM4 8l8 4 8-4M12 12v8" },
  { key: "reports", label: "Laporan", icon: "M5 20V10M12 20V4M19 20v-7", admin: true },
];

type Boot = { state: "loading" } | { state: "ready"; meta: Meta } | { state: "error"; message: string; code?: string };

export function App() {
  const [boot, setBoot] = useState<Boot>({ state: "loading" });
  const [tab, setTab] = useState<Tab>("home");
  const [stack, setStack] = useState<Screen[]>([]);
  const [version, setVersion] = useState(0);
  const [toastMsg, setToastMsg] = useState<{ text: string; kind: "ok" | "err"; id: number } | null>(null);
  const toastTimer = useRef<number>();

  const start = useCallback(async () => {
    const data = initData();
    if (!data) {
      setBoot({ state: "error", code: "NO_TELEGRAM", message: "Buka aplikasi ini dari bot Telegram kamu (tombol menu atau perintah /app)." });
      return;
    }
    setBoot({ state: "loading" });
    try {
      await login(data);
      setBoot({ state: "ready", meta: await api.meta() });
    } catch (e) {
      setBoot({ state: "error", message: e instanceof ApiError ? e.message : "Gagal terhubung ke server.", code: e instanceof ApiError ? e.code : undefined });
    }
  }, []);

  useEffect(() => {
    tg?.ready();
    tg?.expand();
    void start();
  }, [start]);

  // Tombol Back Telegram mengikuti tumpukan layar
  const pop = useCallback(() => setStack((s) => s.slice(0, -1)), []);
  useEffect(() => {
    const w = tg;
    if (!inTelegramClient || !w) return;
    if (stack.length) {
      w.BackButton.show();
      w.BackButton.onClick(pop);
      return () => w.BackButton.offClick(pop);
    }
    w.BackButton.hide();
  }, [stack.length, pop]);

  const toast = useCallback((text: string, kind: "ok" | "err" = "ok") => {
    window.clearTimeout(toastTimer.current);
    setToastMsg({ text, kind, id: Date.now() });
    toastTimer.current = window.setTimeout(() => setToastMsg(null), kind === "err" ? 4000 : 2200);
  }, []);

  const ctx = useMemo<AppCtx | null>(() => {
    if (boot.state !== "ready") return null;
    return {
      meta: boot.meta,
      isAdmin: boot.meta.user.role !== "staff",
      push: (s) => setStack((st) => [...st, s]),
      pop,
      toast,
      version,
      bump: () => setVersion((v) => v + 1),
      reloadMeta: async () => {
        const meta = await api.meta();
        setBoot({ state: "ready", meta });
      },
    };
  }, [boot, pop, toast, version]);

  if (boot.state === "loading") return <Loading />;
  if (boot.state === "error" || !ctx) {
    const msg = boot.state === "error" ? boot.message : "";
    return (
      <div class="boot">
        <h1>Catetin</h1>
        <ErrorBox message={msg} onRetry={boot.state === "error" && boot.code !== "NO_TELEGRAM" && boot.code !== "NOT_REGISTERED" ? start : undefined} />
      </div>
    );
  }

  const top = stack[stack.length - 1];
  const tabs = TABS.filter((t) => !t.admin || ctx.isAdmin);

  return (
    <Ctx.Provider value={ctx}>
      {top ? (
        <div class="screen" key={top.key}>
          <header class="screen-head">
            {!inTelegramClient ? (
              <button class="back" onClick={pop} aria-label="Kembali">
                ‹
              </button>
            ) : null}
            <h1>{top.title}</h1>
          </header>
          <main class="screen-body">{top.render()}</main>
        </div>
      ) : (
        <div class="shell">
          <main class="page">
            {tab === "home" && <Home goTo={(t) => setTab(t as Tab)} />}
            {tab === "cash" && <CashPage />}
            {tab === "sales" && <SalesPage />}
            {tab === "products" && <ProductsPage />}
            {tab === "reports" && ctx.isAdmin && <ReportsPage />}
          </main>
          <nav class="tabbar" aria-label="Menu utama">
            {tabs.map((t) => (
              <button class={tab === t.key ? "on" : ""} onClick={() => setTab(t.key)} aria-current={tab === t.key ? "page" : undefined}>
                <svg viewBox="0 0 24 24" aria-hidden="true">
                  <path d={t.icon} />
                </svg>
                <span>{t.label}</span>
              </button>
            ))}
          </nav>
        </div>
      )}
      {toastMsg ? (
        <div class={`toast ${toastMsg.kind}`} role="status" key={toastMsg.id}>
          {toastMsg.text}
        </div>
      ) : null}
    </Ctx.Provider>
  );
}
