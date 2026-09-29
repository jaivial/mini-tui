<script lang="ts">
  import { SquareSlash, Sparkles, X } from "@lucide/svelte";
  import type { Chip } from "../chips";

  /**
   * A command or skill picked in the prompt bar. The tint is the second cue after the sigil and icon:
   * a command is neutral (it does something in this app), a skill is accent (it is sent to the agent).
   * Removing has a real button with the chip's name in its label, 44px on touch through padding rather
   * than a taller chip, so a row of chips stays compact.
   */
  let { chip, onremove }: { chip: Chip; onremove: () => void } = $props();

  const label = $derived(`${chip.kind === "command" ? "Command" : "Skill"} ${chip.name}`);
</script>

<span
  role="group"
  aria-label={label}
  class="chip inline-flex h-7 max-w-full items-center gap-1 rounded-md border pr-0.5 pl-2 text-[12.5px] font-medium
    {chip.kind === 'command' ? 'border-line-strong bg-raised text-ink' : 'border-brand/40 bg-brand-soft text-ink'}"
>
  {#if chip.kind === "command"}
    <SquareSlash size={13} strokeWidth={2} class="shrink-0 text-ink-muted" aria-hidden="true" />
  {:else}
    <Sparkles size={13} strokeWidth={2} class="shrink-0 text-brand" aria-hidden="true" />
  {/if}
  <span class="min-w-0 truncate font-mono">{chip.name}</span>
  <button
    type="button"
    class="interactive relative grid size-6 shrink-0 cursor-pointer place-items-center rounded-sm text-ink-muted hover:bg-line hover:text-ink
      before:absolute before:-inset-2.5 before:content-[''] pointer-fine:before:hidden"
    aria-label="Remove {label}"
    title="Remove"
    onclick={onremove}
  >
    <X size={12} strokeWidth={2.25} aria-hidden="true" />
  </button>
</span>

<style>
  /* Arrives with a small settle, not a pop: the pick has just left the menu. */
  .chip {
    animation: pop-in var(--duration-fast) var(--ease-standard) both;
  }
</style>
