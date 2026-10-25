<script lang="ts">
  import { Inbox, LoaderCircle } from "@lucide/svelte";
  let { loading = false, filtered = false }: { loading?: boolean; filtered?: boolean } = $props();
</script>

<div class="flex h-full min-h-56 flex-col items-center justify-center px-7 py-10 text-center" role="status">
  <span class="mb-3 grid size-10 place-items-center rounded-xl border border-line/80 bg-raised/60 text-ink-faint">
    {#if loading}<LoaderCircle size={17} class="animate-spin" aria-hidden="true" />{:else}<Inbox size={17} strokeWidth={1.6} aria-hidden="true" />{/if}
  </span>
  <h3 class="text-[12px] font-medium text-ink">{loading ? "Loading your queue" : filtered ? "Nothing in this view" : "Your queue is clear"}</h3>
  <p class="mt-1.5 max-w-52 text-[10.5px] leading-4.5 text-ink-muted">
    {loading ? "Getting the latest task states…" : filtered ? "Try another status filter to see the rest of your work." : "Send work in the chat. New tasks and their live progress will appear here."}
  </p>
</div>
