<script lang="ts">
  import { X, CornerDownRight, Ban, ChevronDown, ChevronRight, Link2 } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Markdown from "./Markdown.svelte";
  import { queue, FILTERS, matches, type QueueFilter } from "../stores/queue.svelte";
  import { clock } from "../stores/clock.svelte";
  import { duration } from "../format";
  import { api } from "../api";
  import { toasts } from "../stores/toast.svelte";
  import type { QueueTask } from "../types";

  /**
   * The task panel on the right of the one chat: every task the dispatcher queued, filtered by
   * state (working, queued, completed, error). A task opens to its brief, its result, the notes
   * its worker sent and the tasks it is related to; it can be redirected or cancelled from here.
   */
  let { onclose, onopen }: { onclose?: () => void; onopen?: (sessionId: string) => void } = $props();

  let filter = $state<QueueFilter>("all");
  let openId = $state("");
  let redirectText = $state("");
  let busy = $state(false);

  /** Rows drawn: hundreds of finished tasks must not become thousands of DOM nodes at once. */
  const PAGE = 100;
  let limit = $state(PAGE);
  $effect(() => {
    filter;
    limit = PAGE;
  });
  const matching = $derived(queue.tasks.filter((t) => matches(t.status, filter)));
  const shown = $derived(matching.slice(0, limit));
  const running = $derived(queue.tasks.some((t) => t.status === "running"));
  $effect(() => {
    if (running) return clock.watchAge("elapsed", Date.now() - 1000);
  });

  const TONE: Record<QueueTask["status"], "live" | "neutral" | "ok" | "err" | "warn"> = {
    running: "live",
    queued: "neutral",
    done: "ok",
    error: "err",
    cancelled: "warn",
  };
  const LABEL: Record<QueueTask["status"], string> = { running: "working", queued: "queued", done: "completed", error: "error", cancelled: "cancelled" };

  function elapsed(t: QueueTask): string {
    if (t.status === "running") return duration(Math.max(0, clock.now - t.startedAt) + t.workSeconds * 1000);
    if (t.workSeconds > 0) return duration(t.workSeconds * 1000);
    return "";
  }

  async function cancel(t: QueueTask) {
    busy = true;
    try {
      await api.queueCancel(t.id);
    } catch (e) {
      toasts.push("Could not cancel", { detail: (e as Error).message, tone: "err" });
    } finally {
      busy = false;
    }
  }

  async function redirect(t: QueueTask) {
    const message = redirectText.trim();
    if (!message) return;
    busy = true;
    try {
      const r = await api.queueRedirect(t.id, message);
      toasts.push(r.text, { tone: "info" });
      redirectText = "";
    } catch (e) {
      toasts.push("Could not redirect", { detail: (e as Error).message, tone: "err" });
    } finally {
      busy = false;
    }
  }
</script>

