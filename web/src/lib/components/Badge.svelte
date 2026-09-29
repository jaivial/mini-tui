<script lang="ts">
  import type { Snippet } from "svelte";

  let {
    tone = "neutral",
    dot = false,
    class: klass = "",
    children,
  }: {
    tone?: "neutral" | "ok" | "err" | "warn" | "brand" | "live";
    dot?: boolean;
    class?: string;
    children?: Snippet;
  } = $props();

  const TONES: Record<string, string> = {
    neutral: "text-ink-muted bg-raised",
    ok: "text-ok bg-ok/12",
    err: "text-err bg-err/12",
    warn: "text-warn bg-warn/12",
    brand: "text-brand bg-brand-soft",
    live: "text-ink bg-raised",
  };
  const DOTS: Record<string, string> = {
    neutral: "bg-ink-faint",
    ok: "bg-ok",
    err: "bg-err",
    warn: "bg-warn",
    brand: "bg-brand",
    live: "bg-ok",
  };
</script>

<span
  class="inline-flex items-center gap-1.5 rounded-full px-2 py-0.5 text-[11px] leading-5 font-medium whitespace-nowrap {TONES[tone]} {klass}"
>
  {#if dot}<span class="size-1.5 shrink-0 rounded-full {DOTS[tone]}"></span>{/if}
  {@render children?.()}
</span>
