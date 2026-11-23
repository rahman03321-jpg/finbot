/** Pembungkus tipis Telegram.WebApp. Semua aman dipanggil di luar Telegram (no-op). */

interface TgButton {
  setText(t: string): TgButton;
  show(): TgButton;
  hide(): TgButton;
  enable(): TgButton;
  disable(): TgButton;
  showProgress(leaveActive?: boolean): TgButton;
  hideProgress(): TgButton;
  onClick(cb: () => void): TgButton;
  offClick(cb: () => void): TgButton;
}

interface TgWebApp {
  initData: string;
  initDataUnsafe: { user?: { id: number; first_name: string } };
  platform: string;
  colorScheme: "light" | "dark";
  ready(): void;
  expand(): void;
  isVersionAtLeast(v: string): boolean;
  MainButton: TgButton;
  BackButton: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { notificationOccurred(t: "success" | "error" | "warning"): void; selectionChanged(): void };
  showConfirm?(msg: string, cb: (ok: boolean) => void): void;
  openTelegramLink?(url: string): void;
  close(): void;
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TgWebApp };
    TelegramWebviewProxy?: unknown;
  }
}

export const tg: TgWebApp | undefined = window.Telegram?.WebApp;

/** Benar-benar berjalan di dalam klien Telegram (punya MainButton/BackButton asli). */
export const inTelegramClient: boolean =
  !!tg && tg.platform !== "unknown" && (window.TelegramWebviewProxy !== undefined || window.parent !== window);

export function initData(): string {
  return tg?.initData ?? "";
}

export function haptic(kind: "success" | "error" | "warning" | "select"): void {
  try {
    if (kind === "select") tg?.HapticFeedback?.selectionChanged();
    else tg?.HapticFeedback?.notificationOccurred(kind);
  } catch {
    /* klien lama */
  }
}

export function confirmDialog(message: string): Promise<boolean> {
  if (inTelegramClient && tg?.showConfirm && tg.isVersionAtLeast("6.2")) {
    return new Promise((resolve) => tg.showConfirm!(message, resolve));
  }
  return Promise.resolve(window.confirm(message));
}

/** Bagikan teks/tautan lewat pemilih chat Telegram; di luar Telegram salin ke clipboard. */
export async function shareLink(url: string, text: string): Promise<"shared" | "copied" | "failed"> {
  const share = `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
  if (inTelegramClient && tg?.openTelegramLink) {
    tg.openTelegramLink(share);
    return "shared";
  }
  try {
    await navigator.clipboard.writeText(url);
    return "copied";
  } catch {
    return "failed";
  }
}
