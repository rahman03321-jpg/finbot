import type { Transformer } from "grammy/web";
import { env, reset } from "cloudflare:test";
import { afterEach, beforeEach } from "vitest";
import { migrate } from "../worker/db/migrate";

export interface ApiCall {
  method: string;
  payload: Record<string, unknown>;
}

export const BOT_INFO = {
  id: 999,
  is_bot: true as const,
  first_name: "Finbot Test",
  username: "finbot_test_bot",
  can_join_groups: true,
  can_read_all_group_messages: false,
  supports_inline_queries: false,
  can_connect_to_business: false,
  has_main_web_app: false,
  has_topics_enabled: false,
  allows_users_to_create_topics: false,
};

/** Transformer grammY yang mencatat panggilan & mengembalikan respons palsu, tanpa jaringan. */
export function mockTelegram(overrides: Record<string, (payload: Record<string, unknown>) => unknown> = {}) {
  const calls: ApiCall[] = [];
  const transformer: Transformer = async (_prev, method, payload) => {
    const p = (payload ?? {}) as Record<string, unknown>;
    calls.push({ method, payload: p });
    const custom = overrides[method];
    if (custom) {
      const r = custom(p);
      if (r instanceof Error) {
        return { ok: false, error_code: 400, description: r.message } as never;
      }
      return { ok: true, result: r } as never;
    }
    if (method === "getMe") return { ok: true, result: BOT_INFO } as never;
    if (method === "sendMessage") {
      return { ok: true, result: { message_id: calls.length, date: 0, chat: { id: p["chat_id"], type: "private" }, text: p["text"] } } as never;
    }
    return { ok: true, result: true } as never;
  };
  return { calls, transformer, replies: () => calls.filter((c) => c.method === "sendMessage").map((c) => String(c.payload["text"])) };
}

/** Pasang DB bersih (migrasi penuh) untuk tiap test. */
export function useFreshDb(): void {
  beforeEach(async () => {
    await migrate(env.DB);
  });
  afterEach(async () => {
    await reset();
  });
}

let nextUpdateId = 1;

export const GROUP_ID = -100123;

/** Pesan di grup (chat id negatif). */
export function groupMessage(fromId: number, text: string, firstName = "Budi") {
  const cmd = text.split(" ")[0]!;
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: GROUP_ID, type: "supergroup", title: "Toko" },
      from: { id: fromId, is_bot: false, first_name: firstName },
      text,
      ...(text.startsWith("/") ? { entities: [{ type: "bot_command", offset: 0, length: cmd.length }] } : {}),
    },
  };
}

/** Tombol ditekan di pesan bot dalam grup. */
export function groupCallback(fromId: number, data: string, firstName = "Budi") {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId),
      chat_instance: "ci",
      data,
      from: { id: fromId, is_bot: false, first_name: firstName },
      message: {
        message_id: 1,
        date: Math.floor(Date.now() / 1000),
        chat: { id: GROUP_ID, type: "supergroup", title: "Toko" },
        from: { id: 999, is_bot: true, first_name: "Finbot Test" },
        text: "",
      },
    },
  };
}

/** Update callback_query (tombol inline ditekan) pada pesan bot `messageId`. */
export function callbackQuery(fromId: number, data: string, messageText = "", messageId = 1, firstName = "Budi") {
  return {
    update_id: nextUpdateId++,
    callback_query: {
      id: String(nextUpdateId),
      chat_instance: "ci",
      data,
      from: { id: fromId, is_bot: false, first_name: firstName },
      message: {
        message_id: messageId,
        date: Math.floor(Date.now() / 1000),
        chat: { id: fromId, type: "private", first_name: firstName },
        from: { id: 999, is_bot: true, first_name: "Finbot Test" },
        text: messageText,
      },
    },
  };
}

/** Ambil semua callback_data dari reply_markup sebuah panggilan API. */
export function buttonsOf(payload: Record<string, unknown>): { text: string; data: string }[] {
  const markup = payload["reply_markup"] as { inline_keyboard?: { text: string; callback_data?: string }[][] } | undefined;
  return (markup?.inline_keyboard ?? []).flat().map((b) => ({ text: b.text, data: b.callback_data ?? "" }));
}

export function privateMessage(fromId: number, text: string, firstName = "Budi") {
  const entities = text.startsWith("/") ? [{ type: "bot_command", offset: 0, length: text.split(" ")[0]!.length }] : undefined;
  return {
    update_id: nextUpdateId++,
    message: {
      message_id: nextUpdateId,
      date: Math.floor(Date.now() / 1000),
      chat: { id: fromId, type: "private", first_name: firstName },
      from: { id: fromId, is_bot: false, first_name: firstName, username: firstName.toLowerCase() },
      text,
      ...(entities ? { entities } : {}),
    },
  };
}
