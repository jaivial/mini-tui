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
  build: { outDir: "dist", emptyOutDir: true },
});
