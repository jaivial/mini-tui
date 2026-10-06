// What the web app ships, and what a cold visit downloads before it can paint.
//
//   bun run build && bun scripts/bundle-report.mjs
//
// Sizes are what vite left in web/dist; the gzip column is measured here, the way the build
// prints it (that is what actually travels). The "before first paint" half walks the chunk
// graph: the entry index.html loads, the static chunks it pulls in, and the one chunk
// main.ts awaits before mounting (App.svelte). A chunk reachable only through a dynamic
// `import()` further down (the terminal, its xterm.js) is listed as deferred instead.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { join } from "node:path";

const dist = join(import.meta.dir, "..", "dist");
if (!existsSync(join(dist, "index.html"))) {
  console.error("no web/dist build: run `bun run build` first");
  process.exit(1);
}
const assets = join(dist, "assets");
const size = {};
for (const name of readdirSync(assets)) size[name] = statSync(join(assets, name)).size;
const gz = (name) => (/\.(js|css)$/.test(name) ? gzipSync(readFileSync(join(assets, name))).length : 0);
const kb = (n) => `${(n / 1024).toFixed(1)} kB`;

const js = Object.keys(size).filter((n) => n.endsWith(".js")).sort((a, b) => size[b] - size[a]);
const css = Object.keys(size).filter((n) => n.endsWith(".css")).sort((a, b) => size[b] - size[a]);
console.log("== javascript");
for (const n of js) console.log(`  ${String(size[n]).padStart(8)}  ${kb(gz(n)).padStart(9)} gz  ${n}`);
console.log("== css");
for (const n of css) console.log(`  ${String(size[n]).padStart(8)}  ${kb(gz(n)).padStart(9)} gz  ${n}`);
console.log(`== JS total ${kb(js.reduce((a, n) => a + size[n], 0))} (${kb(js.reduce((a, n) => a + gz(n), 0))} gzip)`);

const html = readFileSync(join(dist, "index.html"), "utf8");
const entry = [...html.matchAll(/src="\/assets\/([^"]+\.js)"/g)].map((m) => m[1]);
const statics = {}, dynamics = {};
for (const n of js) {
  const code = readFileSync(join(assets, n), "utf8");
  statics[n] = [...code.matchAll(/from"\.\/([^"]+\.js)"/g)].map((m) => m[1]);
  dynamics[n] = [...code.matchAll(/import\(`?\.\/([^`"]+\.js)`?\)/g)].map((m) => m[1]);
}
// The entry, everything it imports statically, and what it awaits before mounting.
const boot = new Set();
const walk = (n) => {
  if (boot.has(n)) return;
  boot.add(n);
  for (const dep of statics[n] ?? []) walk(dep);
};
for (const n of entry) walk(n);
for (const n of [...boot]) for (const dep of dynamics[n] ?? []) walk(dep);
const deferred = js.filter((n) => !boot.has(n));
// A css file is requested with the chunk that declares it: vite appends `.css` to the chunk name.
const cssOf = (chunks) => chunks.map((n) => n.replace(/\.js$/, ".css")).filter((n) => size[n] !== undefined);

console.log(`== before first paint (static graph of ${entry.join(", ")}, App.svelte included)`);
for (const n of [...boot].sort((a, b) => size[b] - size[a])) console.log(`  ${String(size[n]).padStart(8)}  ${kb(gz(n)).padStart(9)} gz  ${n}`);
for (const n of cssOf([...boot]).sort((a, b) => size[b] - size[a])) console.log(`  ${String(size[n]).padStart(8)}  ${kb(gz(n)).padStart(9)} gz  ${n}`);
const bootJs = [...boot].reduce((a, n) => a + size[n], 0);
const bootCss = cssOf([...boot]).reduce((a, n) => a + size[n], 0);
console.log(`== JS before first paint ${kb(bootJs)} (${kb([...boot].reduce((a, n) => a + gz(n), 0))} gzip) + CSS ${kb(bootCss)}${bootCss ? "" : " (none: it is in the page’s stylesheet)"}`);
console.log(`== deferred until used: ${deferred.map((n) => `${n} ${kb(size[n])}`).join(", ") || "nothing"}`);
