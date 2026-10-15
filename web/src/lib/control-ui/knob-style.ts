/**
 * Turn a CSS custom-property bag into an inline `style` string.
 *
 * Control UI paints through typed `--cui-*` knobs set as a React `style`
 * object. Svelte's `style` attribute takes a string, so the same knobs are
 * serialized here instead. Unknown keys are dropped (never `undefined` and
 * never a value the browser would have to parse as a declaration).
 */
export function knobsToStyle(knobs: Record<string, string | number | undefined> | undefined): string | undefined {
  if (!knobs) return undefined;
  let out = "";
  for (const [key, value] of Object.entries(knobs)) {
    if (value === undefined || value === null || value === "") continue;
    out += `${key}:${String(value)};`;
  }
  return out || undefined;
}
