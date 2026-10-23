import react from "@vitejs/plugin-react";
import { fileURLToPath } from "node:url";
import { defineConfig } from "vitest/config";

// In the desktop app, Wave is called from the native side (no browser CORS). In the
// browser build used for development, Vite proxies the same path to Wave.
export default defineConfig({
  plugins: [react()],
  resolve: {
    // csv-parse's default build needs Node's Buffer; its browser build bundles one.
    alias: { "csv-parse/sync": fileURLToPath(new URL("../../node_modules/csv-parse/dist/esm/sync.js", import.meta.url)) },
  },
  clearScreen: false,
  server: {
    port: 5317,
    strictPort: true,
    proxy: { "/wave-graphql": { target: "https://gql.waveapps.com", changeOrigin: true, rewrite: () => "/graphql/public" } },
    fs: { allow: ["../.."] },
  },
  worker: { format: "es" },
  // No inlining: the app's content security policy only allows fetching its own files.
  build: { target: "es2022", outDir: "dist", assetsInlineLimit: 0 },
  test: { environment: "jsdom", setupFiles: ["./test/setup.ts"] },
});
