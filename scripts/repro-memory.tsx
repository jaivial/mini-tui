// Repro: stream a real journal into a follow-mode App and sample RSS / JS heap.
// Repro for the TUI RAM budget (see CHANGELOG 0.16.1): feeds a journal in chunks to a follow-mode App.
// usage: bun scripts/repro-memory.tsx <traj.jsonl> [chunks]
import { appendFileSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { testRender } from "@opentui/react/test-utils";
import { act } from "react";
import { heapStats } from "bun:jsc";
import { App } from "../src/ui/App";

process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/x";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/x";
const src = process.argv[2]!;
const chunks = Number(process.argv[3] ?? 40);
// split into chunk files first (a child process) so this process never holds the whole source
Bun.spawnSync(["bash", "-c", `rm -rf /tmp/memrepro/chunks && mkdir -p /tmp/memrepro/chunks && split -n l/${chunks} -d -a 3 "${src}" /tmp/memrepro/chunks/c`]);
const chunkFiles = [...new Bun.Glob("c*").scanSync("/tmp/memrepro/chunks")].sort().map((f) => `/tmp/memrepro/chunks/${f}`);
const traj = "/tmp/memrepro/traj.json";
const journal = "/tmp/memrepro/traj.jsonl";
rmSync(journal, { force: true });
writeFileSync(journal, "");
const mb = (n: number) => (n / 1048576).toFixed(0);
const sample = (label: string) => {
  Bun.gc(true);
  const h = heapStats();
  console.log(`${label.padEnd(12)} rss=${mb(process.memoryUsage().rss)} heap=${mb(h.heapSize)} extra=${mb(h.extraMemorySize)}`);
};
sample("start");
const setup = await testRender(<App cwd="." viewPath={traj} follow persistSettings={false} onQuit={() => {}} />, { width: 200, height: 50 });
await setup.renderOnce();
sample("mounted");
for (let i = 0; i < chunkFiles.length; i++) {
  appendFileSync(journal, readFileSync(chunkFiles[i]!));
  await act(async () => { await Bun.sleep(260); });
  await setup.renderOnce();
  if (i % 5 === 0) sample(`chunk ${i}`);
}
await act(async () => { await Bun.sleep(600); });
await setup.renderOnce();
sample("end");
if (process.env.TYPES) { const t = heapStats().objectTypeCounts; console.log(Object.entries(t).sort((a,b)=>b[1]-a[1]).slice(0,15)); }
setup.renderer.destroy();
process.exit(0);
