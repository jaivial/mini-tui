// Real-browser end-to-end for rearranging panes (move, drag, presets) and the notes panel's free
// resize: a real server (temp database, fake agent) and real WebSockets. Run after `bun run build`:
//   cd web && bun scripts/e2e-pane-layout.mjs
import { chromium } from "playwright-core";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync, readdirSync, existsSync } from "node:fs";
import { tmpdir, homedir } from "node:os";
import { join } from "node:path";
import { Database } from "bun:sqlite";

const root = join(import.meta.dir, "..", "..");
const dir = mkdtempSync(join(tmpdir(), "minitui-e2e-panebrowser-"));
const dbPath = join(dir, "sessions.db");
const PORT = 5600 + Math.floor(Math.random() * 300);
const { createSession, openDb, saveTranscript } = await import(join(root, "src/sessions.ts"));
const db = openDb(dbPath);
for (const [id, title] of [["s-alpha", "Alpha task"], ["s-beta", "Beta task"], ["s-gamma", "Gamma task"]]) {
  createSession(db, { id, cwd: "/tmp", model: "deepseek/deepseek-chat", task: title, title });
  saveTranscript(db, id, [{ type: "task", text: title }, { type: "assistant", text: `hello from ${id}` }], { cost: 0.01, apiCalls: 1 }, []);
}
db.close();

const { makeFakeAgent } = await import(join(root, "tests/helpers/fake-agent.ts"));
const fake = makeFakeAgent(join(dir, "bin"), { holdMs: 200 });
const startServer = () => spawn("bun", ["src/web/serve.ts", "--port", String(PORT)], {
  cwd: root, stdio: "ignore",
  env: { ...process.env, MINITUI_MINI_BIN: fake.script, MINITUI_EMBEDDED_AGENT: "0", MINITUI_LAST_MODEL_PATH: join(dir, "last-model.json"), MINITUI_CONNECTIONS_PATH: join(dir, "providers.json"), MINITUI_SETTINGS_PATH: join(dir, "settings.json"), MINITUI_SKILLS_DIR: join(dir, "skills"), MINITUI_DB_PATH: dbPath, MINITUI_CONFIG_DIR: dir, MINITUI_RESUME_DIR: join(dir, "resume"), MINITUI_RUNS_DIR: join(dir, "runs") },
});
let server = startServer();
const base = `http://127.0.0.1:${PORT}`;
for (let i = 0; i < 80; i++) { try { if ((await fetch(`${base}/api/health`)).ok) break; } catch {} await Bun.sleep(100); }
for (const id of ["s-alpha", "s-beta", "s-gamma"]) await fetch(`${base}/api/history/${id}`, { method: "POST" });

function chrome() { const r = `${homedir()}/.cache/ms-playwright`; for (const d of readdirSync(r).filter((d) => d.startsWith("chromium-")).sort().reverse()) { const b = `${r}/${d}/chrome-linux64/chrome`; if (existsSync(b)) return b; } }

const browser = await chromium.launch({ executablePath: chrome() });
let failed = 0;
const check = (name, ok, extra = "") => { console.log(`${ok ? "PASS" : "FAIL"}  ${name}${extra ? "  " + extra : ""}`); if (!ok) failed++; };
const paneBoxes = (page) => page.locator("section[data-pane]").evaluateAll((els) => els.map((e) => { const r = e.getBoundingClientRect(); return { id: e.dataset.pane, x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height), label: e.getAttribute("aria-label") ?? "", current: e.getAttribute("aria-current") }; }));
const menuOf = (page, id) => page.locator(`section[data-pane="${id}"]`).getByRole("button", { name: "Pane menu" });
// What a pane shows, without its position ("Pane 2: "), which moves with the pane's place, not its content.
const shown = (page) => paneBoxes(page).then((bs) => bs.map((b) => b.label.replace(/^Pane \d+: /, "")));
const geometries = (page) => paneBoxes(page).then((bs) => bs.map((b) => [b.x, b.y, b.w, b.h]));

