/** Small shared formatters, kept identical in spirit to the TUI's. */

export function boundedText(text: string, maxLines: number, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const head = text.split("\n", maxLines).join("\n");
  return `${head}\n… ${text.length - head.length} chars hidden`;
}

export function cost(value: number): string {
  if (!value) return "$0.00";
  if (value < 0.01) return `$${value.toFixed(4)}`;
  return `$${value.toFixed(2)}`;
}

export function duration(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  return `${Math.floor(m / 60)}h ${m % 60}m`;
}

export function relativeTime(ts: number): string {
  const diff = Date.now() - ts;
  if (diff < 60_000) return "just now";
  if (diff < 3_600_000) return `${Math.floor(diff / 60_000)}m ago`;
  if (diff < 86_400_000) return `${Math.floor(diff / 3_600_000)}h ago`;
  return `${Math.floor(diff / 86_400_000)}d ago`;
}

/** Innermost segment of a path, for a compact sidebar label. */
export function baseName(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}

export function shortCwd(path: string): string {
  const home = /^\/home\/[^/]+/;
  return path.replace(home, "~");
}
