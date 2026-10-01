/**
 * What a browser kept in localStorage before the workspace was shared on the server. It is read once,
 * when the server has nothing yet, so the first device to load the new version seeds the shared copy
 * with the layout it already had instead of starting from scratch.
 */
export function legacy(key: string): unknown {
  try {
    return typeof localStorage === "undefined" ? null : JSON.parse(localStorage.getItem(key) ?? "null");
  } catch {
    return null;
  }
}
