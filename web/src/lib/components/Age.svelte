<script lang="ts">
  /**
   * One row's "3m ago" (E53). The words are `ago.ts`'s and the clock is the shared one; this row is
   * woken exactly at the moment its words can change. Before, the label was computed once at render
   * and froze there — measured on the deployed build: "just now" still on screen 80 s later.
   */
  import { relativeTime } from "../format";
  import { clock } from "../stores/clock.svelte";

  let { at, class: klass = "" }: { at: number; class?: string } = $props();

  $effect(() => clock.watchAge("relative", at));
</script>

<span class="tnum {klass}">{relativeTime(at, clock.now)}</span>
