/** Copy for the landing page. Kept as data so the visible text, the FAQ markup and the tests share one source. */

export const hero = {
  kicker: "Bots, a board, WhatsApp.",
  title: "Talk to a bot. It runs the board.",
  sub: "mini-tui is a team of bots that organize your work as a kanban instead of coding it all themselves. You say what you want in the web app or a WhatsApp group. The bot writes the cards, workers pick them up, and nothing counts as done until the evidence is on the card.",
};

export const features = [
  { id: "board", icon: "layout-grid", title: "A board the bot keeps", body: "Every request becomes cards with dependencies on a durable task graph. Workers take a lease on a card, and a card in flight is never lost when a lane stops." },
  { id: "bots", icon: "workflow", title: "Bots with delegates", body: "A window holds bots, and each bot holds the delegates it started. The sidebar shows the tree live, and the team map draws it as a graph." },
  { id: "whatsapp", icon: "smartphone", title: "WhatsApp groups, synced", body: "A bot answers in its own group. What you type there shows in the web app and the other way round, with voice notes, images and a typing indicator." },
  { id: "cu", icon: "monitor-smartphone", title: "Bots that use a browser", body: "The computer-use tool drives a real browser through cu and posts screenshots to the chat, so a bot can check its own work on the page." },
  { id: "closure", icon: "check", title: "Done means proven", body: "A closure check reads the diff and the logs against the goal before a card moves to Done. The judge is a small self-hosted model that answers in under a second." },
  { id: "models", icon: "cpu", title: "Your keys, your models", body: "Connect DeepSeek, Anthropic, OpenAI, MiniMax, Groq, OpenRouter and more. A router sends easy turns to cheap models and falls back when a provider fails." },
  { id: "sessions", icon: "square-slash", title: "Terminal and browser, one session", body: "Open a session a terminal is running and the web app follows the same agent live. Type in either one; nothing forks." },
  { id: "voice", icon: "plug", title: "Voice notes and generative UI", body: "Record a note in the chat or on WhatsApp and it is transcribed locally. Bots can answer with forms, tables and charts drawn in the thread." },
  { id: "phone", icon: "server", title: "On a phone, over SSH", body: "An installable web app with touch-sized controls, and an agent that can run headless on a bigger box while the UI stays on your laptop." },
  { id: "headless", icon: "terminal", title: "Scriptable", body: "mini-tui -p runs one turn with no UI and prints text, JSON or a JSON stream. Exit codes and guard rails are built for CI." },
] as const;

export const RUST_INSTALL =
  "mkdir -p ~/.local/lib/mini-tui\ncurl -fLo ~/.local/lib/mini-tui/mini-agent-rs \\\n  https://github.com/jaivial/mini-tui/releases/latest/download/mini-agent-rs-x86_64-linux-musl\nchmod +x ~/.local/lib/mini-tui/mini-agent-rs";

