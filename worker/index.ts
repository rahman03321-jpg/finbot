import { Hono } from "hono";
import type { Env } from "./env";
import { AppError } from "./lib/errors";
import { setupRoutes } from "./routes/setup";
import { webhookRoutes } from "./routes/webhook";
import { apiRoutes } from "./routes/api";
import { telegramApi } from "./routes/api/util";
import { runScheduled } from "./bot/scheduled";

const app = new Hono<{ Bindings: Env }>();

app.route("/", setupRoutes);
app.route("/", webhookRoutes);
app.route("/api", apiRoutes);

app.all("/api/*", (c) => c.json({ ok: false, error: { code: "NOT_FOUND", message: "Endpoint tidak ditemukan." } }, 404));

// Selain rute di atas: file statis Mini App.
app.all("*", (c) => c.env.ASSETS.fetch(c.req.raw));

app.onError((err, c) => {
  if (err instanceof AppError) {
    return c.json({ ok: false, error: { code: err.code, message: err.message } }, err.status as 400);
  }
  console.error(err);
  return c.json({ ok: false, error: { code: "INTERNAL", message: "Terjadi kesalahan di server." } }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(controller, env, ctx) {
    ctx.waitUntil(
      runScheduled(env, telegramApi(env), new Date(controller.scheduledTime)).catch((e: unknown) => {
        // Sebelum /setup pertama tabel belum ada; jangan sampai cron error terus.
        console.warn("cron dilewati", e);
      }),
    );
  },
} satisfies ExportedHandler<Env>;