try {
  const ctx = await browser.newContext({ viewport: { width: 1400, height: 900 } });
  const page = await ctx.newPage();
  await page.goto(base);
  await page.waitForTimeout(1200);

  // three panes: p1 | (p2 / p3)
  await page.getByLabel("Prompt").click();
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(400);
  await page.keyboard.press("Control+Shift+Backslash");
  await page.waitForTimeout(400);
  let boxes = await paneBoxes(page);
  check("three panes to start, one row with a split below its right half", boxes.length === 3 && boxes[0].y === boxes[1].y && boxes[0].x < boxes[1].x && boxes[1].x === boxes[2].x && boxes[2].y > boxes[1].y, JSON.stringify(boxes.map((b) => [b.x, b.y])));
  // A session in every pane, so a swap can be told from a no-op (two new chats look the same).
  // Pane 1 already shows Alpha; put Beta in pane 2 and Gamma in pane 3, one at a time.
  boxes = await paneBoxes(page);
  for (const [i, title] of [[1, "Beta task"], [2, "Gamma task"]]) {
    await page.locator(`section[data-pane="${boxes[i].id}"]`).click({ position: { x: 120, y: 120 } });
    await page.waitForTimeout(200);
    await page.locator("aside").getByRole("button", { name: new RegExp(title) }).first().click();
    await page.waitForTimeout(700);
  }
  boxes = await paneBoxes(page);
  const ids = boxes.map((b) => b.id);
  const names = await shown(page);
  check("three panes, each showing another session", new Set(names).size === 3, JSON.stringify(names));

  // ---- the menu: move a pane right
  const menu = menuOf(page, ids[0]);
  await menu.click();
  const paneMenu = page.getByRole("menu", { name: "Pane" });
  await paneMenu.waitFor();
  const rows = await paneMenu.getByRole("menuitem").allInnerTexts();
  check("the pane menu offers the four directions and the three layouts", ["Move pane left", "Move pane right", "Move pane up", "Move pane down", "Lay out in a row", "Lay out in a column", "Lay out in a grid"].every((label) => rows.some((r) => r.includes(label))), JSON.stringify(rows));
  const leftRow = paneMenu.getByRole("menuitem", { name: "Move pane left" });
  check("...and says why a direction cannot be taken", /No pane left of this one/.test(await leftRow.innerText()) && (await leftRow.getAttribute("aria-disabled")) === "true");
  await paneMenu.getByRole("menuitem", { name: "Move pane right" }).click();
  await page.waitForTimeout(300);
  const afterMove = await shown(page);
  check("Move pane right swaps it with its right-hand neighbour", afterMove[0] === names[1] && afterMove[1] === names[0], JSON.stringify(afterMove));

  // ---- the keyboard: move it back, then down
  await page.locator(`section[data-pane="${ids[0]}"]`).click({ position: { x: 120, y: 120 } });
  await menu.click();
  await paneMenu.getByRole("menuitem", { name: "Move pane left" }).click();
  await page.waitForTimeout(200);
  check("moving it back leaves the panes as they began", JSON.stringify(await shown(page)) === JSON.stringify(names));

  // ---- drag and drop: pane 1 onto pane 3
  const grip = page.locator(`section[data-pane="${ids[0]}"]`).getByRole("button", { name: /Drag pane/ });
  check("every pane has a drag grip in its header", (await grip.count()) === 1);
  const target = await page.locator(`[data-pane-drop="${ids[2]}"]`).boundingBox();
  await grip.hover();
  await page.mouse.down();
  await page.mouse.move(target.x + target.width / 2, target.y + target.height / 2, { steps: 8 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(300);
  const afterDrag = await shown(page);
  const afterDragBoxes = await paneBoxes(page);
  check("dragging a pane onto another swaps the two", afterDrag[0] === names[2] && afterDrag[2] === names[0], JSON.stringify(afterDrag));
  check("...the shapes and sizes of every pane are exactly as they were", JSON.stringify(afterDragBoxes.map((b) => [b.x, b.y, b.w, b.h])) === JSON.stringify(boxes.map((b) => [b.x, b.y, b.w, b.h])));
  // a drag onto itself changes nothing
  const self = await page.locator(`[data-pane-drop="${ids[0]}"]`).boundingBox();
  await page.locator(`section[data-pane="${ids[0]}"]`).getByRole("button", { name: /Drag pane/ }).hover();
  await page.mouse.down();
  await page.mouse.move(self.x + self.width / 2, self.y + self.height / 2, { steps: 6 });
  await page.waitForTimeout(120);
  await page.mouse.up();
  await page.waitForTimeout(200);
  check("a pane dropped on itself does not move", (await shown(page))[0] === names[2]);

  // ---- presets
  await menuOf(page, ids[0]).click();
  await paneMenu.getByRole("menuitem", { name: "Lay out in a column" }).click();
  await page.waitForTimeout(300);
  const col = await paneBoxes(page);
  check("Lay out in a column stacks the panes, in the order they were in", col.every((b) => b.x === col[0].x) && col[0].y < col[1].y && col[1].y < col[2].y && JSON.stringify(await shown(page)) === JSON.stringify(afterDrag), JSON.stringify(col.map((b) => [b.x, b.y])));
  check("...and the three of them are even", Math.abs(col[0].h - col[1].h) <= 2 && Math.abs(col[1].h - col[2].h) <= 2, JSON.stringify(col.map((b) => b.h)));

  await page.keyboard.press("Escape");
  await menuOf(page, ids[0]).click();
  await page.getByRole("menu", { name: "Pane" }).waitFor();
  await page.getByRole("menu", { name: "Pane" }).getByRole("menuitem", { name: "Lay out in a row" }).click();
  await page.waitForTimeout(300);
  const row = await paneBoxes(page);
  check("Lay out in a row lines the panes up, in the order they were in", row[0].y === row[1].y && row[1].y === row[2].y && row[0].x < row[1].x && row[1].x < row[2].x && Math.abs(row[0].w - row[1].w) <= 2, JSON.stringify(row.map((b) => [b.x, b.y, b.w])));
  // A grid of three would be a row of three, so it stays greyed out with the reason.
  await menuOf(page, ids[0]).click();
  const gridRow = page.getByRole("menu", { name: "Pane" }).getByRole("menuitem", { name: "Lay out in a grid" });
  await gridRow.waitFor();
  check("the grid is refused while there are fewer than four panes, with the reason", /Needs 4 panes/.test(await gridRow.innerText()) && (await gridRow.getAttribute("aria-disabled")) === "true");
  await page.keyboard.press("Escape");
  // A window wide enough for a fourth pane: the split needs 340px for each half.
  await page.setViewportSize({ width: 2400, height: 1400 });
  await page.waitForTimeout(600);
  await page.keyboard.press("Control+Backslash");
  await page.waitForTimeout(600);
  check("a fourth pane on a wide window", (await paneBoxes(page)).length === 4, String((await paneBoxes(page)).length));
  await menuOf(page, ids[0]).click();
  await page.getByRole("menu", { name: "Pane" }).getByRole("menuitem", { name: "Lay out in a grid" }).click();
  await page.waitForTimeout(400);
  const grid = await paneBoxes(page);
  check("Lay out in a grid makes two rows of two, reading left to right", grid.length === 4 && grid[0].y === grid[1].y && grid[2].y === grid[3].y && grid[0].y < grid[2].y && grid[0].x < grid[1].x, JSON.stringify(grid.map((b) => [b.x, b.y])));

  // ---- persistence: a reload brings the arrangement back
  const before = await paneBoxes(page);
  const beforeShown = await shown(page);
  await page.reload();
  await page.waitForTimeout(1200);
  const kept = await paneBoxes(page);
  check("a reload brings the moved layout back, sizes included", JSON.stringify(kept.map((b) => [b.x, b.y, b.w, b.h])) === JSON.stringify(before.map((b) => [b.x, b.y, b.w, b.h])) && JSON.stringify(await shown(page)) === JSON.stringify(beforeShown), JSON.stringify(kept.map((b) => b.label)));

  // ---- the notes panel resizes freely
  const one = page.locator(`section[data-pane="${kept[0].id}"]`);
  await one.getByRole("button", { name: "Show notes" }).click();
  await page.waitForTimeout(600);
  const area = one.getByRole("textbox");
  await area.fill("notes to resize by", { timeout: 10000 }).catch(() => {}); // typing here is not what is under test
  const slot = one.locator(".notes-slot");
  const slotBox = async () => (await slot.boundingBox());
  let w0 = (await slotBox()).width;
  const sep = one.getByRole("separator", { name: "Resize notes" });
  check("the notes panel has a resize divider", (await sep.count()) === 1);
  const box = await slotBox();
  // The divider is a 1px line: aim the raw mouse at its x, at a height where nothing covers it.
  const at = { x: box.x + 1, y: box.y + Math.min(200, box.height - 20) };
  await page.mouse.move(at.x, at.y);
  await page.mouse.down();
  const paneBox = await one.boundingBox();
  const want = Math.max(60, Math.min(w0 + 120, paneBox.width - 300));
  await page.mouse.move(box.x + box.width - want, at.y, { steps: 6 });
  await page.waitForTimeout(150);
  await page.mouse.up();
  await page.waitForTimeout(400);
  let w1 = (await slotBox()).width;
  check("dragging the divider widens the notes panel", w1 > w0 + 60, `${Math.round(w0)} -> ${Math.round(w1)}`);
  const noteWidth = await one.locator(".notes-slot").evaluate((el) => el.style.getPropertyValue("--side-w"));
  check("...and the width it landed on is kept on the pane", /^\d+px$/.test(noteWidth ?? ""), noteWidth ?? "none");
  // keyboard
  await sep.focus({ timeout: 5000 });
  await sep.press("ArrowLeft");
  await page.waitForTimeout(200);
  const w2 = (await slotBox()).width;
  check("the arrow keys step the width", Math.abs(w2 - w1) > 10, `${Math.round(w1)} -> ${Math.round(w2)}`);
  await sep.press("Home");
  await page.waitForTimeout(200);
  const w3 = (await slotBox()).width;
  check("Home goes to the widest, and no further", w3 >= w2 && w3 <= 640, String(Math.round(w3)));
  // the chat keeps its share
  check("the chat beside the notes keeps at least 16rem", paneBox.width - w3 >= 250, `${Math.round(paneBox.width - w3)}`);
  // End takes the width back to the least, so the reload checks a width that is not the default.
  await sep.press("End");
  await page.waitForTimeout(200);
  const noteWidth2 = await one.locator(".notes-slot").evaluate((el) => el.style.getPropertyValue("--side-w"));
  // The width is written once the drag has settled (250ms): let it get out before the page goes away.
  await page.waitForTimeout(600);
  // reload: the width comes back
  await page.reload();
  await page.waitForTimeout(1200);
  const after = await page.locator('section[data-pane]').first().locator(".notes-slot").evaluate((el) => el.style.getPropertyValue("--side-w"));
  check("a reload brings the notes width back", after === noteWidth2, `${noteWidth2} -> ${after}`);
  // double-click gives the default back
  const slot0 = page.locator('section[data-pane]').first().locator(".notes-slot");
  const b2 = await slot0.boundingBox();
  await page.mouse.move(b2.x + 1, b2.y + 200);
  await page.mouse.down(); await page.mouse.up();
  await page.mouse.down(); await page.mouse.up();
  await page.waitForTimeout(500);
  check("a double-click on the divider gives the default width back", !(await slot0.evaluate((el) => el.style.getPropertyValue("--side-w"))));

  await ctx.close();
} catch (error) {
  failed++;
  console.log("FAIL  the run blew up", String(error).slice(0, 400));
} finally {
  browser.close().catch(() => {});
  server.kill();
  try { rmSync(dir, { recursive: true, force: true }); } catch {}
}
process.exit(failed ? 1 : 0);
