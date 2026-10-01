// Audits the built site (`bun run build && bun run seo`): the checks a search crawler and a link
// preview would fail on. Reads only files in ./build, so it needs no server and no network.
import { readdirSync, readFileSync, statSync, existsSync } from "node:fs";
import { join, relative, dirname } from "node:path";

const build = join(import.meta.dir, "..", "build");
const ORIGIN = (process.env.VITE_SITE_URL ?? "https://jaivial.github.io/mini-tui").replace(/\/$/, "");
const BASE = new URL(ORIGIN).pathname.replace(/\/$/, "");
const walk = (d) => readdirSync(d).flatMap((f) => (statSync(join(d, f)).isDirectory() ? walk(join(d, f)) : [join(d, f)]));
const pages = walk(build).filter((f) => f.endsWith(".html"));
const problems = [];
const bad = (page, msg) => problems.push(`${relative(build, page)}: ${msg}`);
const pick = (html, re) => [...html.matchAll(re)].map((m) => m[1]);
const attr = (tag, name) => new RegExp(`${name}="([^"]*)"`).exec(tag)?.[1];

const titles = new Map(), descs = new Map();
const routeOf = (f) => "/" + relative(build, dirname(f)).replace(/\\/g, "/").replace(/^\.$/, "") ;
for (const file of pages) {
  const html = readFileSync(file, "utf8");
  const route = routeOf(file);
  const canonicalPath = route === "/" ? "/" : route.replace(/\/?$/, "/");

  const title = pick(html, /<title>([^<]*)<\/title>/g);
  if (title.length !== 1) bad(file, `${title.length} <title> tags`);
  else {
    if (title[0].length > 62) bad(file, `title is ${title[0].length} chars (>62): "${title[0]}"`);
    if (title[0].length < 15) bad(file, `title too short: "${title[0]}"`);
    if (titles.has(title[0])) bad(file, `duplicate title with ${titles.get(title[0])}`); else titles.set(title[0], relative(build, file));
  }
  const desc = pick(html, /<meta name="description" content="([^"]*)"/g);
  if (desc.length !== 1) bad(file, `${desc.length} meta descriptions`);
  else {
    if (desc[0].length < 70 || desc[0].length > 165) bad(file, `description is ${desc[0].length} chars (want 70-165)`);
    if (descs.has(desc[0])) bad(file, `duplicate description with ${descs.get(desc[0])}`); else descs.set(desc[0], relative(build, file));
  }
  const canon = pick(html, /<link rel="canonical" href="([^"]*)"/g);
  if (canon.length !== 1) bad(file, `${canon.length} canonical links`);
  else if (canon[0] !== `${ORIGIN}${canonicalPath === "/" ? "/" : canonicalPath}`) bad(file, `canonical ${canon[0]} does not match the served URL ${ORIGIN}${canonicalPath}`);

  const h1 = pick(html, /<h1[\s>]/g);
  if (h1.length !== 1 && !/404/.test(file)) bad(file, `${h1.length} <h1> elements`);
  if (!/<html[^>]*lang="en"/.test(html)) bad(file, "missing <html lang>");
  if (!/<meta name="viewport"/.test(html)) bad(file, "missing viewport meta");
  for (const p of ["og:title", "og:description", "og:image", "og:url", "og:type"]) if (!html.includes(`property="${p}"`)) bad(file, `missing ${p}`);
  if (!html.includes('name="twitter:card"')) bad(file, "missing twitter:card");

  // structured data must parse, and be the schema we claim
  const ld = pick(html, /<script type="application\/ld\+json">([\s\S]*?)<\/script>/g);
  if (ld.length !== 1) bad(file, `${ld.length} JSON-LD blocks`);
  else try { const j = JSON.parse(ld[0]); if (!Array.isArray(j["@graph"]) || !j["@graph"].length) bad(file, "JSON-LD has no @graph"); } catch (e) { bad(file, `JSON-LD is not valid JSON: ${e.message}`); }

  // images: alt text and dimensions (no layout shift), and every local target exists
  for (const tag of pick(html, /(<img\b[^>]*>)/g)) {
    if (attr(tag, "alt") === undefined) bad(file, `<img> without alt: ${tag.slice(0, 80)}`);
    if (!attr(tag, "width") || !attr(tag, "height")) bad(file, `<img> without width/height (layout shift): ${attr(tag, "src")}`);
  }
  // links and assets
  const local = new Set(pick(html, /(?:href|src|poster)="(\/[^"#?]*)/g).filter((u) => !u.startsWith("//")));
  for (const u of local) {
    let p = u.startsWith(BASE + "/") || u === BASE ? u.slice(BASE.length) || "/" : u;
    if (BASE && !u.startsWith(BASE)) { bad(file, `link ${u} ignores the base path ${BASE}`); continue; }
    const candidates = [join(build, p), join(build, p, "index.html")];
    if (!candidates.some((c) => existsSync(c) && (statSync(c).isFile()))) bad(file, `broken local link: ${u}`);
  }
  // in-page anchors resolve
  const ids = new Set(pick(html, /\sid="([^"]+)"/g));
  for (const a of pick(html, /href="#([^"]+)"/g)) if (!ids.has(a)) bad(file, `anchor #${a} has no target`);
  // outbound links to other sites should not leak the referrer to nothing; target=_blank needs rel
  for (const tag of pick(html, /(<a\b[^>]*target="_blank"[^>]*>)/g)) if (!/rel="[^"]*noopener/.test(tag)) bad(file, "target=_blank without rel=noopener");
  // a page must be readable without JavaScript: the main content is in the HTML, and nothing is hidden by default
  const text = html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/g, "").replace(/<[^>]+>/g, " ").replace(/\s+/g, " ");
  if (text.length < 400 && !/404/.test(file)) bad(file, `only ${text.length} chars of text in the HTML (client-rendered?)`);
  if (/style="[^"]*opacity:\s*0/.test(html)) bad(file, "content hidden with inline opacity:0 in the prerendered HTML");
}

