import { defineConfig } from "vitest/config";
import { cloudflareTest } from "@cloudflare/vitest-plugin";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
      miniflare: {
        bindings: {
          BOT_TOKEN: "123456:TEST-TOKEN",
          SETUP_KEY: "kunci-setup-test-123",
        },
      },
    }),
  ],
  test: {
    include: ["test/**/*.test.ts"],
  },
});
