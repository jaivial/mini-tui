<script lang="ts">
  import { CornerDownRight, Ban, Link2 } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Markdown from "./Markdown.svelte";
  import SidebarShell from "./sidebar/SidebarShell.svelte";
  import SidebarFilters from "./sidebar/SidebarFilters.svelte";
  import SidebarTask from "./sidebar/SidebarTask.svelte";
  import SidebarEmpty from "./sidebar/SidebarEmpty.svelte";
  import { slide } from "svelte/transition";
  import { reducedMotion } from "../motion";
  const still = reducedMotion();
  import { queue, FILTERS, matches, type QueueFilter } from "../stores/queue.svelte";
  import { clock } from "../stores/clock.svelte";
  import { duration } from "../format";
  import { api } from "../api";
  import { toasts } from "../stores/toast.svelte";
  import type { QueueTask } from "../types";

  /** Task sidebar: composed from app-owned sidebar primitives, not a generic nav rail. */
  let { onclose, onopen, full = false, onfull }: { onclose?: () => void; onopen?: (sessionId: string) => void; full?: boolean; onfull?: () => void } = $props();
  let filter = $state<QueueFilter>("all");
  let openId = $state("");
  let redirectText = $state("");
  let busy = $state(false);
  const PAGE = 100;
  let limit = $state(PAGE);
  $effect(() => { filter; limit = PAGE; });
  const matching = $derived(queue.tasks.filter((task) => matches(task.status, filter)));
  const shown = $derived(matching.slice(0, limit));
  const running = $derived(queue.tasks.some((task) => task.status === "running"));
  $effect(() => { if (running) return clock.watchAge("elapsed", Date.now() - 1000); });

  const TONE: Record<QueueTask["status"], "live" | "neutral" | "ok" | "err" | "warn"> = {
    running: "live", queued: "neutral", done: "ok", error: "err", cancelled: "warn",
  };
  const LABEL: Record<QueueTask["status"], string> = { running: "working", queued: "queued", done: "completed", error: "error", cancelled: "cancelled" };

  function blockerOf(task: QueueTask): string {
    const broad = (path: string) => path === "/" || path === "/tmp" || /^\/home\/[^/]+\/?$/.test(path) || path === "/root";
    if (broad(task.cwd)) return "";
    const inside = (a: string, b: string) => a === b || a.startsWith(`${b}/`) || b.startsWith(`${a}/`);
    return queue.tasks.find((other) => other.status === "running" && !broad(other.cwd) && inside(other.cwd, task.cwd))?.id ?? "";
  }
  function elapsed(task: QueueTask): string {
    if (task.status === "running") return duration(Math.max(0, clock.now - task.startedAt) + task.workSeconds * 1000);
    return task.workSeconds > 0 ? duration(task.workSeconds * 1000) : "";
  }
  async function cancel(task: QueueTask) {
    busy = true;
    try { await api.queueCancel(task.id); }
    catch (error) { toasts.push("Could not cancel", { detail: (error as Error).message, tone: "err" }); }
    finally { busy = false; }
  }
  async function redirect(task: QueueTask) {
    const message = redirectText.trim();
    if (!message) return;
    busy = true;
    try {
      const result = await api.queueRedirect(task.id, message);
      toasts.push(result.text, { tone: "info" });
      redirectText = "";
    } catch (error) { toasts.push("Could not redirect", { detail: (error as Error).message, tone: "err" }); }
    finally { busy = false; }
  }
</script>

