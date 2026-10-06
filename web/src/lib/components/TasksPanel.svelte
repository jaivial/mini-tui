<script lang="ts">
  import { Check, ChevronRight, ListChecks, X } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import { todoCounts, whereLabel, type TaskRow } from "../tasks";

  /**
   * The window's task board: every session with a task card (the agents fill them with
   * `mini-tui tasks set`), what the task is and what is left of it, and the pane showing that
   * session right now. A drawer on the window's right edge — one click of the window's button
   * opens it, and it stays live while open: a card written anywhere lands in it at once.
   *
   * Each card is a title (always visible) with its description and to-dos in an accordion.
   */
  let {
    open = false,
    onclose,
    rows,
    live = false,
  }: {
    open?: boolean;
    onclose: () => void;
    rows: TaskRow[];
    live?: boolean;
  } = $props();

  let dialog: HTMLDialogElement | undefined = $state();

  // Not a modal: the drawer sits over the window's right edge while the app keeps working behind
  // it — the board is watched live precisely so it can stay open beside the work it describes.
  $effect(() => {
    if (!dialog) return;
    if (open && !dialog.open) dialog.show();
    else if (!open && dialog.open) dialog.close();
  });

  // `close` also fires for programmatic closes; everything lands in one place.
  function oncloseevent(event: Event) {
    event.preventDefault();
    onclose();
  }

  /** Escape closes the drawer. */
  function onkey(event: KeyboardEvent) {
    if (open && event.key === "Escape") {
      event.preventDefault();
      onclose();
    }
  }

  /** A press outside the drawer (and outside the button that opened it) closes it too. */
  function onpress(event: PointerEvent) {
    if (!open) return;
    const el = event.target as HTMLElement | null;
    if (el?.closest?.("dialog[aria-label=\"Session tasks\"], [aria-label=\"Session tasks\"], [role=\"tooltip\"]")) return;
    onclose();
  }
</script>

<svelte:window onkeydown={onkey} onpointerdown={onpress} />

<dialog
  bind:this={dialog}
  class="m-0 ml-auto h-[calc(100*var(--vh))] max-h-[calc(100*var(--vh))] w-[26rem] max-w-[calc(100*var(--vw))] rounded-none border-l border-line bg-canvas p-0 text-ink shadow-2xl"
  aria-label="Session tasks"
  onclose={oncloseevent}
>
  <div class="flex h-full min-h-0 flex-col" role="document">
    <header class="flex items-center gap-2 border-b border-line/80 px-4 py-3">
      <ListChecks size={15} strokeWidth={2} class="shrink-0 text-brand" aria-hidden="true" />
      <h2 class="min-w-0 flex-1 text-[14px] leading-5 font-medium">Session tasks</h2>
      <span class="flex items-center gap-1.5 text-[11px] text-ink-faint" title={live ? "Live" : "Reconnecting…"}>
        <span class="size-1.5 shrink-0 rounded-full {live ? 'bg-ok' : 'pulse-live bg-warn'}" aria-hidden="true"></span>
        <span class="tnum">{rows.length}</span>
      </span>
      <Button variant="ghost" size="icon-sm" icon={X} title="Close" aria-label="Close session tasks" onclick={onclose} />
    </header>

    <div class="min-h-0 flex-1 overflow-y-auto overscroll-contain px-2 py-2">
      {#if !rows.length}
        <p class="px-2 py-6 text-[12.5px] leading-5 text-ink-muted">
          No task cards yet. Every agent fills one while it works (<code class="rounded-sm bg-overlay px-1 py-0.5 text-[11px]">mini-tui tasks set</code>):
          a title, a description of what was done, and its to-dos. They appear here the moment they are written.
        </p>
      {:else}
        {#each rows as row (row.task.id)}
          {@const c = todoCounts(row.task)}
          <details class="group rounded-lg border border-transparent px-2 py-1.5 hover:border-line hover:bg-raised/50">
            <summary class="flex cursor-pointer list-none items-start gap-2 [&::-webkit-details-marker]:hidden">
              <ChevronRight
                size={13}
                strokeWidth={2}
                class="mt-0.5 shrink-0 text-ink-faint transition-transform group-open:rotate-90"
                aria-hidden="true"
              />
              <div class="min-w-0 flex-1">
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate text-[12.5px] leading-5 font-medium text-ink">{row.sessionTitle}</span>
                  <span
                    class="shrink-0 rounded-sm {row.where ? 'bg-overlay text-ink-muted' : 'text-ink-faint'} px-1.5 py-0.5 text-[10px]"
                    title={whereLabel(row.where)}
                  >
                    {whereLabel(row.where)}
                  </span>
                </div>
                <div class="flex items-baseline gap-2">
                  <span class="min-w-0 flex-1 truncate text-[12px] leading-5 text-ink-muted">{row.task.title || "(no title)"}</span>
                  <span class="tnum shrink-0 text-[10.5px] text-ink-faint">
                    {c.done} done · {c.pending} pending · {c.left} left
                  </span>
                </div>
              </div>
            </summary>

            <div class="mt-1.5 pl-5 text-[12px] leading-5">
              {#if row.task.description}
                <p class="whitespace-pre-wrap text-ink-muted">{row.task.description}</p>
              {/if}
              {#each [["done", row.task.todos.done], ["pending", row.task.todos.pending], ["left", row.task.todos.left]] as [kind, items] (kind)}
                {#if items.length}
                  <div class="mt-1.5">
                    <div class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">{kind}</div>
                    <ul class="mt-0.5 flex flex-col gap-0.5">
                      {#each items as item}
                        <li class="flex items-start gap-1.5 {kind === 'done' ? 'text-ink-faint line-through' : 'text-ink'}">
                          {#if kind === "done"}
                            <Check size={12} strokeWidth={2.5} class="mt-1 shrink-0 text-ok" aria-hidden="true" />
                          {:else}
                            <span
                              class="mt-1.5 size-1.5 shrink-0 rounded-full {kind === 'pending' ? 'bg-warn' : 'border border-line-strong'}"
                              aria-hidden="true"
                            ></span>
                          {/if}
                          <span class="min-w-0">{item}</span>
                        </li>
                      {/each}
                    </ul>
                  </div>
                {/if}
              {/each}
              {#if !row.task.description && !c.done && !c.pending && !c.left}
                <p class="text-ink-faint">This card has no description or to-dos yet.</p>
              {/if}
            </div>
          </details>
        {/each}
      {/if}
    </div>

    <footer class="border-t border-line/80 px-4 py-2 text-[10.5px] leading-4 text-ink-faint">
      Filled by the agents themselves (<code class="rounded-sm bg-overlay px-1">mini-tui tasks set</code>), updated live while they work.
    </footer>
  </div>
</dialog>
