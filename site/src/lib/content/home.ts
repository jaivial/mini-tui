/** Copy for the landing page. Kept as data so the visible text, the FAQ markup and the tests share one source. */

export const hero = {
  kicker: "Terminal and browser.",
  title: "The coding agent that runs where you work.",
  sub: "mini-tui is a fast terminal and web UI for the mini-swe-agent coding agent. Split the screen into panes, group them into windows, and watch every session work at once, on any device. Bring your own model keys.",
};

export const features = [
  {
    id: "sessions",
    icon: "layout-grid",
    title: "Panes and windows",
    body: "Up to 12 panes in a window, each its own session, all running at once. As many windows as you like, a status dot per pane.",
  },
  {
    id: "live",
    icon: "monitor-smartphone",
    title: "Terminal and browser, one session",
    body: "Open a session a terminal is running and the browser follows the same agent live. Type in either one; nothing forks.",
  },
  {
    id: "subagents",
    icon: "workflow",
    title: "Subagents that report back",
    body: "A session splits its work across agents it owns. Each one keeps its context, takes messages mid-run and reports when it is done.",
  },
  {
    id: "sockets",
    icon: "plug",
    title: "One WebSocket per session",
    body: "A snapshot, then small deltas. A busy session never spends another session's bandwidth, and a dropped connection resyncs itself.",
  },
  {
    id: "ssh",
    icon: "server",
    title: "Headless over SSH",
    body: "Keep the agent on a beefy box near the code while the UI stays on your laptop. The prompt travels as a quoted literal and cannot run as a command.",
  },
  {
    id: "commands",
    icon: "square-slash",
    title: "Commands and skill chips",
    body: "Type / for commands and $ for skills. A pick becomes a chip and joins your text only when you send. Enter never runs a command by accident.",
  },
  {
    id: "models",
    icon: "cpu",
    title: "Switch models mid-run",
    body: "A searchable, provider-grouped switcher in the prompt bar. Bring keys for DeepSeek, Anthropic, OpenAI, Groq, OpenRouter and more.",
  },
  {
    id: "keys",
    icon: "key-round",
    title: "Keys that stay put",
    body: "A key is tested with one real request before it is saved, stored with 0600 permissions, and never returned by the API.",
  },
  {
    id: "phone",
    icon: "smartphone",
    title: "Built for a phone too",
    body: "44px touch targets, bottom-sheet dialogs, safe-area insets and a prompt bar that grows a line at a time.",
  },
  {
    id: "headless",
    icon: "terminal",
    title: "Scriptable",
    body: "mini-tui -p runs one turn with no UI and prints text, JSON or a JSON stream. Exit codes and guard rails are built for CI.",
  },
] as const;

export const RUST_INSTALL =
  "mkdir -p ~/.local/lib/mini-tui\ncurl -fLo ~/.local/lib/mini-tui/mini-agent-rs \\\n  https://github.com/jaivial/mini-tui/releases/latest/download/mini-agent-rs-x86_64-linux-musl\nchmod +x ~/.local/lib/mini-tui/mini-agent-rs";

export const steps = [
  { n: 1, title: "Get mini-tui", code: "git clone https://github.com/jaivial/mini-tui && cd mini-tui\nbun install" },
  { n: 2, title: "Add the Rust agent (one binary, no Python)", code: RUST_INSTALL },
  { n: 3, title: "Start the web app", code: "bun run web   # http://127.0.0.1:4317" },
  { n: 4, title: "Connect a model", code: "# Settings, Providers: paste a key.\n# It is tested with a real request first." },
] as const;

/**
 * Python or Rust: the agent behind the UI. Numbers measured with the parity suite's `basic` scenario,
 * median of five runs, on one Linux box. Shown on the home page; the docs page explains them.
 */
export const agents = {
  rows: [
    { label: "Start the runner", python: "65 ms", rust: "0.7 ms" },
    { label: "One scripted turn", python: "661 ms", rust: "51 ms" },
    { label: "Memory per waiting session", python: "35.7 MB", rust: "4.5 MB" },
    { label: "Needs", python: "Python 3.10+ and packages", rust: "Nothing: one 6.7 MB binary" },
  ],
  points: [
    "Same configs, trajectories, journal and control file: either agent resumes the other's sessions.",
    "Rust is the default once its binary is found. MINITUI_AGENT=python picks Python.",
    "Kept identical by a parity suite: 31 scenarios and 8 helper cases, byte for byte.",
    "Only the Rust agent runs subagents: a session's own agents, owned and costed by it.",
  ],
} as const;

/**
 * Round 5 of the pi benchmark: the round mini first won the aggregate. Same corpus and model as
 * rounds 1-4 (`minimax/MiniMax-M3`), sequential, no orchestration. Shown on the home page; the full
 * report is in `docs/pi-vs-mini-benchmark.md` in the repository.
 */
export const benchmark = {
  rounds: [
    { round: "R1", ratio: "3.65x", won: "2/10", note: "slow start, harness overhead" },
    { round: "R2", ratio: "1.28x", won: "3/10", note: "native write/edit, leaner prompt" },
    { round: "R3", ratio: "0.95x", won: "7/10", note: "median flips to mini" },
    { round: "R4", ratio: "1.07x", won: "4/10", note: "the reasoning front appears" },
    { round: "R5", ratio: "0.69x", won: "8/10", note: "first aggregate win, quality intact" },
  ],
  rows: [
    { label: "Total wall time", pi: "295.0 s", mini: "204.5 s" },
    { label: "Median per task", pi: "22.1 s", mini: "18.1 s" },
    { label: "Tasks won", pi: "2/10", mini: "8/10" },
    { label: "Quality", pi: "10/10", mini: "10/10" },
  ],
  points: [
    "The front was never the number of turns but the length of the worst one: over the round-4 corpus the longest single turn was a median 30 % of a run's wall time, and those turns are almost entirely reasoning.",
    "Capping the per-turn output at 4096 (from an unstated 8192) was measured back to back over the whole corpus: 0.73x the wall time on 7 of 10 tasks and zero turns truncated. 2048 was not faster enough to pay and truncated a turn; 3072 lost a task outright.",
    "The two tasks that led round 4 moved: t10_crash_report 62.1 s -> 12.0 s, t8_js_bug 72.2 s -> 28.1 s.",
    "Nothing was removed from the work. The speed was not bought with correctness: 10/10 PASS on both sides.",
  ],
} as const;

