<script lang="ts">
  import { Plus, Server, Trash2, Plug, CheckCircle2, XCircle } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Modal from "./Modal.svelte";
  import { api } from "../api";
  import { store } from "../stores/sessions.svelte";
  import { toasts } from "../stores/toast.svelte";
  import type { RemoteHost } from "../types";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  let editing = $state<RemoteHost | null>(null);
  let probing = $state<string | null>(null);
  let probeResult = $state<Record<string, { ok: boolean; message: string }>>({});

  function blank(): RemoteHost {
    return { id: `h${Date.now().toString(36)}`, label: "", host: "", port: 22, user: "", workdir: "~" };
  }
  function edit(host: RemoteHost) {
    editing = { ...host };
  }
  async function save() {
    if (!editing) return;
    if (!editing.host.trim() || !editing.user.trim()) {
      toasts.push("Host and user are required", { tone: "err" });
      return;
    }
    if (!editing.label.trim()) editing.label = editing.host.trim();
    await api.saveHost({ ...editing, port: Number(editing.port) || 22 });
    await store.load();
    toasts.push(`Saved “${editing.label}”`, { tone: "ok" });
    editing = null;
  }
  async function remove(id: string) {
    await api.deleteHost(id);
    if (editing?.id === id) editing = null;
    await store.load();
  }
  async function probe(host: RemoteHost) {
    probing = host.id;
    try {
      const res = await api.probeHost(host);
      probeResult = { ...probeResult, [host.id]: { ok: res.ok, message: res.message } };
      toasts.push(res.ok ? `Connected to ${host.label}` : `Failed: ${res.message}`, {
        tone: res.ok ? "ok" : "err",
      });
    } catch (error) {
      probeResult = {
        ...probeResult,
        [host.id]: { ok: false, message: (error as Error).message },
      };
    } finally {
      probing = null;
    }
  }
</script>

<Modal
  bind:open
  title="Remote hosts"
  description="Run the agent headless on a server over SSH while the UI stays here. Uses your ~/.ssh/config keys."
  width="max-w-2xl"
  onclose={() => (open = false)}
>
  {#if editing}
    <div class="grid gap-3">
      <div class="grid grid-cols-2 gap-3 max-sm:grid-cols-1">
        <label class="block">
          <span class="mb-1 block text-[11px] font-medium text-ink-muted">Label</span>
          <input bind:value={editing.label} placeholder="prod-web" class="field" />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11px] font-medium text-ink-muted">User</span>
          <input bind:value={editing.user} placeholder="ubuntu" class="field" />
        </label>
      </div>
      <div class="grid grid-cols-3 gap-3">
        <label class="col-span-2 block">
          <span class="mb-1 block text-[11px] font-medium text-ink-muted">Host</span>
          <input bind:value={editing.host} placeholder="server.example.com or 10.0.0.4" class="field font-mono" />
        </label>
        <label class="block">
          <span class="mb-1 block text-[11px] font-medium text-ink-muted">Port</span>
          <input bind:value={editing.port} type="number" class="field tnum" />
        </label>
      </div>
      <label class="block">
        <span class="mb-1 block text-[11px] font-medium text-ink-muted">Remote workdir</span>
        <input bind:value={editing.workdir} placeholder="~/repo" class="field font-mono" />
      </label>
      <label class="block">
        <span class="mb-1 block text-[11px] font-medium text-ink-muted">Identity file (optional)</span>
        <input bind:value={editing.identity} placeholder="~/.ssh/id_ed25519" class="field font-mono" />
      </label>
      <div class="flex justify-end gap-2 pt-1">
        <Button variant="ghost" size="sm" onclick={() => (editing = null)}>Cancel</Button>
        <Button variant="primary" size="sm" onclick={save}>Save host</Button>
      </div>
    </div>
  {:else}
    <div class="flex flex-col gap-3">
      {#if !store.hosts.length}
        <div class="rounded-lg border border-dashed border-line px-4 py-10 text-center">
          <Server size={22} class="mx-auto mb-2 text-ink-faint" strokeWidth={1.5} />
          <p class="text-[13px] font-medium">No remote hosts yet</p>
          <p class="mt-1 text-[12px] text-ink-muted">
            Add a server to run agent sessions headlessly while you keep the UI here.
          </p>
        </div>
      {/if}

      {#each store.hosts as host (host.id)}
        {@const probe_ = probeResult[host.id]}
        <div class="flex items-center gap-3 rounded-lg border border-line bg-surface px-3 py-2.5 elev-1">
          <div class="grid size-8 shrink-0 place-items-center rounded-md bg-raised">
            <Server size={15} class="text-ink-muted" strokeWidth={1.75} />
          </div>
          <button class="min-w-0 flex-1 cursor-pointer py-1 text-left" onclick={() => edit(host)}>
            <div class="flex items-center gap-2">
              <span class="truncate text-[13px] font-medium">{host.label}</span>
              {#if host.online}
                <Badge tone="ok" dot>online</Badge>
              {:else if host.lastError}
                <Badge tone="err" dot>error</Badge>
              {:else}
                <Badge tone="neutral" dot>unknown</Badge>
              {/if}
            </div>
            <div class="tnum mt-0.5 truncate font-mono text-[11px] text-ink-faint">
              {host.user}@{host.host}:{host.port} · {host.workdir}
            </div>
            {#if probe_}
              <div class="mt-1 flex items-center gap-1.5 text-[11px] {probe_.ok ? 'text-ok' : 'text-err'}">
                {#if probe_.ok}<CheckCircle2 size={11} strokeWidth={2} />{:else}<XCircle size={11} strokeWidth={2} />{/if}
                <span class="truncate">{probe_.message}</span>
              </div>
            {/if}
          </button>
          <Button
            variant="outline"
            size="sm"
            icon={Plug}
            loading={probing === host.id}
            onclick={() => probe(host)}
          >Test</Button>
          <Button variant="ghost" size="icon-sm" icon={Trash2} title="Remove" onclick={() => remove(host.id)} />
        </div>
      {/each}

      <div class="pt-1">
        <Button variant="outline" size="sm" icon={Plus} onclick={() => edit(blank())}>Add host</Button>
      </div>
    </div>
  {/if}
</Modal>

<style>
  .field {
    height: 2.25rem;
    width: 100%;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line);
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
