import { readFileSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";

// Usage: bun scripts/squishmoji-jpg.ts <svgDir> <outDir> — rasterizes the web
// SVG set to 512×512 JPGs for the WhatsApp group photos.
const svgDir = process.argv[2] ?? "web/public/squish";
const outDir = process.argv[3] ?? "src/channels/assets/squish";
mkdirSync(outDir, { recursive: true });
for (const f of readdirSync(svgDir).filter(f => f.endsWith(".svg"))) {
  const svg = readFileSync(`${svgDir}/${f}`, "utf8");
  // White background: WhatsApp crops circularly and JPG has no alpha.
  const padded = svg.replace(/(<svg [^>]*)>/, `$1><rect x="-158" y="-158" width="316" height="316" fill="#ffffff"/>`);
  const png = new Resvg(padded, { fitTo: { mode: "width", value: 512 } }).render().asPng();
  writeFileSync(`${outDir}/${f.replace(".svg", ".png")}`, png);
}
console.log("rasterized", readdirSync(outDir).length, "->", outDir);
