<!--
  v6-C: the model router's panel.

  One switch, and everything else in this panel is the evidence for it: what the
  router can see (catalog coverage, connected models, the usage ledger behind the
  quota variable), whether the decision model is reachable, which circuits are
  open right now, and the last decisions with their reasons. A router that picks
  a model silently is a black box; this is the box, opened.

  The switch writes `modelRouterEnabled` through the same settings PATCH the
  WhatsApp `/router on|off` command writes, so the two are one toggle.
-->
<script lang="ts">
  import { untrack } from "svelte";
  import { RotateCcw } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { api } from "../api";
  import { catalog } from "../stores/catalog.svelte";
  import { toasts } from "../stores/toast.svelte";
  import { relativeTime } from "../format";
  import type { RouterDecisionView, RouterPreview, RouterStatusView } from "../types";

  const uid = $props.id();

  let status = $state<RouterStatusView | null>(null);
  let error = $state("");
  let loading = $state(true);
  let saving = $state(false);
  let level = $state<"" | "task" | "delegate" | "subtask">("");
  let previewTask = $state("");
  let preview = $state<RouterPreview | null>(null);
  let previewing = $state(false);
  let resetting = $state("");

  const enabled = $derived(catalog.settings?.modelRouterEnabled === true);
  const openCircuits = $derived((status?.breakers ?? []).filter((b) => b.state !== "closed"));
  const decisions = $derived<RouterDecisionView[]>(status?.decisions ?? []);

  async function load() {
    loading = true;
    error = "";
    try {
      status = await api.router(25, level || undefined);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      loading = false;
    }
  }

  $effect(() => {
    void untrack(load);
  });

  async function toggle(next: boolean) {
    saving = true;
    try {
      await catalog.saveSettings({ modelRouterEnabled: next });
      toasts.push(next ? "Model router on" : "Model router off", {
        detail: next
          ? "Each task, delegated subagent and sub-task picks its own model, with automatic fallback."
          : "The manual model selector is the only thing that picks a model, exactly as before.",
        tone: "ok",
      });
      await load();
    } catch (e) {
      toasts.push("Could not change the router", { detail: (e as Error).message, tone: "err" });
    } finally {
      saving = false;
    }
  }

  async function runPreview() {
    if (!previewTask.trim() || previewing) return;
    previewing = true;
    try {
      preview = await api.routerPreview(previewTask.trim());
    } catch (e) {
      toasts.push("Preview failed", { detail: (e as Error).message, tone: "err" });
    } finally {
      previewing = false;
    }
  }

  async function resetBreaker(model: string) {
    resetting = model;
    try {
      await api.routerResetBreaker(model);
      await load();
    } catch (e) {
      toasts.push("Could not clear the circuit", { detail: (e as Error).message, tone: "err" });
    } finally {
      resetting = "";
    }
  }

  function pct(value: number | null | undefined): string {
    return value === null || value === undefined ? "—" : `${(value * 100).toFixed(0)}%`;
  }
</script>

