import { defineConfig } from "vite";

// Dijalankan dari root proyek (lihat script npm), jadi path relatif terhadap root.
export default defineConfig({
  root: "miniapp",
  oxc: { jsx: { runtime: "automatic", importSource: "preact" } },
  build: { outDir: "dist", emptyOutDir: true, target: "es2020" },
  server: {
    // `npm run dev:miniapp` meneruskan /api ke wrangler dev
    proxy: { "/api": "http://127.0.0.1:8787" },
  },
});
