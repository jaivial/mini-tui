import adapter from "@sveltejs/adapter-static";
import { vitePreprocess } from "@sveltejs/vite-plugin-svelte";

// Every route is prerendered to static HTML: no server, no hydration needed to read the page, and
// crawlers get the full content.
//
// The base path is the path of the canonical URL (VITE_SITE_URL), never a separate setting: a site whose
// canonical says /mini-tui/ but whose links point at / is broken in both directions. GitHub Pages serves
// a project site under /<repo>, a custom domain serves from the root.
const SITE_URL = process.env.VITE_SITE_URL ?? "https://jaivial.github.io/mini-tui";
const base = new URL(SITE_URL).pathname.replace(/\/$/, "");
/** @type {import('@sveltejs/kit').Config} */
export default {
  preprocess: vitePreprocess(),
  kit: {
    adapter: adapter({ pages: "build", assets: "build", fallback: undefined, precompress: true, strict: true }),
    paths: { base, relative: false },
    prerender: { handleHttpError: "fail", handleMissingId: "fail", handleUnseenRoutes: "fail" },
    alias: { $content: "src/content" },
  },
};
