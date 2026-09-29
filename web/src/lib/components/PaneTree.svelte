<script lang="ts">
  import type { Snippet } from "svelte";
  import PaneTree from "./PaneTree.svelte";
  import { clampRatio, MIN_RATIO, type Node } from "../panes";

  /**
   * Renders the pane tree: a split is two flex children and a divider, a leaf is whatever `pane`
   * renders. The divider is a real control: drag it, or focus it and use the arrow keys (5% a step),
   * Home / End for the limits, Enter or a double-click to even it out. It is 1px to look at and 12px
   * to grab (24px under a finger).
   */
  let {
    node,
    pane,
    onresize,
    label,
  }: {
    node: Node;
    pane: Snippet<[string]>;
    onresize: (splitId: string, ratio: number) => void;
    /** Human name of a pane, for the divider's accessible name. */
    label: (paneId: string) => string;
  } = $props();

  let box = $state<HTMLElement | null>(null);
  let dragging = $state(false);

  const first = (n: Node): string => (n.kind === "pane" ? n.id : first(n.a));

  function fromPointer(event: PointerEvent) {
    if (!box || node.kind !== "split") return;
    // getBoundingClientRect and clientX are both viewport pixels, zoomed or not: the ratio is exact.
    const r = box.getBoundingClientRect();
    const ratio = node.dir === "row" ? (event.clientX - r.left) / r.width : (event.clientY - r.top) / r.height;
    onresize(node.id, clampRatio(ratio));
  }

  function down(event: PointerEvent) {
    if (event.button !== 0) return;
    event.preventDefault();
    (event.currentTarget as HTMLElement).setPointerCapture(event.pointerId);
    dragging = true;
  }
  function move(event: PointerEvent) {
    if (dragging) fromPointer(event);
  }
  function up(event: PointerEvent) {
    if (!dragging) return;
    dragging = false;
    (event.currentTarget as HTMLElement).releasePointerCapture(event.pointerId);
  }

  function key(event: KeyboardEvent) {
    if (node.kind !== "split") return;
    const back = node.dir === "row" ? "ArrowLeft" : "ArrowUp";
    const fwd = node.dir === "row" ? "ArrowRight" : "ArrowDown";
    let next: number | null = null;
    if (event.key === back) next = node.ratio - 0.05;
    else if (event.key === fwd) next = node.ratio + 0.05;
    else if (event.key === "Home") next = MIN_RATIO;
    else if (event.key === "End") next = 1 - MIN_RATIO;
    else if (event.key === "Enter") next = 0.5;
    if (next === null) return;
    event.preventDefault();
    onresize(node.id, clampRatio(next));
  }
</script>

{#if node.kind === "pane"}
  {@render pane(node.id)}
{:else}
  <div bind:this={box} class="flex min-h-0 min-w-0 flex-1 {node.dir === 'row' ? 'flex-row' : 'flex-col'}" class:select-none={dragging}>
    <div class="flex min-h-0 min-w-0" style="flex: {node.ratio} 1 0px">
      <PaneTree node={node.a} {pane} {onresize} {label} />
    </div>
    <!-- A focusable separator is the ARIA pattern for a resizer ("window splitter"): it is interactive. -->
    <!-- svelte-ignore a11y_no_noninteractive_tabindex, a11y_no_noninteractive_element_interactions -->
    <div
      role="separator"
      tabindex="0"
      aria-orientation={node.dir === "row" ? "vertical" : "horizontal"}
      aria-valuenow={Math.round(node.ratio * 100)}
      aria-valuemin={Math.round(MIN_RATIO * 100)}
      aria-valuemax={Math.round((1 - MIN_RATIO) * 100)}
      aria-valuetext="{Math.round(node.ratio * 100)}% for {label(first(node.a))}"
      aria-label="Resize {label(first(node.a))} and {label(first(node.b))}"
      title="Drag to resize. Double-click to even out."
      class="divider relative z-20 shrink-0 bg-line/80 {node.dir === 'row' ? 'w-px cursor-col-resize' : 'h-px cursor-row-resize'}"
      class:is-dragging={dragging}
      data-dir={node.dir}
      onpointerdown={down}
      onpointermove={move}
      onpointerup={up}
      onpointercancel={up}
      ondblclick={() => onresize(node.id, 0.5)}
      onkeydown={key}
    ></div>
    <div class="flex min-h-0 min-w-0" style="flex: {1 - node.ratio} 1 0px">
      <PaneTree node={node.b} {pane} {onresize} {label} />
    </div>
  </div>
{/if}

<style>
  /* The grab area: invisible, centred on the 1px line. */
  .divider::before {
    content: "";
    position: absolute;
    touch-action: none;
  }
  .divider[data-dir="row"]::before {
    inset: 0 -6px;
  }
  .divider[data-dir="col"]::before {
    inset: -6px 0;
  }
  @media (pointer: coarse) {
    .divider[data-dir="row"]::before {
      inset: 0 -12px;
    }
    .divider[data-dir="col"]::before {
      inset: -12px 0;
    }
  }
  /* Hover, drag and keyboard focus all say "this moves", in colour and width, never by motion alone. */
  .divider {
    transition-property: background-color, box-shadow;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .divider:hover,
  .divider.is-dragging,
  .divider:focus-visible {
    background: var(--color-brand);
    box-shadow: 0 0 0 1px var(--color-brand);
    outline: none;
  }
</style>
