import type { Context, MiddlewareHandler } from "hono";
import { Api } from "grammy/web";
import type { z } from "zod";
import type { Env } from "../../env";
import { AppError } from "../../lib/errors";
import { parsePeriod, type Period } from "../../lib/date";
import { redactFor } from "../../auth/redact";
import { verifySession } from "../../auth/session";
import { getSessionSecret } from "../../services/settings";
import { getActiveUserById, type User } from "../../services/users";
import type { Actor } from "../../services/cash";

export type ApiEnv = { Bindings: Env; Variables: { user: User; actor: Actor } };
export type ApiContext = Context<ApiEnv>;

/** Respons sukses. Data SELALU melewati redactFor (staff tidak menerima HPP/laba). */
export function ok<T>(c: ApiContext, data: T, status: 200 | 201 = 200): Response {
  return c.json({ ok: true, data: redactFor(c.var.user.role, data) }, status);
}

function zodMessage(err: z.ZodError): string {
  const first = err.issues[0];
  if (!first) return "Data tidak valid.";
  const path = first.path.join(".");
  return path ? `${path}: ${first.message}` : first.message;
}

export async function parseBody<S extends z.ZodType>(c: Context, schema: S): Promise<z.infer<S>> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    throw new AppError("INVALID_JSON", "Body harus JSON.", 400);
  }
  const r = schema.safeParse(raw);
  if (!r.success) throw new AppError("VALIDATION", zodMessage(r.error), 400);
  return r.data;
}

export function parseQuery<S extends z.ZodType>(c: Context, schema: S): z.infer<S> {
  const r = schema.safeParse(c.req.query());
  if (!r.success) throw new AppError("VALIDATION", zodMessage(r.error), 400);
  return r.data;
}

export function requireAdmin(c: ApiContext): void {
  const role = c.var.user.role;
  if (role !== "owner" && role !== "admin") throw new AppError("FORBIDDEN", "Hanya owner/admin.", 403);
}

export function requireOwner(c: ApiContext): void {
  if (c.var.user.role !== "owner") throw new AppError("FORBIDDEN", "Hanya owner.", 403);
}

/** `?period=` atau `?from=&to=`; default bulan ini. */
export function resolvePeriod(q: { period?: string | undefined; from?: string | undefined; to?: string | undefined }, fallback = "bulan"): Period {
  const text = q.from ? `${q.from} ${q.to ?? q.from}` : (q.period ?? fallback);
  const p = parsePeriod(text);
  if (!p) throw new AppError("INVALID_PERIOD", "Periode tidak dikenali atau lebih dari 366 hari.", 400);
  return p;
}

/** Middleware: Authorization: Bearer <token> → c.var.user (dibaca ulang dari DB) & c.var.actor. */
export const requireSession: MiddlewareHandler<ApiEnv> = async (c, next) => {
  const header = c.req.header("Authorization") ?? "";
  const token = header.startsWith("Bearer ") ? header.slice(7) : "";
  if (!token) throw new AppError("UNAUTHORIZED", "Sesi berakhir. Buka ulang aplikasi dari bot.", 401);
  const userId = await verifySession(token, await getSessionSecret(c.env));
  const user = await getActiveUserById(c.env.DB, userId);
  if (!user) throw new AppError("UNAUTHORIZED", "Akun kamu tidak aktif. Hubungi owner.", 401);
  c.set("user", user);
  c.set("actor", { id: user.id, role: user.role });
  await next();
};

/** Pabrik klien Bot API; bisa diganti di test agar tidak memanggil api.telegram.org. */
let apiFactory: (token: string) => Api = (token) => new Api(token);
export function telegramApi(env: Env): Api {
  return apiFactory(env.BOT_TOKEN);
}
export function setTelegramApiFactory(f: (token: string) => Api): void {
  apiFactory = f;
}
