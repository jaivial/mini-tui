import { defineConfig } from "vite";
import { svelte } from "@sveltejs/vite-plugin-svelte";
import tailwindcss from "@tailwindcss/vite";

const API = process.env.MINITUI_WEB_API ?? "http://127.0.0.1:4317";

export default defineConfig({
  plugins: [tailwindcss(), svelte()],
  server: {
    port: 4318,
    host: "127.0.0.1",
    proxy: {
      "/api": { target: API, changeOrigin: true, ws: true },
    },
  },
  build: {
    outDir: "dist",
    emptyOutDir: true,
    // Fonts and images stay files. Vite's default (4096) inlines anything smaller as a
    // base64 data: URI, and it inlined the 2 KB JetBrains cyrillic-ext subset into the
    // render-blocking stylesheet: 2.5 KB of gzip the browser had to download before the
    // first paint, for a script this app never renders. A separate file is only fetched
    // when something actually uses it, which is the behaviour we want for a font subset.
    assetsInlineLimit: 0,
  },
});