<div class="flex flex-col gap-5">
  <fieldset class="flex flex-col gap-2">
    <legend class="mb-1 text-[13px] font-medium text-ink">Model router</legend>
    <label
      class="interactive flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand
        {enabled ? 'border-brand bg-brand-soft' : 'border-line hover:bg-raised'}"
    >
      <input
        type="checkbox"
        class="sr-only"
        checked={enabled}
        disabled={saving}
        aria-describedby="{uid}-router-help"
        onchange={(e) => toggle((e.currentTarget as HTMLInputElement).checked)}
      />
      <span class="mt-0.5 grid size-4 shrink-0 place-items-center rounded border {enabled ? 'border-brand bg-brand' : 'border-line-strong'}" aria-hidden="true">
        {#if enabled}<span class="size-1.5 rounded-full bg-canvas"></span>{/if}
      </span>
      <span class="min-w-0 flex-1">
        <span class="block text-[13px] font-medium text-ink">Choose the model automatically</span>
        <span id="{uid}-router-help" class="block text-[12.5px] text-ink-muted">
          A decision model (Laya) picks a model for each new task, each delegated subagent, and each
          sub-task inside a running agent, weighing the remaining quota, the price, the intelligence
          index, real availability and measured latency. A provider that answers 429, 402, 5xx or times
          out is taken out for a while and the next model takes over, without the task noticing. Every
          decision is recorded with its reason.
        </span>
      </span>
      <span class="mt-0.5 shrink-0 text-[12.5px] text-ink-muted">{enabled ? "On" : "Off"}</span>
    </label>
    {#if !enabled}
      <p class="text-[12.5px] text-ink-muted" role="note">
        With the router off, the manual model selector is the only thing that picks a model — nothing else changes.
        The same switch is <code class="font-mono">/router on</code> and <code class="font-mono">/router off</code> in a bound chat.
      </p>
    {/if}
  </fieldset>

  {#if loading}
    <div class="flex flex-col gap-2" role="status" aria-label="Loading router status"><Skeleton class="h-14" /><Skeleton class="h-14" /></div>
  {:else if error}
    <p class="text-[12.5px] text-ink-muted" role="status">
      Could not read the router status: {error}
      <button type="button" class="cursor-pointer text-brand underline underline-offset-2" onclick={() => load()}>Retry</button>
    </p>
  {:else if status}
    <div class="flex flex-col gap-2 rounded-lg border border-line p-3 text-[12.5px] text-ink-muted">
      <div class="flex flex-wrap gap-x-6 gap-y-1">
        <span><span class="text-ink">{status.connected}</span> of {status.catalogModels} catalogued models connected</span>
        <span><span class="text-ink">{status.catalogUnknownIndex}</span> with no sourced intelligence index</span>
        <span><span class="text-ink">{status.decisions24h}</span> decisions in 24h, <span class="text-ink">{status.fallbacks24h}</span> by fallback</span>
      </div>
      <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
        <span>Decision model:</span>
        <Badge tone={status.laya.reachable ? "ok" : "warn"}>{status.laya.reachable ? "reachable" : "unreachable"}</Badge>
        <span class="font-mono text-[11.5px]">{status.layaCheckpoint}</span>
        <span class="text-[11.5px]">{status.laya.detail}</span>
      </div>
      {#if status.laya.reachable === false}
        <p class="text-[11.5px]">
          Without it the router still decides, from the catalog's own index, price and quota: most
          intelligent first, then cheapest. Deterministic, never a coin.
        </p>
      {/if}
    </div>

    {#if openCircuits.length}
      <fieldset class="flex flex-col gap-2">
        <legend class="mb-1 text-[13px] font-medium text-ink">Circuits open</legend>
        <p class="-mt-1 text-[12.5px] text-ink-muted">
          These models were taken out after a failed call. The state survives a restart, so a spent
          quota is not re-entered on the first task after a deploy.
        </p>
        {#each openCircuits as b (b.model)}
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 rounded-lg border border-line p-2.5 text-[12.5px]">
            <span class="font-mono text-ink">{b.model}</span>
            <Badge tone="warn">{b.state}</Badge>
            <span class="text-ink-muted">{b.reason}</span>
            {#if b.retryAt}
              <span class="text-ink-muted">retry {relativeTime(b.retryAt)}</span>
            {/if}
            <span class="ml-auto">
              <Button
                variant="ghost"
                size="sm"
                icon={RotateCcw}
                disabled={resetting === b.model}
                aria-label="Clear the circuit for {b.model}"
                title="Clear the circuit"
                onclick={() => resetBreaker(b.model)}
              />
            </span>
          </div>
        {/each}
      </fieldset>
    {/if}

    <fieldset class="flex flex-col gap-2">
      <legend class="mb-1 text-[13px] font-medium text-ink">Try a task</legend>
      <p class="-mt-1 text-[12.5px] text-ink-muted">Runs the real decision path and records it, exactly as a task would.</p>
      <textarea
        class="field min-h-20 w-full text-[12.5px]"
        rows="3"
        placeholder="design the architecture for the distributed consensus layer and find the race condition"
        aria-label="Task to route"
        bind:value={previewTask}
      ></textarea>
      <div>
        <Button variant="outline" size="sm" disabled={previewing || !previewTask.trim()} onclick={() => runPreview()}>
          {previewing ? "Deciding…" : "Show the decision"}
        </Button>
      </div>
      {#if preview}
        <div class="flex flex-col gap-2 rounded-lg border border-line p-3">
          <div class="flex flex-wrap items-center gap-x-3 gap-y-1 text-[12.5px]">
            <span class="font-medium text-ink">{preview.model || "no model"}</span>
            <Badge tone="brand">{preview.source}</Badge>
            <span class="text-ink-muted">{preview.complexity.complexity} · score {preview.complexity.score.toFixed(2)} · ~{preview.complexity.estimatedTokens} tokens</span>
          </div>
          <p class="text-[12.5px] text-ink-muted">{preview.reason}</p>
          {#if preview.laya.probability !== null}
            <p class="text-[12.5px] text-ink-muted">
              Laya P={preview.laya.probability.toFixed(3)} · confidence {pct(preview.laya.confidence)} · {preview.laya.checkpoint}
            </p>
          {:else if preview.laya.reason}
            <p class="text-[12.5px] text-ink-muted">Laya did not answer: {preview.laya.reason}</p>
          {/if}
          {#if preview.ranking.length}
            <table class="w-full text-left text-[11.5px]">
              <thead class="text-ink-faint">
                <tr>
                  <th class="font-medium">model</th>
                  <th class="font-medium">score</th>
                  <th class="font-medium">why</th>
                </tr>
              </thead>
              <tbody>
                {#each preview.ranking.slice(0, 6) as row (row.model)}
                  <tr class={row.model === preview.model ? "text-ink" : "text-ink-muted"}>
                    <td class="font-mono">{row.model}</td>
                    <td class="tnum">{row.score.toFixed(4)}</td>
                    <td>{row.excluded ? `excluded — ${row.excluded}` : row.why.join(" · ")}</td>
                  </tr>
                {/each}
              </tbody>
            </table>
          {/if}
        </div>
      {/if}
    </fieldset>

    <fieldset class="flex flex-col gap-2">
      <legend class="mb-1 text-[13px] font-medium text-ink">Decisions</legend>
      <div class="flex flex-wrap gap-1.5" role="group" aria-label="Filter decisions by level">
        {#each [["", "All"], ["task", "Task"], ["delegate", "Subagent"], ["subtask", "Sub-task"]] as [value, label] (value)}
          <button
            type="button"
            class="interactive flex min-h-8 cursor-pointer items-center rounded-md border px-2.5 text-[12px] pointer-coarse:min-h-11
              {level === value ? 'border-brand bg-brand-soft text-ink' : 'border-line text-ink-muted hover:text-ink'}"
            aria-pressed={level === value}
            onclick={() => {
              level = value as typeof level;
              void load();
            }}
          >
            {label}
          </button>
        {/each}
      </div>
      {#if !decisions.length}
        <p class="text-[12.5px] text-ink-muted" role="note">No decision recorded yet.</p>
      {:else}
        <ul class="flex flex-col gap-1.5">
          {#each decisions as d (d.id)}
            <li class="flex flex-col gap-0.5 rounded-lg border border-line p-2.5 text-[12px]">
              <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="font-mono text-ink">{d.chosen}</span>
                <Badge tone={d.source === "fallback" ? "warn" : "neutral"}>{d.level} · {d.source}</Badge>
                <span class="text-ink-faint">{relativeTime(d.at)}</span>
                {#if d.from}
                  <span class="text-ink-muted">from {d.from}</span>
                {/if}
              </div>
              <p class="text-ink-muted">{d.reason}</p>
            </li>
          {/each}
        </ul>
      {/if}
    </fieldset>
  {/if}
</div>