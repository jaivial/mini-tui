<script lang="ts">
  import { untrack } from "svelte";
  import { Eye, EyeOff, KeyRound, Plug, Trash2, Minus, Plus, RotateCcw } from "@lucide/svelte";
  import { TEXT_SCALES, UI_SCALES, percent, stepScale } from "../scale";
  import Modal from "./Modal.svelte";
  import Tabs from "./Tabs.svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Skeleton from "./Skeleton.svelte";
  import { catalog } from "../stores/catalog.svelte";
  import { ui, PALETTES } from "../stores/ui.svelte";
  import { toasts } from "../stores/toast.svelte";
  import { api } from "../api";
  import { relativeTime } from "../format";
  import type { ProviderCatalogEntry } from "../types";

  let {
    open = $bindable(false),
    tab = $bindable("general"),
    onclose,
  }: { open?: boolean; tab?: string; onclose: () => void } = $props();

  const uid = $props.id();
  const TABS = [
    { id: "general", label: "General" },
    { id: "providers", label: "Providers" },
    { id: "skills", label: "Skills" },
  ];

  // Load what a tab needs when it is first shown, not when the app boots.
  $effect(() => {
    if (!open) return;
    const t = tab;
    // Only `open` and `tab` decide when to load; what the loaders read must not re-trigger this.
    untrack(() => {
      void catalog.loadSettings();
      if (t === "providers") void catalog.loadProviders();
      if (t === "skills") void catalog.loadSkills();
    });
  });

  // ---- providers: one connect form at a time
  let connecting = $state<ProviderCatalogEntry | null>(null);
  let key = $state("");
  let reveal = $state(false);
  let testing = $state(false);
  let formError = $state("");
  let removing = $state("");
  let filter = $state("");

  const connectedIds = $derived(new Set(catalog.connected.map((p) => p.id)));
  const available = $derived(
    catalog.catalog.filter(
      (p) => !connectedIds.has(p.id) && (!filter.trim() || `${p.name} ${p.description} ${p.id}`.toLowerCase().includes(filter.trim().toLowerCase())),
    ),
  );

  function startConnect(p: ProviderCatalogEntry) {
    connecting = p;
    key = "";
    reveal = false;
    formError = "";
  }

  function cancelConnect() {
    connecting = null;
    key = ""; // a key is never kept around once the form is gone
    formError = "";
  }

  async function submitConnect() {
    const p = connecting;
    if (!p || testing || !key.trim()) return;
    testing = true;
    formError = "";
    try {
      const result = await api.connectProvider(p.id, key.trim());
      if (!result.ok) {
        formError = result.error;
        return;
      }
      toasts.push(`${p.name} connected`, { detail: `${result.provider.models.length} models available`, tone: "ok" });
      cancelConnect();
      await catalog.loadProviders(true);
    } catch (error) {
      formError = (error as Error).message;
    } finally {
      testing = false;
    }
  }

  async function disconnect(id: string, name: string) {
    removing = id;
    try {
      await api.disconnectProvider(id);
      toasts.push(`${name} disconnected`, { tone: "info" });
      await catalog.loadProviders(true);
    } catch (error) {
      toasts.push("Could not disconnect", { detail: (error as Error).message, tone: "err" });
    } finally {
      removing = "";
    }
  }

  async function setOutput(value: string) {
    try {
      await catalog.saveSettings({ outputMode: value });
    } catch (error) {
      toasts.push("Could not save the setting", { detail: (error as Error).message, tone: "err" });
    }
  }
</script>

