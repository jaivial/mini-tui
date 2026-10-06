<script lang="ts">
  /**
   * A session's DAG plan, as the task board draws it: topological layers of task nodes, each with
   * the deps that unlock it (the edges), colored by status and live while the hub updates the
   * plan. The plan's own words are what the nodes show; the drawing is `web/src/lib/plan.ts`.
   */
  import { dagEdges, dagLayers, planCountEntries } from "../plan";
  import type { SessionPlan } from "../types";

  let { plan }: { plan: SessionPlan } = $props();

  const layers = $derived(dagLayers(plan.tasks));
  const edges = $derived(dagEdges(plan.tasks));
  const counts = $derived(planCountEntries(plan.tasks));

  /** A status as the board colors it: live work brand, done ok, trouble err, waiting faint. */
  function dot(status: string): string {
    switch (status) {
      case "running":
      case "ready":
        return "bg-brand";
      case "review":
        return "bg-warn";
      case "done":
        return "bg-ok";
      case "failed":
      case "blocked":
        return "bg-err";
      default:
        return "border border-line-strong";
    }
  }
</script>

<div class="flex flex-col gap-1.5" data-testid="plan-dag">
  <div class="flex items-baseline gap-2 text-[10px] tracking-wider text-ink-faint uppercase">
    <span>plan</span>
    <span class="tnum normal-case">
      {plan.tasks.length} tasks
      {#each counts as [status, n] (status)}
        <span class="ml-1.5"><span class="inline-block size-1.5 rounded-full align-middle {dot(status)}" aria-hidden="true"></span> {n} {status}</span>
      {/each}
    </span>
  </div>
  {#each layers as layer, i (i)}
    <div class="flex flex-wrap items-start gap-1.5">
      {#if i > 0}<span class="mt-1.5 text-[10px] text-ink-faint" aria-hidden="true">↓</span>{/if}
      {#each layer as task (task.id)}
        <div
          class="min-w-0 rounded-md border border-line px-1.5 py-1"
          data-task={task.id}
          data-status={task.status}
          title={task.result || task.error || task.title}
        >
          <div class="flex items-center gap-1.5">
            <span class="inline-block size-1.5 shrink-0 rounded-full {dot(task.status)}" aria-hidden="true"></span>
            <span class="tnum text-[11px] font-semibold">{task.id}</span>
            <span class="truncate text-[11px] text-ink-muted">{task.title}</span>
          </div>
          {#if task.deps.length}
            <div class="mt-0.5 text-[10px] text-ink-faint">← {task.deps.join(", ")}</div>
          {/if}
        </div>
      {/each}
    </div>
  {/each}
  {#if edges.length}
    <div class="tnum text-[10px] text-ink-faint">
      {edges.map((e) => `${e.from} → ${e.to}`).join(" · ")}
    </div>
  {/if}
</div>
