<script lang="ts">
  /** Refits the graph whenever agents appear or disappear (the SSE stream changes the count). */
  import { useSvelteFlow } from "@xyflow/svelte";
  let { count }: { count: number } = $props();
  const { fitView } = useSvelteFlow();
  $effect(() => {
    count;
    // Node measurement is async: refit a few times after a change so the final layout sticks.
    const timers = [120, 400, 900].map((ms) =>
      setTimeout(() => {
        void fitView({ padding: 0.2, duration: 250 });
      }, ms),
    );
    return () => timers.forEach(clearTimeout);
  });
</script>