/** Panes and windows: the multi-session layout, advertised on the home page. */
export const workspaceShots = {
  main: { src: "screens/web-panes.webp", alt: "Four mini-tui sessions side by side in a window called Backend, three of them working; the sidebar lists the Backend, Frontend and Release windows with a status dot per pane", w: 3360, h: 2000 },
  move: { src: "screens/web-move-pane.webp", alt: "A pane's menu open, offering to move the pane to the Frontend or Release window or to a new window", w: 3360, h: 2000 },
  phone: { src: "screens/web-phone-windows.webp", alt: "The same windows in the sidebar of a phone", w: 780, h: 1688 },
};
export const workspacePoints = [
  { title: "Split like tmux", body: "Ctrl+\\ splits right, Ctrl+Shift+\\ splits down. Drag a divider to resize. Alt+1 to Alt+0 jump between panes." },
  { title: "Up to 12 panes in a window", body: "Each pane is a whole chat with its own session, prompt and notes, and every one streams at the same time." },
  { title: "As many windows as you like", body: "Group panes by project: Backend, Frontend, Release. Rename them, and switch with one click in the sidebar." },
  { title: "A dot for every pane", body: "Each window row shows its panes as dots: working, done or idle. A finished turn stays marked until you look at it." },
  { title: "Move a pane anywhere", body: "From a pane's menu, send it to another window or to a new one. Its session keeps running on the way." },
  { title: "The same on every device", body: "The windows and panes live on the server, so your phone, laptop and a second tab show the same layout, live." },
] as const;

export const faq = [
  { q: "What is mini-tui?", a: "mini-tui is a terminal and browser interface for the mini-swe-agent coding agent. It shows the agent's thinking, commands and results as they happen, and lets you run several sessions side by side." },
  { q: "Does mini-tui cost anything?", a: "There is no account and no subscription. The source is public on GitHub. You pay only the model provider whose key you connect, if that provider charges for usage." },
  { q: "Which models and providers can I use?", a: "Xiaomi MiMo, DeepSeek, OpenCode Go, Z.AI, MiniMax, OpenAI, Anthropic, Moonshot, Zhipu, Groq and OpenRouter, plus any OpenAI-compatible endpoint. You bring your own key." },
  { q: "Where do my API keys go?", a: "Keys are stored on the machine running mini-tui, in a file only your user can read. The web API never sends a key back to the browser; it returns a masked hint such as sk-…a1b2." },
  { q: "Can the agent run on a remote server?", a: "Yes. In remote mode the agent runs headless on a server over SSH while the interface stays on your machine. The prompt is passed as a single-quoted literal, so it cannot execute as a command on the server." },
  { q: "Does the web app work on a phone?", a: "Yes. It uses 44px touch targets, bottom-sheet dialogs, safe-area insets and a keyboard-aware prompt bar. Put it behind a reverse proxy with authentication to reach it from other devices." },
  { q: "Can I run several sessions side by side?", a: "Yes. Split the web app into panes like tmux, up to 12 in a window, each running its own session at the same time. Group panes into as many windows as you like, see a working, done or idle dot for every pane in the sidebar, and move a pane to another window from its menu. The layout is kept on the server, so every device shows the same windows." },
  { q: "Python or Rust: which agent should I use?", a: "The Rust agent, unless you need a Python-only extension. It is a port of the same runner as one static binary: it starts in under a millisecond instead of about 65 ms and holds about 4.5 MB per waiting session instead of about 36 MB. It needs no Python. Both read the same configs and write the same trajectories, and a parity suite checks that they behave the same." },
  { q: "How is it different from the terminal UI?", a: "They are the same agent and share the same session history. A session running in a terminal opens live in the browser: both follow the same agent, and a message typed in either one reaches it. The web app adds panes, windows and remote hosts; the terminal UI is lighter and needs no browser." },
  { q: "Can one session start other agents?", a: "Yes, with the Rust agent. A session can start subagents to split its work. Each one is a full agent that keeps its context between turns and takes messages while it runs. It reports back by itself when it finishes, fails or has a question, so the main agent never wastes steps checking on it. Subagents stop with their session and count toward its cost limit. Each is saved as a session of its own, so you can open any of them and watch it live." },
] as const;

export const screens = [
  { src: "screens/web-chat.webp", alt: "A running mini-tui session with a thinking receipt, a command and its result, and the final answer", w: 2880, h: 1800, caption: "Watch it work" },
  { src: "screens/web-commands.webp", alt: "The slash-command menu open above the mini-tui prompt bar", w: 2880, h: 1800, caption: "Type / for commands" },
  { src: "screens/web-model-picker.webp", alt: "The searchable model switcher grouped by provider", w: 2880, h: 1800, caption: "Switch models" },
  { src: "screens/web-settings-providers.webp", alt: "The providers tab of settings, with connected providers and a masked key", w: 2880, h: 1800, caption: "Connect providers" },
] as const;
