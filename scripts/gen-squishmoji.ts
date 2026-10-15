/**
 * Generate the mini-tui squishmoji avatar set from @usespaceui/squishmoji
 * (MIT). One static SVG per face in the FACES list (must match
 * web/src/lib/avatar.ts and src/channels/groupAvatar.ts), plus 512x512 JPGs
 * for the WhatsApp group photos.
 *
 * The procedural palette is seed-driven, so each face searches suffix seeds
 * until its body colour lands in a mid-luminance band (the mockup's pastel-but-
 * readable range: white eyes stay visible, nothing near-black or washed out).
 * The chosen seed is deterministic, so the set is reproducible.
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { createAvatar } from "@usespaceui/squishmoji";

// codepoint → base seed + expression (friendly only; the mockup's room is upbeat).
const FACES: [string, string, string][] = [
  ["1f916", "robot", "attentive"],
  ["1f47d", "alien", "curious"],
  ["1f47f", "imp", "crazy"],
  ["1f9e0", "brain", "sleepy"],
  ["1f680", "rocket", "determined"],
  ["1f4bb", "laptop", "attentive"],
  ["1f52c", "microscope", "curious"],
  ["1f4ca", "chart", "proud"],
  ["1f4e6", "package", "neutral"],
  ["1f9ea", "test-tube", "surprised"],
  ["1f527", "wrench", "determined"],
  ["1f4b0", "money", "proud"],
  ["1f3e0", "house", "happy"],
  ["1f4dd", "memo", "attentive"],
  ["1f9f8", "teddy", "shy"],
  ["1f50c", "plug", "excited"],
  ["1f3af", "target", "amazed"],
  ["1f4bc", "briefcase", "determined"],
  ["1f600", "grin", "laughing"],
  ["1f60e", "cool", "proud"],
  ["1f929", "starstruck", "loving"],
  ["1f642", "smile", "happy"],
  ["1f4ac", "speech", "excited"],
  ["1f9d1-200d-1f4bb", "technologist", "attentive"],
];

const lum = (hex: string): number => {
  const n = hex.replace("#", "");
  const r = parseInt(n.slice(0, 2), 16) / 255, g = parseInt(n.slice(2, 4), 16) / 255, b = parseInt(n.slice(4, 6), 16) / 255;
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};

const outDir = process.argv[2] ?? "out";
mkdirSync(`${outDir}/svg`, { recursive: true });

// Mid band: white eyes keep contrast, nothing near-black, nothing washed out.
const LO = 0.24, HI = 0.58;
let n = 0;
const seeds: string[] = [];
for (const [cp, base, expression] of FACES) {
  let chosen = "";
  for (let i = 0; i < 40; i++) {
    const seed = i === 0 ? base : `${base}-${i + 1}`;
    const json = createAvatar(seed, { size: 256, shape: "all", expression, backgroundStyle: "solid", format: "json" });
    const L = lum(json.layout.colors.body);
    if (L >= LO && L <= HI) { chosen = seed; break; }
    if (!chosen && i === 39) chosen = seed; // unreachable, but keep types happy
  }
  seeds.push(`${cp}=${chosen}`);
  writeFileSync(`${outDir}/svg/${cp}.svg`, createAvatar(chosen, { size: 256, shape: "all", expression, backgroundStyle: "solid" }));
  n++;
}
console.log(`generated ${n} svgs into ${outDir}/svg`);
console.log(seeds.join("\n"));