<SidebarShell running={queue.counts.running} concurrency={queue.concurrency} {full} {onfull} {onclose}>
  {#snippet filters()}
    <SidebarFilters items={FILTERS} value={filter} counts={queue.counts} onchange={(id) => (filter = id)} />
  {/snippet}

  {#if !queue.loaded}
    <SidebarEmpty loading />
  {:else if !shown.length}
    <SidebarEmpty filtered={queue.tasks.length > 0} />
  {:else}
    <ul class="flex flex-col">
      {#each shown as task (task.id)}
        <SidebarTask
          {task}
          open={openId === task.id}
          elapsed={elapsed(task)}
          blocker={blockerOf(task)}
          label={LABEL[task.status]}
          tone={TONE[task.status]}
          ontoggle={() => { openId = openId === task.id ? "" : task.id; redirectText = ""; }}
        >
          {#snippet details()}
            <div class="flex flex-col gap-3 px-3.5 py-3.5 pl-11 text-[12px]" transition:slide={{ duration: still ? 0 : 200 }}>
              {#if task.result}
                <section>
                  <h3 class="mb-1.5 text-[9px] font-semibold tracking-[0.12em] text-ink-faint uppercase">Result</h3>
                  <div class="rounded-lg border border-line/60 bg-canvas px-3 py-2.5"><Markdown text={task.result} /></div>
                </section>
              {/if}
              {#if task.notes.length}
                <section>
                  <h3 class="mb-1.5 text-[9px] font-semibold tracking-[0.12em] text-ink-faint uppercase">Worker notes</h3>
                  <ul class="flex flex-col gap-1.5">
                    {#each task.notes.slice(-6) as note (note.at + note.text)}
                      <li class="text-[11px] leading-4.5 text-ink-muted"><span class="font-mono text-[9.5px] text-brand">[{note.from}]</span> {note.text}</li>
                    {/each}
                  </ul>
                </section>
              {/if}
              {#if task.related.length}
                <p class="flex flex-wrap items-center gap-1.5 text-[11px] text-ink-muted">
                  <Link2 size={12} aria-hidden="true" /> Related
                  {#each task.related as related (related.id)}<button type="button" class="cursor-pointer text-brand underline decoration-dotted" onclick={() => (openId = related.id)}>{related.id}</button>{/each}
                </p>
              {/if}
              <details class="task-brief rounded-lg border border-line/60 bg-canvas/65 px-2.5 py-2">
                <summary class="cursor-pointer text-[10.5px] text-ink-muted">Brief{task.redirects.length ? ` · ${task.redirects.length} redirect${task.redirects.length > 1 ? "s" : ""}` : ""}</summary>
                <pre class="mt-2 max-h-60 overflow-auto rounded-md bg-surface p-2.5 font-mono text-[10.5px] whitespace-pre-wrap text-ink-muted">{task.prompt}{#each task.redirects as redirect}{"\n\n↳ "}{redirect}{/each}</pre>
                <p class="mt-2 text-[9.5px] text-ink-faint">{task.cwd} · {task.model}{task.attempts > 1 ? ` · run ${task.attempts}` : ""}</p>
              </details>
              <form class="flex items-end gap-1.5" onsubmit={(event) => { event.preventDefault(); void redirect(task); }}>
                <textarea class="min-h-9 flex-1 resize-y rounded-lg border border-line bg-canvas px-2.5 py-2 text-[12px] text-ink outline-none focus:border-brand/60" rows="1" placeholder="Redirect this task…" aria-label="Redirect {task.id}" bind:value={redirectText}></textarea>
                <Button variant="outline" size="icon-sm" icon={CornerDownRight} aria-label="Send redirect" title="Send redirect" disabled={busy || !redirectText.trim()} type="submit" />
                {#if task.status === "running" || task.status === "queued"}<Button variant="ghost" size="icon-sm" icon={Ban} aria-label="Cancel {task.id}" title="Cancel" disabled={busy} onclick={() => cancel(task)} />{/if}
              </form>
              {#if task.sessionId && onopen}<button type="button" class="self-start cursor-pointer text-[10.5px] text-brand underline decoration-dotted underline-offset-2 hover:text-ink" onclick={() => onopen?.(task.sessionId)}>Open worker session →</button>{/if}
            </div>
          {/snippet}
        </SidebarTask>
      {/each}
    </ul>
    {#if matching.length > shown.length}
      <div class="p-3"><button type="button" class="interactive min-h-9 w-full cursor-pointer rounded-lg border border-line/80 bg-canvas/40 px-3 py-2 text-[11px] text-ink-muted hover:bg-raised hover:text-ink" onclick={() => (limit += PAGE)}>Show {Math.min(PAGE, matching.length - shown.length)} more <span class="text-ink-faint">· {matching.length - shown.length} remaining</span></button></div>
    {/if}
  {/if}
</SidebarShell>
