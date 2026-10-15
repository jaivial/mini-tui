#!/usr/bin/env bun
/**
 * Walk a built Vite bundle's STATIC import graph from the entry and report what a
 * cold boot actually downloads. Dynamic import() targets are listed separately: they
 * are code-split and only fetched on demand, so they do not belong in the boot number.
 *
 * Usage: bun bundle-graph.ts <web/dist dir>
 */
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const dist = process.argv[2] ?? "dist";
const assets = join(dist, "assets");

/** Resolve an import specifier as written in the bundle to a file in assets/. */
function resolveFile(spec) {
  const clean = spec.split("?")[0]!.replace(/^\/+/, "");
  const base = clean.includes("/") ? join(dist, clean) : join(assets, clean);
  for (const cand of [base, `${base}.js`, join(assets, `${clean}.js`)]) {
    try {
      if (statSync(cand).isFile()) return cand;
    } catch {}
  }
  return null;
}

/** Static imports: `import ... from "x"` and `export ... from "x"`. */
function staticImports(code) {
  const out = [];
  // Only the `from "x"` form is a STATIC edge. A bare `import "./x.js"` is also static,
  // but `import(` (dynamic, possibly after a `.then`) is NOT — matching it here would
  // count every lazy chunk as boot-critical and hide the win code splitting made.
  const re = /(?:^|[\s;}])(?:import|export)\s+(?:[\w${}*,\s]*?\sfrom\s*)?["']([^"']+)["']/g;
  let m;
  while ((m = re.exec(code))) {
    if (m[1]!.startsWith(".") || m[1]!.startsWith("/")) out.push(m[1]!);
  }
  return out;
}

/** Dynamic imports: import("x") — fetched only when the call runs. */
function dynamicImports(code) {
  const out = [];
  const re = /import\s*\(\s*["']([^"']+)["']\s*\)/g;
  let m;
  while ((m = re.exec(code))) out.push(m[1]!);
  return out;
}

const html = readFileSync(join(dist, "index.html"), "utf8");
const entryMatch = html.match(/<script[^>]+src="([^"]*assets[^"]*\.js)"/);
if (!entryMatch) throw new Error("no entry script in index.html");
const entry = resolveFile(entryMatch[1]!)!;
const cssFromHtml = [...html.matchAll(/<link[^>]+href="([^"]*assets[^"]*\.css)"/g)].map((m) => m[1]!);

const seen = new Set();
const dynamicSeen = new Set();

/**
 * How a boot-critical chunk is reached, three ways:
 *  1. a static import from a chunk already in the graph;
 *  2. Vite's `__vite__mapDeps([...])` manifest — the entry declares its boot preload set
 *     there, and those index positions must be counted or the walk under-reports;
 *  3. a dynamic import() from the ENTRY itself (the entry is a thin loader whose only
 *     job is `import("./App-…js")`).
 * Everything else (dynamic import from a deeper chunk) is lazy: fetched on demand.
 */
const stack = [{ file: entry, isEntry: true }];
while (stack.length) {
  const { file, isEntry } = stack.pop()!;
  if (seen.has(file)) continue;
  seen.add(file);
  const code = readFileSync(file, "utf8");

  // (2) Vite's dependency manifest. It looks like
    //     `const __vite__mapDeps=(i,m=__vite__mapDeps,d=(m.f||(m.f=["assets/App-….js",…])))=>i.map(i=>d[i])`
    //     and each `import("./X.js")` site passes `__vite__mapDeps([…])` with the indices it
    //     PRELOADS right before fetching. The flat `m.f` array is only the catalogue every
    //     chunk ever emits, so counting it wholesale would call every lazy chunk boot-critical.
    //     Only the ENTRY's own import() site is unconditional (main.ts imports App at boot),
    //     so only its indices count as boot work.
    const manifest = code.match(/m\.f\s*\|\|\s*\(\s*m\.f\s*=\s*(\[[^\]]*\])/);
    if (manifest?.[1] && isEntry) {
      let list: string[] = [];
      try {
        list = JSON.parse(manifest[1].replace(/,\s*$/, "]")) as string[];
      } catch {
        list = [...manifest[1].matchAll(/["'`]([^"'`]+)["'`]/g)].map((m) => m[1]!);
      }
      for (const call of code.matchAll(/__vite__mapDeps\s*\(\s*\[([0-9,\s]*)\]\s*\)/g)) {
        for (const idx of call[1]!.split(",")) {
          const spec = list[Number(idx.trim())];
          if (!spec) continue;
          const f = resolveFile(spec);
          if (f) stack.push({ file: f, isEntry: false });
        }
      }
    }

  // (1) static imports
  for (const spec of staticImports(code)) {
    const f = resolveFile(spec);
    if (f) stack.push({ file: f, isEntry: false });
    else dynamicSeen.add(spec); // bare specifier already inlined into this file
  }
  // (3) dynamic imports from the entry run during boot; deeper ones are lazy.
  for (const spec of dynamicImports(code)) {
    if (isEntry) {
      const f = resolveFile(spec);
      if (f) stack.push({ file: f, isEntry: false });
      else dynamicSeen.add(spec);
    } else {
      dynamicSeen.add(spec);
    }
  }
}

const jsBytes = [...seen].reduce((a, f) => a + statSync(f).size, 0);
const chunks = [...seen].map((f) => ({ file: f.split("/").pop()!, bytes: statSync(f).size }));
chunks.sort((a, b) => b.bytes - a.bytes);

// Dynamic chunks that really exist as separate files (the lazy payload).
const lazyChunks = [...dynamicSeen]
  .map(resolveFile)
  .filter(Boolean)
  .filter((f) => !seen.has(f!))
  .map((f) => ({ file: f!.split("/").pop()!, bytes: statSync(f!).size }));
const uniqueLazy = [...new Map(lazyChunks.map((c) => [c.file, c])).values()].sort((a, b) => b.bytes - a.bytes);

// CSS: the html-linked sheet plus any CSS a boot chunk statically imports.
const cssFiles = new Set<string>();
for (const href of cssFromHtml) {
  const f = resolveFile(href);
  if (f && f.endsWith(".css")) cssFiles.add(f);
}
for (const file of seen) {
  const code = readFileSync(file, "utf8");
  for (const m of code.matchAll(/["']([^"']+\.css)["']/g)) {
    const f = resolveFile(m[1]!);
    if (f && f.endsWith(".css")) cssFiles.add(f);
  }
}
const cssBytes = [...cssFiles].reduce((a, f) => a + statSync(f).size, 0);

const all = [...readdirSync(assets)];
const allJsBytes = all.filter((f) => f.endsWith(".js")).reduce((a, f) => a + statSync(join(assets, f)).size, 0);

console.log(
  JSON.stringify(
    {
      entry: entry.split("/").pop(),
      bootJsBytes: jsBytes,
      bootJsFiles: chunks.length,
      bootCssBytes: cssBytes,
      bootTotalBytes: jsBytes + cssBytes,
      bootChunks: chunks,
      lazyChunkBytes: uniqueLazy.reduce((a, c) => a + c.bytes, 0),
      lazyChunks: uniqueLazy,
      allJsBytesInDist: allJsBytes,
    },
    null,
    2,
  ),
);