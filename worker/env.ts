export interface Env {
  DB: D1Database;
  ASSETS: Fetcher;
  APP_VERSION: string;
  BOT_TOKEN: string;
  SETUP_KEY?: string;
  WEBHOOK_SECRET?: string;
  SESSION_SECRET?: string;
}