<aside class="flex h-full min-h-0 w-full flex-col border-l border-line/80 bg-surface" aria-label="Tasks">
  <header class="flex min-h-13 shrink-0 items-center gap-2 border-b border-line/80 px-3.5">
    <h2 class="flex-1 text-[13.5px] font-semibold">Tasks</h2>
    <span class="tnum text-[11.5px] text-ink-faint" title="Running now / at most at once">{queue.counts.running}/{queue.concurrency || "—"} running</span>
    {#if onclose}<Button variant="ghost" size="icon-sm" icon={X} aria-label="Hide tasks" title="Hide tasks" onclick={onclose} />{/if}
  </header>

  <div class="flex shrink-0 flex-wrap gap-1 border-b border-line/80 px-2.5 py-2" role="tablist" aria-label="Filter tasks">
    {#each FILTERS as f (f.id)}
      <button
        type="button"
        role="tab"
        aria-selected={filter === f.id}
        class="interactive flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] pointer-coarse:min-h-10
          {filter === f.id ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink'}"
        onclick={() => (filter = f.id)}
      >
        {f.label}<span class="tnum text-[11px] text-ink-faint">{queue.counts[f.id]}</span>
      </button>
    {/each}
  </div>

  <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain">
    {#if !queue.loaded}
      <p class="p-4 text-[12.5px] text-ink-muted">Loading the queue…</p>
    {:else if !shown.length}
      <p class="p-4 text-[12.5px] text-ink-muted">{queue.tasks.length ? "No task in this state." : "No tasks yet. Send work in the chat and it lands here."}</p>
    {:else}
      <ul class="flex flex-col">
        {#each shown as t (t.id)}
          {@const open = openId === t.id}
          <li class="border-b border-line/60" data-task={t.id} data-status={t.status}>
            <button
              type="button"
              class="interactive flex w-full cursor-pointer items-start gap-2 px-3 py-2.5 text-left hover:bg-raised/60"
              aria-expanded={open}
              onclick={() => {
                openId = open ? "" : t.id;
                redirectText = "";
              }}
            >
              <span class="mt-0.5 text-ink-faint">{#if open}<ChevronDown size={13} />{:else}<ChevronRight size={13} />{/if}</span>
              <span class="min-w-0 flex-1">
                <span class="flex items-center gap-2">
                  <span class="tnum shrink-0 text-[11px] text-ink-faint">{t.id}</span>
                  <span class="truncate text-[13px] font-medium text-ink">{t.title}</span>
                </span>
                <span class="mt-0.5 line-clamp-2 block text-[12px] text-ink-muted">{t.description}</span>
              </span>
              <span class="flex shrink-0 flex-col items-end gap-1">
                <Badge tone={TONE[t.status]} dot>{LABEL[t.status]}</Badge>
                {#if elapsed(t)}<span class="tnum text-[10.5px] text-ink-faint">{elapsed(t)}</span>{/if}
              </span>
            </button>
            {#if open}
              <div class="flex flex-col gap-3 px-3 pb-3 pl-8 text-[12.5px]">
                {#if t.result}
                  <section>
                    <h3 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Result</h3>
                    <div class="rounded-md bg-canvas px-2.5 py-2"><Markdown text={t.result} /></div>
                  </section>
                {/if}
                {#if t.notes.length}
                  <section>
                    <h3 class="mb-1 text-[11px] font-semibold tracking-wide text-ink-faint uppercase">Notes</h3>
                    <ul class="flex flex-col gap-1">
                      {#each t.notes.slice(-6) as n (n.at + n.text)}
                        <li class="text-ink-muted"><span class="text-ink-faint">[{n.from}]</span> {n.text}</li>
                      {/each}
                    </ul>
                  </section>
                {/if}
                {#if t.related.length}
                  <p class="flex flex-wrap items-center gap-1.5 text-ink-muted">
                    <Link2 size={12} aria-hidden="true" /> related:
                    {#each t.related as r (r.id)}
                      <button type="button" class="cursor-pointer underline decoration-dotted" onclick={() => (openId = r.id)}>{r.id}</button>
                    {/each}
                  </p>
                {/if}
                <details>
                  <summary class="cursor-pointer text-ink-faint">Brief{t.redirects.length ? ` · ${t.redirects.length} redirect${t.redirects.length > 1 ? "s" : ""}` : ""}</summary>
                  <pre class="mt-1 max-h-60 overflow-auto rounded-md bg-canvas p-2 font-mono text-[11.5px] whitespace-pre-wrap text-ink-muted">{t.prompt}{#each t.redirects as r}{"\n\n↳ "}{r}{/each}</pre>
                  <p class="mt-1 text-[11px] text-ink-faint">{t.cwd} · {t.model}{t.attempts > 1 ? ` · run ${t.attempts}` : ""}</p>
                </details>
                <form
                  class="flex items-end gap-1.5"
                  onsubmit={(e) => {
                    e.preventDefault();
                    void redirect(t);
                  }}
                >
                  <textarea
                    class="min-h-9 flex-1 resize-y rounded-md border border-line bg-canvas px-2 py-1.5 text-[12.5px] text-ink"
                    rows="1"
                    placeholder="Redirect this task…"
                    aria-label="Redirect {t.id}"
                    bind:value={redirectText}
                  ></textarea>
                  <Button variant="outline" size="icon-sm" icon={CornerDownRight} aria-label="Send redirect" title="Send redirect" disabled={busy || !redirectText.trim()} type="submit" />
                  {#if t.status === "running" || t.status === "queued"}
                    <Button variant="ghost" size="icon-sm" icon={Ban} aria-label="Cancel {t.id}" title="Cancel" disabled={busy} onclick={() => cancel(t)} />
                  {/if}
                </form>
                {#if t.sessionId && onopen}
                  <button type="button" class="self-start cursor-pointer text-[12px] text-ink-muted underline decoration-dotted hover:text-ink" onclick={() => onopen?.(t.sessionId)}>Open the worker's session</button>
                {/if}
              </div>
            {/if}
          </li>
        {/each}
      </ul>
      {#if matching.length > shown.length}
        <button type="button" class="interactive m-3 cursor-pointer rounded-md border border-line px-3 py-1.5 text-[12.5px] text-ink-muted hover:text-ink" onclick={() => (limit += PAGE)}>
          Show {Math.min(PAGE, matching.length - shown.length)} more of {matching.length - shown.length}
        </button>
      {/if}
    {/if}
  </div>
</aside>
