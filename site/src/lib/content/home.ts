/** Copy for the landing page. Product facts and measured results share one source. */

export const hero = {
  kicker: "v0.45.0 · eager verification + MCP",
  title: "Assign work. Get proof, 2.43× faster.",
  sub: "mini-tui turns one chat into a durable work queue. A dispatcher routes each task, workers execute in parallel, and the run closes only when its checker passes. In the final MiMo V2.6 Flash comparison, mini took 163.3 s to pi's 397.6 s, with 10/10 tasks passing on both.",
};

export const features = [
  { id: "queue", icon: "workflow", title: "One chat, a real work queue", body: "The dispatcher writes the brief, the queue keeps it durable, and workers run in the background. Redirect, cancel or continue a task without losing its history." },
  { id: "eager", icon: "check", title: "Eager closure, no victory lap", body: "As soon as the intact checker passes, the task closes with a factual result card. No extra model turn, no post-PASS exploration and no unverified Submitted." },
  { id: "verifier", icon: "key-round", title: "Verification that cannot be faked", body: "The checker is hashed at start and must return 0 plus an independent PASS line. Masked failures, tracebacks and checker replacement are rejected." },
  { id: "fanout", icon: "layout-grid", title: "Parallel only when it is safe", body: "Independent parts get disjoint working directories. allow_overlap: false rejects a wave that would collide; shared-root work falls back to one worker." },
  { id: "mcp", icon: "plug", title: "Native MCP tools", body: "An opt-in Streamable HTTP client handles sessions, JSON/SSE, paginated tools/list and tools/call, and exposes the schemas to OpenAI and Anthropic models." },
  { id: "models", icon: "cpu", title: "Kimi, MiMo and your providers", body: "Use Kimi for Coding K3, Xiaomi MiMo, Anthropic, OpenAI, MiniMax, OpenRouter or a compatible endpoint. Credentials stay on your machine." },
  { id: "browser", icon: "monitor-smartphone", title: "A browser with a human handoff", body: "The agent can open pages and take screenshots. For login, QR, captcha or 2FA it shows the live tab and waits while you take over." },
  { id: "docker", icon: "server", title: "One Docker runtime", body: "Web, Rust agent, Python, whisper, gh and ssh in one image, with your home mounted for state. The container is not a sandbox: PRs and remote hosts still work." },
  { id: "evidence", icon: "workflow", title: "Benchmarks with provenance", body: "Every result names the run, model, endpoint, binary hash and verifier. Charts are generated from raw rows, not from a speedup typed into a blog post." },
  { id: "headless", icon: "terminal", title: "Headless and remote", body: "Run one task in CI or keep the agent on a larger server over SSH while the web UI stays on your laptop. The same session history follows both." },
] as const;

export const steps = [
  { n: 1, title: "Clone and build", code: "git clone https://github.com/jaivial/mini-tui && cd mini-tui\nbun install\n(cd agent-rs && cargo build --release)" },
  { n: 2, title: "Start the work queue", code: "bun run web   # http://127.0.0.1:4317" },
  { n: 3, title: "Connect a model", code: "# Settings → Providers: paste a key.\n# Kimi for Coding and Xiaomi MiMo both have live smoke tests." },
  { n: 4, title: "Or deploy the whole runtime", code: "docker compose up -d --build mini-tui\n# Same web and queue on 4317, state in your mounted home." },
] as const;

export const flow = [
  { n: "01", title: "Describe the outcome", body: "Write a task in the one chat. It can be a bug fix, a multi-project migration or a report with exact counts." },
  { n: "02", title: "Let the dispatcher route it", body: "One task gets a direct worker. Independent parts get disjoint directories and run concurrently; shared-root work stays with one worker." },
  { n: "03", title: "Accept only a passing verdict", body: "The checker runs in the real environment. A PASS closes immediately; a failure goes back for repair, and a repeated failure is an error, never a fake success." },
] as const;

