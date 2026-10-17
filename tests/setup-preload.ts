/**
 * Loaded before every test file (see `bunfig.toml`).
 *
 * The suite must never read the developer's home directory. A test that renders the app used to
 * load `~/.config/mini-tui/settings.json` and inherit whatever theme the machine had saved, so the
 * same commit failed on one box and passed on another: `skillPrompt` and `render` assert colors
 * taken from the palette, and with any theme other than `shadcn` every one of those assertions
 * failed while the code was correct. Thirteen test files already pinned `MINITUI_SETTINGS_PATH` by
 * hand; this makes the default safe for the rest instead of relying on each file remembering.
 *
 * Only the path is redirected — the file itself is never written, so `loadSettings` falls back to
 * the shipped defaults. A test that needs specific settings points the variable at its own sandbox
 * afterwards, exactly as it did before.
 */
if (!process.env.MINITUI_SETTINGS_PATH) {
  process.env.MINITUI_SETTINGS_PATH = "/dev/null/mini-tui-no-settings.json";
}