<Modal bind:open title="Settings" description="How mini-tui looks and which providers it can use." width="max-w-2xl" {onclose}>
  <div class="flex flex-col gap-5">
    <Tabs tabs={TABS} bind:value={tab} idBase={uid} label="Settings sections" />

    {#if tab === "general"}
      <div role="tabpanel" id="{uid}-panel-general" aria-labelledby="{uid}-tab-general" class="flex flex-col gap-6">
        <fieldset class="flex flex-col gap-2">
          <legend class="mb-1 text-[13px] font-medium text-ink">Appearance</legend>
          <div class="flex flex-wrap gap-2" role="group" aria-label="Color mode">
            {#each [["dark", "Dark"], ["light", "Light"]] as [value, label] (value)}
              <button
                type="button"
                class="interactive flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-[13px] pointer-coarse:min-h-11
                  {ui.theme === value ? 'border-brand bg-brand-soft text-ink' : 'border-line text-ink-muted hover:text-ink'}"
                aria-pressed={ui.theme === value}
                onclick={() => ui.theme !== value && ui.toggleTheme()}
              >
                {label}
              </button>
            {/each}
          </div>
          <div class="flex flex-wrap gap-2" role="group" aria-label="Accent palette">
            {#each PALETTES as p (p.id)}
              <button
                type="button"
                class="interactive flex min-h-9 cursor-pointer items-center gap-2 rounded-md border px-3 text-[13px] pointer-coarse:min-h-11
                  {ui.palette === p.id ? 'border-brand bg-brand-soft text-ink' : 'border-line text-ink-muted hover:text-ink'}"
                aria-pressed={ui.palette === p.id}
                onclick={() => ui.setPalette(p.id)}
              >
                <span class="size-3 rounded-full" style="background: {p.swatch}" aria-hidden="true"></span>
                {p.name}
              </button>
            {/each}
          </div>
        </fieldset>

        <fieldset class="flex flex-col gap-3">
          <legend class="mb-1 text-[13px] font-medium text-ink">Size</legend>
          <p class="-mt-1 text-[12.5px] text-ink-muted">Saved in this browser. Shortcuts: Ctrl/⌘ + and − for the interface, with Shift for text; Ctrl/⌘ 0 resets.</p>
          {#each [
            { id: "ui", label: "Interface size", help: "Everything: panels, buttons, icons and text, like zooming the page.", value: ui.uiScale, steps: UI_SCALES, set: (v: number) => ui.setUiScale(v) },
            { id: "text", label: "Text size", help: "Only what you read and write: the conversation, command output, the prompt and notes.", value: ui.textScale, steps: TEXT_SCALES, set: (v: number) => ui.setTextScale(v) },
          ] as row (row.id)}
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2 rounded-lg border border-line p-3">
              <div class="min-w-0 flex-1 basis-56">
                <div id="{uid}-{row.id}-label" class="text-[13px] font-medium text-ink">{row.label}</div>
                <div id="{uid}-{row.id}-help" class="text-[12.5px] text-ink-muted">{row.help}</div>
              </div>
              <div class="flex items-center gap-1" role="group" aria-labelledby="{uid}-{row.id}-label" aria-describedby="{uid}-{row.id}-help">
                <Button variant="outline" size="icon-sm" icon={Minus} aria-label="Smaller" title="Smaller" disabled={row.value === row.steps[0]} onclick={() => row.set(stepScale(row.value, -1, row.steps))} />
                <select
                  class="h-8 cursor-pointer rounded-md border border-line bg-canvas px-2 text-ink tnum pointer-coarse:h-11"
                  aria-label={row.label}
                  value={String(row.value)}
                  onchange={(e) => row.set(Number((e.currentTarget as HTMLSelectElement).value))}
                >
                  {#each row.steps as step (step)}
                    <option value={String(step)}>{percent(step)}{step === 1 ? " (default)" : ""}</option>
                  {/each}
                </select>
                <Button variant="outline" size="icon-sm" icon={Plus} aria-label="Larger" title="Larger" disabled={row.value === row.steps[row.steps.length - 1]} onclick={() => row.set(stepScale(row.value, 1, row.steps))} />
                <Button variant="ghost" size="icon-sm" icon={RotateCcw} aria-label="Reset {row.label.toLowerCase()} to 100%" title="Reset to 100%" disabled={row.value === 1} onclick={() => row.set(1)} />
              </div>
            </div>
          {/each}
          {#if ui.coarse && ui.uiScale < 1}
            <p class="text-[12.5px] text-ink-muted" role="note">On a touch screen the interface stays at 100% or larger, so every button stays big enough to tap. {percent(ui.uiScale)} applies with a mouse.</p>
          {/if}
          <!-- A live preview at the chosen sizes, so the change is seen before closing. -->
          <div class="rounded-lg bg-surface px-3.5 py-3" aria-hidden="true">
            <div class="mb-1 text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Preview</div>
            <p class="read-[13.5px] text-ink">The retry now waits 200 ms, then 400 ms, then gives up.</p>
            <p class="mt-1 font-mono read-[11.5px] text-ink-muted">$ bun test tests/upload.test.ts</p>
          </div>
        </fieldset>

        <fieldset class="flex flex-col gap-2">
          <legend class="text-[13px] font-medium text-ink">Command output</legend>
          <p class="text-[12.5px] text-ink-muted" id="{uid}-out-help">How much of each command's output the transcript shows. The terminal UI uses the same setting.</p>
          {#if catalog.settings}
            <div role="radiogroup" aria-labelledby="{uid}-out-help" class="flex flex-col gap-1.5">
              {#each catalog.settings.outputModes as mode (mode.value)}
                <label
                  class="interactive flex min-h-11 cursor-pointer items-start gap-3 rounded-lg border p-3 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-brand
                    {catalog.settings.outputMode === mode.value ? 'border-brand bg-brand-soft' : 'border-line hover:bg-raised'}"
                >
                  <input
                    type="radio"
                    name="{uid}-output"
                    class="sr-only"
                    value={mode.value}
                    checked={catalog.settings.outputMode === mode.value}
                    onchange={() => setOutput(mode.value)}
                  />
                  <span class="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border {catalog.settings.outputMode === mode.value ? 'border-brand' : 'border-line-strong'}" aria-hidden="true">
                    {#if catalog.settings.outputMode === mode.value}<span class="size-2 rounded-full bg-brand"></span>{/if}
                  </span>
                  <span class="min-w-0">
                    <span class="block text-[13px] font-medium text-ink">{mode.name}</span>
                    <span class="block text-[12.5px] text-ink-muted">{mode.description}</span>
                  </span>
                </label>
              {/each}
            </div>
          {:else}
            <div class="flex flex-col gap-1.5" role="status" aria-label="Loading settings"><Skeleton class="h-14" /><Skeleton class="h-14" /><Skeleton class="h-14" /></div>
          {/if}
        </fieldset>
      </div>
    {:else if tab === "providers"}
      <div role="tabpanel" id="{uid}-panel-providers" aria-labelledby="{uid}-tab-providers" class="flex flex-col gap-5">
        {#if connecting}
          <!-- One provider, one key. The key is masked, never logged, and cleared when this closes. -->
          <form
            class="flex flex-col gap-3 rounded-lg border border-line bg-surface p-4"
            onsubmit={(event) => {
              event.preventDefault();
              void submitConnect();
            }}
            aria-busy={testing}
          >
            <div>
              <h3 class="text-[14px] font-medium text-ink">Connect {connecting.name}</h3>
              <p class="mt-0.5 text-[12.5px] text-ink-muted">{connecting.description}. The key is tested with a real request, then stored on this server only.</p>
            </div>
            <div class="flex flex-col gap-1">
              <label for="{uid}-key" class="text-[12.5px] font-medium text-ink-muted">API key</label>
              <div class="flex gap-2">
                <input
                  id="{uid}-key"
                  bind:value={key}
                  type={reveal ? "text" : "password"}
                  autocomplete="off"
                  autocapitalize="none"
                  autocorrect="off"
                  spellcheck="false"
                  enterkeyhint="go"
                  required
                  disabled={testing}
                  aria-invalid={formError ? true : undefined}
                  aria-describedby={formError ? `${uid}-key-err` : undefined}
                  placeholder="Paste your key"
                  class="field min-w-0 flex-1 font-mono"
                />
                <Button variant="outline" size="icon" icon={reveal ? EyeOff : Eye} aria-label={reveal ? "Hide key" : "Show key"} title={reveal ? "Hide key" : "Show key"} onclick={() => (reveal = !reveal)} />
              </div>
              {#if formError}
                <p id="{uid}-key-err" role="alert" class="text-[12.5px] text-err">{formError}</p>
              {/if}
            </div>
            <div class="flex justify-end gap-2">
              <Button variant="ghost" size="sm" onclick={cancelConnect} disabled={testing}>Cancel</Button>
              <Button variant="primary" size="sm" icon={Plug} loading={testing} disabled={!key.trim()} onclick={submitConnect}>
                {testing ? "Testing…" : "Connect"}
              </Button>
            </div>
          </form>
        {/if}

        <section aria-labelledby="{uid}-connected" class="flex flex-col gap-2">
          <h3 id="{uid}-connected" class="text-[13px] font-medium text-ink">Connected</h3>
          {#if catalog.providersStatus === "loading" && !catalog.connected.length}
            <div class="flex flex-col gap-2" role="status" aria-label="Loading providers"><Skeleton class="h-14" /><Skeleton class="h-14" /></div>
          {:else if catalog.providersStatus === "error"}
            <p class="text-[12.5px] text-ink-muted" role="status">
              Could not load providers. <button type="button" class="cursor-pointer text-brand underline underline-offset-2" onclick={() => catalog.loadProviders(true)}>Retry</button>
            </p>
          {:else if !catalog.connected.length}
            <p class="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-ink-muted">No providers connected yet. Pick one below and paste a key.</p>
          {:else}
            <ul class="flex flex-col gap-2">
              {#each catalog.connected as p (p.id)}
                <li class="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5">
                  <span class="grid size-8 shrink-0 place-items-center rounded-md bg-raised" aria-hidden="true"><KeyRound size={15} strokeWidth={1.75} class="text-ink-muted" /></span>
                  <div class="min-w-0 flex-1">
                    <div class="flex flex-wrap items-center gap-2">
                      <span class="truncate text-[13px] font-medium text-ink">{p.name}</span>
                      <Badge tone="ok" dot>connected</Badge>
                    </div>
                    <div class="tnum mt-0.5 truncate text-[12px] text-ink-muted">
                      <span class="font-mono">{p.keyHint}</span> · {p.models.length} models · added {relativeTime(p.addedAt)}
                    </div>
                  </div>
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    icon={Trash2}
                    aria-label="Disconnect {p.name}"
                    title="Disconnect {p.name}"
                    loading={removing === p.id}
                    onclick={() => disconnect(p.id, p.name)}
                  />
                </li>
              {/each}
            </ul>
          {/if}
        </section>

        <section aria-labelledby="{uid}-available" class="flex flex-col gap-2">
          <div class="flex items-center justify-between gap-3">
            <h3 id="{uid}-available" class="text-[13px] font-medium text-ink">Add a provider</h3>
            <input bind:value={filter} type="search" aria-label="Filter providers" placeholder="Filter" class="field w-40" />
          </div>
          {#if catalog.providersStatus === "loading" && !catalog.catalog.length}
            <div class="flex flex-col gap-2" role="status" aria-label="Loading providers"><Skeleton class="h-12" /><Skeleton class="h-12" /></div>
          {:else if !available.length}
            <p class="px-1 py-3 text-[12.5px] text-ink-muted">{filter ? `No provider matches “${filter}”.` : "Every provider is connected."}</p>
          {:else}
            <ul class="grid gap-2 sm:grid-cols-2">
              {#each available as p (p.id)}
                <li>
                  <button
                    type="button"
                    class="interactive flex min-h-11 w-full cursor-pointer items-start gap-3 rounded-lg border border-line p-3 text-left hover:bg-raised {connecting?.id === p.id ? 'border-brand bg-brand-soft' : ''}"
                    aria-label="Connect {p.name}"
                    onclick={() => startConnect(p)}
                  >
                    <span class="min-w-0 flex-1">
                      <span class="block truncate text-[13px] font-medium text-ink">{p.name}</span>
                      <span class="block truncate text-[12px] text-ink-muted">{p.description}</span>
                    </span>
                    <Plug size={14} strokeWidth={1.75} class="mt-0.5 shrink-0 text-ink-muted" aria-hidden="true" />
                  </button>
                </li>
              {/each}
            </ul>
          {/if}
        </section>
      </div>
    {:else}
      <div role="tabpanel" id="{uid}-panel-skills" aria-labelledby="{uid}-tab-skills" class="flex flex-col gap-3">
        <p class="text-[12.5px] text-ink-muted">Type <span class="font-mono text-ink">$name</span> anywhere in a message to give the agent that skill's instructions.</p>
        {#if catalog.skillsStatus === "loading" && !catalog.skills.length}
          <div class="flex flex-col gap-2" role="status" aria-label="Loading skills"><Skeleton class="h-12" /><Skeleton class="h-12" /><Skeleton class="h-12" /></div>
        {:else if catalog.skillsStatus === "error"}
          <p class="text-[12.5px] text-ink-muted" role="status">Could not load skills. <button type="button" class="cursor-pointer text-brand underline underline-offset-2" onclick={() => catalog.loadSkills(true)}>Retry</button></p>
        {:else if !catalog.skills.length}
          <p class="rounded-lg border border-dashed border-line px-4 py-6 text-center text-[12.5px] text-ink-muted">No skills installed. Add a folder with a SKILL.md to ~/.config/mini-tui/skills.</p>
        {:else}
          <ul class="flex flex-col gap-1.5">
            {#each catalog.skills as s (s.name)}
              <li class="rounded-lg border border-line px-3 py-2">
                <div class="font-mono text-[12.5px] font-medium text-ink">${s.name}</div>
                {#if s.description}<div class="mt-0.5 line-clamp-2 text-[12.5px] text-ink-muted">{s.description}</div>{/if}
              </li>
            {/each}
          </ul>
        {/if}
      </div>
    {/if}
  </div>
</Modal>

<style>
  .field {
    height: 2.25rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line-strong);
    background: var(--color-canvas);
    padding: 0 0.65rem;
    font-size: 16px;
    color: var(--color-ink);
  }
  @media (pointer: coarse) {
    .field {
      height: 2.75rem;
    }
  }
  .field:focus {
    border-color: var(--color-brand);
    outline: none;
  }
  .field::placeholder {
    color: var(--color-ink-faint);
  }
</style>
