import { mount } from "svelte";
import "./app.css";
import { ui } from "./lib/stores/ui.svelte";
import { workspace } from "./lib/workspace";

ui.apply();

// After a rebuild the hashed bundles change and the old ones are deleted. A tab (or a cached
// index.html) that still points at the old names cannot load them, so reload once to pick up
// the new shell instead of leaving a blank page. The flag stops a reload loop.
const RELOAD_KEY = "minitui.staleReload";
function reloadForNewBuild(): void {
  try {
    if (sessionStorage.getItem(RELOAD_KEY)) return;
    sessionStorage.setItem(RELOAD_KEY, String(Date.now()));
  } catch {}
  location.reload();
}
window.addEventListener("vite:preloadError", (event) => {
  event.preventDefault();
  reloadForNewBuild();
});

// The windows, panes and sidebar are shared by every device: wait for the server's copy (briefly, so
// an offline tab still opens) before the stores that read it are created.
await workspace.whenReady();
let App: typeof import("./App.svelte").default;
try {
  ({ default: App } = await import("./App.svelte"));
  try {
    sessionStorage.removeItem(RELOAD_KEY);
  } catch {}
} catch (error) {
  reloadForNewBuild();
  throw error;
}

export default mount(App, { target: document.getElementById("app")! });

// The PWA's services: register the worker that caches the shell, the hashed bundles and the icons,
// so the installed app paints on a repeat visit and still opens (with the app's own reconnect
// banner) offline. The worker is a built asset, so a dev server — where modules and styles change
// on every save — must never control the page. A failed registration (an old browser, plain http
// without a certificate) leaves the app exactly as it was: the worker is an enhancement.
if (!import.meta.env.DEV && "serviceWorker" in navigator) {
  navigator.serviceWorker.register("/sw.js").catch(() => {});
}
