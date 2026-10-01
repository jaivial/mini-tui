<script lang="ts">
  import { Check, Copy } from "@lucide/svelte";
  import { Button } from "$lib/components/ui/button";

  /** A shell snippet with a copy button. The text is real text (selectable, crawlable), not an image. */
  let { code, label = "Copy command" }: { code: string; label?: string } = $props();
  let copied = $state(false);
  let timer: ReturnType<typeof setTimeout> | undefined;
  async function copy() {
    try {
      await navigator.clipboard.writeText(code);
      copied = true;
      clearTimeout(timer);
      timer = setTimeout(() => (copied = false), 1800);
    } catch {
      /* no clipboard permission: the text is still selectable */
    }
  }
</script>

<div class="relative rounded-lg border bg-card">
  <pre class="overflow-x-auto p-4 pr-14 font-mono text-[13px] leading-relaxed text-card-foreground"><code>{code}</code></pre>
  <Button variant="ghost" size="icon" class="absolute top-2 right-2" onclick={copy} aria-label={copied ? "Copied" : label} title={copied ? "Copied" : label}>
    {#if copied}<Check aria-hidden="true" class="text-primary" />{:else}<Copy aria-hidden="true" />{/if}
  </Button>
  <span class="sr-only" role="status" aria-live="polite">{copied ? "Copied to clipboard" : ""}</span>
</div>
