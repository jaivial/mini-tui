import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { Resvg } from "@resvg/resvg-js";
const dir = process.argv[2] ?? "web/public/squish";
const files = readdirSync(dir).filter(f => f.endsWith(".svg")).sort();
const cell = 128, cols = 6, rows = Math.ceil(files.length / cols);
let cellsSvg = "";
files.forEach((f, i) => {
  const svg = readFileSync(`${dir}/${f}`, "utf8").replace(/width="\d+" height="\d+"/, `width="${cell}" height="${cell}"`);
  const x = (i % cols) * cell, y = Math.floor(i / cols) * cell;
  cellsSvg += `<g transform="translate(${x},${y})">${svg.replace(/<\?xml[^>]*\?>/, "")}</g>`;
  cellsSvg += `<text x="${x + 4}" y="${y + 12}" font-size="10" fill="#333">${f.replace(".svg", "")}</text>`;
});
const sheet = `<svg xmlns="http://www.w3.org/2000/svg" width="${cols * cell}" height="${rows * cell}" style="background:#f6f7f9">${cellsSvg}</svg>`;
const png = new Resvg(sheet, { fitTo: { mode: "width", value: cols * cell } }).render().asPng();
writeFileSync(`${dir}/contact-sheet.png`, png);
console.log("sheet written:", files.length, "faces ->", `${dir}/contact-sheet.png`);