export const whatsappPoints = [
  { title: "A queue you can inspect", body: "Working, queued, completed and error states are visible with their cwd, result, attempts and live worker progress." },
  { title: "Redirect instead of redo", body: "A follow-up continues the same worker session with the original context. There is no need to start the whole task from zero." },
  { title: "A human step when it matters", body: "The agent can show you the live browser and wait for a login, QR, captcha, consent screen or 2FA before it continues." },
  { title: "Results with receipts", body: "Every task keeps its trajectory, model, timings, tool calls, checker output and final verdict, so a PASS is auditable." },
] as const;

export const cuPoints = [
  { title: "MCP where the work lives", body: "The native client initializes the session, negotiates protocol, accepts JSON or SSE and calls remote tools with structured error handling." },
  { title: "Composio, with explicit access", body: "The official CLI is installed for login, search, execute and link. Agent credentials never stand in for OAuth consent or another person's account." },
  { title: "A browser you can take over", body: "When a page needs a person, the agent opens the live tab in the app and waits. It never defeats a captcha or guesses credentials." },
] as const;

/** Final strict validation: one run per task, MiMo V2.6 Flash on both harnesses, same Singapore endpoint. */
export const oracleBench = {
  headline: "163.3 s vs 397.6 s",
  ratio: "2.43x",
  rows: [
    { label: "Tasks passed", pi: "10/10", mini: "10/10" },
    { label: "Sum of task times, worker", pi: "397.6 s", mini: "163.3 s" },
    { label: "Sum of task times, end to end", pi: "397.6 s", mini: "215.7 s" },
    { label: "Speedup, worker / E2E", pi: "—", mini: "2.43x / 1.84x" },
    { label: "Hedged requests", pi: "—", mini: "1" },
  ],
  caveats: "Final strict validation, 24 October 2026: ten tasks, one repetition per arm, Xiaomi MiMo V2.6 Flash on the same Singapore Anthropic endpoint and the final binary. The three-repetition eager campaign measured 2.85x with 30/30 on both. These are local coding results, not a guarantee for every provider or workload, and not the inaccessible official Composio suite.",
} as const;

export const faq = [
  { q: "What is mini-tui now?", a: "A local-first agent work queue. You give it an outcome in one chat, a dispatcher creates the right task or tasks, workers execute them, and a deterministic checker decides whether the work is actually complete." },
  { q: "What does eager verification change?", a: "Instead of trusting a final response, the harness runs the intact checker after work steps. The first real PASS closes the task with a factual card. That removes the final-summary turn and stops the agent from exploring after it has already succeeded." },
  { q: "Can a worker fake a PASS?", a: "Not by replacing the checker: its SHA-256 is captured at run start and checked again before closure. A checker must return 0 and an independent PASS line. Tracebacks, explicit failures and masked pipeline failures are rejected, and repeated failures become TaskVerifierFailed." },
  { q: "Does everything run in parallel?", a: "No. Parallelism happens only when parts have disjoint working directories. allow_overlap: false makes that contract explicit. Shared-root work uses one worker so files cannot be overwritten concurrently." },
  { q: "Which models are tested?", a: "The speed campaign used Xiaomi MiMo V2.6 Flash on the same Singapore endpoint for mini and pi. Kimi for Coding K3 also completed a separate 10-task A/B with 10/10 on both. Model choice can change results, so each campaign keeps its model and provider beside the numbers." },
  { q: "What is MCP for?", a: "MCP lets the agent use remote tools such as Composio's hosted catalog through one standard protocol. The client is off by default, adds no tools to ordinary coding runs, and can be checked with mini-agent-rs mcp-tools before starting a task." },
  { q: "Is the official Composio benchmark claimed?", a: "No. The public article's complete private fixture, seeded accounts and verifier were not accessible, and agents.composio.dev returned 503 during provisioning. Published charts are reference-only; mini will be added only after a validated 25-task run with Kimi K3." },
  { q: "Does mini-tui require a subscription?", a: "No. The source is public and there is no mini-tui account. You pay only the model providers whose keys you choose to connect." },
] as const;