export const steps = [
  { n: 1, title: "Get mini-tui", code: "git clone https://github.com/jaivial/mini-tui && cd mini-tui\nbun install" },
  { n: 2, title: "Build the Rust agent (one binary, no Python)", code: "cd agent-rs && cargo build --release && cd ..\nmkdir -p ~/.local/lib/mini-tui\ncp agent-rs/target/release/mini-agent-rs ~/.local/lib/mini-tui/" },
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
 * The pi benchmark, reported honestly. Same corpus and model as every round
 * (`minimax/MiniMax-M3`), sequential, no orchestration. Round 6 repeated the whole ten-task run
 * three more times: the round-5 headline of 0.69x did not reproduce, so this shows the median over
 * four reps and calls the speed a tie. Quality is the solid result: 10/10 PASS on both sides on
 * every run, 40/40 here. The full report is in `docs/pi-vs-mini-benchmark.md` in the repository.
 */
export const benchmark = {
  rounds: [
    { round: "R1", ratio: "3.65x", won: "2/10", note: "slow start, harness overhead" },
    { round: "R2", ratio: "1.28x", won: "3/10", note: "native write/edit, leaner prompt" },
    { round: "R3", ratio: "0.95x", won: "7/10", note: "median flips to mini" },
    { round: "R4", ratio: "1.07x", won: "4/10", note: "the reasoning front appears" },
    { round: "R5", ratio: "0.69x", won: "8/10", note: "one run; R6 shows it was variance" },
    { round: "R6", ratio: "0.98x", won: "5/10", note: "median of 3 new reps: a tie with pi" },
  ],
  rows: [
    { label: "Quality, 4 runs", pi: "10/10", mini: "10/10" },
    { label: "Quality, all 40 checks", pi: "40/40", mini: "40/40" },
    { label: "Speed, median of 4 reps", pi: "1.00x", mini: "0.98x" },
    { label: "Speed, range over 4 reps", pi: "1.00x", mini: "0.93x – 1.13x" },
    { label: "Faster task, median of 4", pi: "5/10", mini: "5/10" },
  ],
  points: [
    "Quality is the solid result: 10/10 PASS on both harnesses on every one of the four complete runs, 40 of 40 checks per side, never a failing verify.sh.",
    "Speed is a tie. Round 5 read 0.69x, but three fresh repetitions of the whole corpus gave 1.13x, 0.98x and 0.93x. The median over all four runs is 0.98x, so mini and pi stand level, within the range of the corpus itself.",
    "We shipped the 0.69x before repeating the run, and the repetition did not support it. The figure survived because it was already in the release notes, so this page now shows the median and the range instead of the one lucky run.",
    "78 to 81 % of a run's wall time is model time and the harness is about 1 %, so both harnesses are mostly waiting on the same model. What mini does control it does well: a runner starts in ~1 ms instead of ~65 ms and holds ~4.5 MB per waiting session instead of ~36 MB.",
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
  { q: "What is mini-tui?", a: "mini-tui is a team of bots that organize work as a kanban board. You talk to a bot in the web app, the terminal or a WhatsApp group, it turns the request into cards, and workers carry them out and report back in the same thread." },
  { q: "How is it different from a coding agent?", a: "A coding agent is one model that writes the code itself. In mini-tui the bot plans: it writes cards with dependencies, hands them to workers, and checks the evidence before a card closes. The agent underneath is still the mini-swe-agent runner, as a single Rust binary." },
  { q: "How do the WhatsApp groups work?", a: "Each bot can have its own WhatsApp group. Messages there reach the bot, and the bot's replies, reactions and voice-note transcripts come back to the group. The web app mirrors the thread both ways, so you can start on your phone and finish at your desk." },
  { q: "What does the cu integration do?", a: "A bot can drive a real browser through cu, the computer-use tool. It opens pages, clicks, fills forms and sends screenshots to the chat, which is how a bot checks a page it just changed." },
  { q: "What does done mean?", a: "A card moves to Done only after a closure check reads the goal against the diff and the logs. The default judge is a model. You can point it at Laya, a small self-hosted classifier, which closes a clean run in well under a second and hands unclear ones to the model judge." },
  { q: "Does mini-tui cost anything?", a: "There is no account and no subscription. The source is public on GitHub. You pay only the model providers whose keys you connect." },
  { q: "Which models and providers can I use?", a: "DeepSeek, Anthropic, OpenAI, MiniMax, Z.AI, Moonshot, Groq and OpenRouter among others, plus any OpenAI-compatible endpoint. You bring your own key. A router can send simple turns to cheaper models." },
  { q: "Where do my API keys go?", a: "Keys are stored on the machine running mini-tui, in a file only your user can read. The web API never sends a key back to the browser; it returns a masked hint such as sk-…a1b2." },
  { q: "Can the agent run on a remote server?", a: "Yes. In remote mode the agent runs headless on a server over SSH while the interface stays on your machine. The prompt is passed as a single-quoted literal, so it cannot execute as a command." },
  { q: "Does the web app work on a phone?", a: "Yes. It installs as an app and uses touch-sized controls, bottom-sheet dialogs and a keyboard-aware prompt bar. Put it behind a reverse proxy with authentication to reach it from other devices." },
] as const;

export const screens = [
  { src: "screens/web-chat.webp", alt: "A running mini-tui session with a thinking receipt, a command and its result, and the final answer", w: 2880, h: 1800, caption: "Watch it work" },
  { src: "screens/web-commands.webp", alt: "The slash-command menu open above the mini-tui prompt bar", w: 2880, h: 1800, caption: "Type / for commands" },
  { src: "screens/web-model-picker.webp", alt: "The searchable model switcher grouped by provider", w: 2880, h: 1800, caption: "Switch models" },
  { src: "screens/web-settings-providers.webp", alt: "The providers tab of settings, with connected providers and a masked key", w: 2880, h: 1800, caption: "Connect providers" },
] as const;

/** The new pitch, in three steps. Shown under the hero. */
export const flow = [
  { n: "01", title: "Say it", body: "Write or record it in the web app, the terminal, or the bot's WhatsApp group. One sentence is enough." },
  { n: "02", title: "The bot writes the board", body: "It splits the request into cards with dependencies on a durable task graph, and tells you what it will do before workers start." },
  { n: "03", title: "Workers ship, evidence closes", body: "Workers take cards one at a time. A card closes only when the diff and the logs back the goal, and the result lands in your thread." },
] as const;

export const whatsappPoints = [
  { title: "One group per bot", body: "A bot answers in its own group without a mention. The bot's avatar becomes the group photo." },
  { title: "Mirrored both ways", body: "A message in the group appears in the web app, and one typed in the web app appears in the group. No second conversation, no echo." },
  { title: "Voice notes in", body: "Send a note and it is transcribed on your machine, with an honest state if the transcript fails." },
  { title: "Feels alive", body: "A 👀 reaction the moment it hears you, a typing indicator while it works, and semantic reactions when a card closes." },
  { title: "Control from the chat", body: "/newsession starts a fresh session and /rename renames the session and the group subject." },
] as const;

export const cuPoints = [
  { title: "A real browser, not a mock", body: "cu keeps a pool of browser daemons that bots reuse. Logins stay in a vault; a bot never sees a password." },
  { title: "Screenshots go to the chat", body: "The bot posts what it saw, so you check the page without opening it." },
  { title: "Checks its own work", body: "After a UI change the bot opens the page, looks, and files what it found as evidence on the card." },
] as const;

/**
 * The oracle-on benchmark, as measured. Same ten tasks and model as every round (MiniMax-M3.1-Flash-Preview),
 * three repetitions with pi and mini interleaved task by task so that API drift hits both alike, mini with
 * Laya as the closure judge, on the deployed binary and config. The full report is docs/pi-vs-mini-benchmark.md.
 */
export const oracleBench = {
  headline: "112.9 s vs 145.6 s",
  ratio: "0.78x",
  rows: [
    { label: "Tasks passed", pi: "30/30", mini: "30/30" },
    { label: "Sum of per-task medians", pi: "145.6 s", mini: "112.9 s" },
    { label: "Tasks where mini is at least as fast", pi: "1/10", mini: "9/10" },
    { label: "Timeouts", pi: "0", mini: "0" },
  ],
  caveats: "Ten tasks, three repetitions, one model, one machine. The gain comes from a judge that closes a clean run in about a tenth of a second instead of a model call. Earlier rounds on this page were a tie; the report keeps them.",
} as const;