// site files
const need = ["sitemap.xml", "robots.txt", "llms.txt", "og.png", "favicon.svg", "apple-touch-icon.png", "manifest.webmanifest"];
for (const f of need) if (!existsSync(join(build, f))) problems.push(`missing ${f}`);
if (existsSync(join(build, "sitemap.xml"))) {
  const xml = readFileSync(join(build, "sitemap.xml"), "utf8");
  const locs = pick(xml, /<loc>([^<]+)<\/loc>/g);
  const served = pages.filter((f) => !/404/.test(f)).map((f) => `${ORIGIN}${routeOf(f) === "/" ? "/" : routeOf(f).replace(/\/?$/, "/")}`);
  for (const s of served) if (!locs.includes(s)) problems.push(`sitemap is missing ${s}`);
  for (const l of locs) if (!served.includes(l)) problems.push(`sitemap lists ${l} but no such page was built`);
  if (new Set(locs).size !== locs.length) problems.push("sitemap has duplicate URLs");
}
if (existsSync(join(build, "robots.txt")) && !readFileSync(join(build, "robots.txt"), "utf8").includes(`Sitemap: ${ORIGIN}/sitemap.xml`)) problems.push("robots.txt does not point at the sitemap");
if (existsSync(join(build, "og.png"))) {
  const png = readFileSync(join(build, "og.png"));
  const [w, h] = [png.readUInt32BE(16), png.readUInt32BE(20)];
  if (w !== 1200 || h !== 630) problems.push(`og.png is ${w}x${h}, want 1200x630`);
}

console.log(`${pages.length} pages checked, ${problems.length} problem(s)`);
for (const p of problems) console.log("  x", p);
process.exit(problems.length ? 1 : 0);
