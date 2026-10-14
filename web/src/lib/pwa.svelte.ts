/**
 * The PWA bits: the service worker registration and the install prompt.
 *
 * Chrome only offers `beforeinstallprompt` once per page load; we keep it until the visitor
 * wants it, and remember nothing else — installing is the browser's and the OS's business.
 */
type InstallPromptEvent = Event & {
  prompt: () => Promise<void>;
  userChoice: Promise<{ outcome: "accepted" | "dismissed" }>;
};

export const pwa = $state({ installable: false });

let deferred: InstallPromptEvent | null = null;

export function initPwa(): void {
  if (!("serviceWorker" in navigator)) return;
  // Only the built app has a service worker to register; the dev server would just 404 it.
  if (!import.meta.env.PROD) return;
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => {
      /* offline shell is a bonus; the app works without it */
    });
  });
  window.addEventListener("beforeinstallprompt", (event) => {
    event.preventDefault();
    deferred = event as InstallPromptEvent;
    pwa.installable = true;
  });
  window.addEventListener("appinstalled", () => {
    deferred = null;
    pwa.installable = false;
  });
}

/** Show the browser's install dialog. Resolves once the visitor has chosen. */
export async function promptInstall(): Promise<void> {
  if (!deferred) return;
  const event = deferred;
  deferred = null;
  pwa.installable = false;
  await event.prompt();
  await event.userChoice.catch(() => undefined);
}
