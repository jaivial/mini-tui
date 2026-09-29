/** Copy for the landing page. Kept as data so the visible text, the FAQ markup and the tests share one source. */

export const hero = {
  kicker: "Terminal and browser.",
  title: "The coding agent that runs where you work.",
  sub: "mini-tui is a fast terminal and web UI for the mini-swe-agent coding agent. Run several sessions at once, stream each over its own WebSocket, keep the agent headless on a server over SSH, and bring your own model keys.",
};

export const features = [
  {
    id: "sessions",
    icon: "layers",
    title: "Many sessions, one screen",
    body: "A sidebar of sessions that keep working in the background. Switch to one and its transcript is already current.",
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

export const steps = [
  { n: 1, title: "Install", code: "git clone https://github.com/jaivial/mini-tui && cd mini-tui\nbun install && python3 -m pip install -e ./agent" },
  { n: 2, title: "Start the web app", code: "bun run web   # http://127.0.0.1:4317" },
  { n: 3, title: "Connect a model", code: "# Settings, Providers: paste a key.\n# It is tested with a real request first." },
] as const;

export const faq = [
  { q: "What is mini-tui?", a: "mini-tui is a terminal and browser interface for the mini-swe-agent coding agent. It shows the agent's thinking, commands and results as they happen, and lets you run several sessions side by side." },
  { q: "Does mini-tui cost anything?", a: "There is no account and no subscription. The source is public on GitHub. You pay only the model provider whose key you connect, if that provider charges for usage." },
  { q: "Which models and providers can I use?", a: "Xiaomi MiMo, DeepSeek, OpenCode Go, Z.AI, MiniMax, OpenAI, Anthropic, Moonshot, Zhipu, Groq and OpenRouter, plus any OpenAI-compatible endpoint. You bring your own key." },
  { q: "Where do my API keys go?", a: "Keys are stored on the machine running mini-tui, in a file only your user can read. The web API never sends a key back to the browser; it returns a masked hint such as sk-…a1b2." },
  { q: "Can the agent run on a remote server?", a: "Yes. In remote mode the agent runs headless on a server over SSH while the interface stays on your machine. The prompt is passed as a single-quoted literal, so it cannot execute as a command on the server." },
  { q: "Does the web app work on a phone?", a: "Yes. It uses 44px touch targets, bottom-sheet dialogs, safe-area insets and a keyboard-aware prompt bar. Put it behind a reverse proxy with authentication to reach it from other devices." },
  { q: "How is it different from the terminal UI?", a: "They are the same agent and share the same session history, so a session started in one shows up in the other. The web app adds a sidebar of concurrent sessions and remote hosts; the terminal UI is lighter and needs no browser." },
] as const;

export const screens = [
  { src: "screens/web-chat.webp", alt: "A running mini-tui session with a thinking receipt, a command and its result, and the final answer", w: 2880, h: 1800, caption: "Watch it work" },
  { src: "screens/web-commands.webp", alt: "The slash-command menu open above the mini-tui prompt bar", w: 2880, h: 1800, caption: "Type / for commands" },
  { src: "screens/web-model-picker.webp", alt: "The searchable model switcher grouped by provider", w: 2880, h: 1800, caption: "Switch models" },
  { src: "screens/web-settings-providers.webp", alt: "The providers tab of settings, with connected providers and a masked key", w: 2880, h: 1800, caption: "Connect providers" },
] as const;
