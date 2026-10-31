<script lang="ts">
  import { untrack } from "svelte";
  import { CircleAlert, FolderPlus } from "@lucide/svelte";
  import Modal from "./Modal.svelte";
  import Button from "./Button.svelte";
  import FolderPicker from "./FolderPicker.svelte";
  import RemoteHostsModal from "./RemoteHostsModal.svelte";
  import { store } from "../stores/sessions.svelte";
  import { workspaces } from "../stores/workspaces.svelte";
  import { folderLabel, rememberRecent } from "../folderPath";
  import type { SavedWorkspace } from "../types";

  /**
   * "New workspace": where its sessions run (this machine or a saved remote host), which folder
   * (browse it, or type / paste a path) and, optionally, a name (the folder's own by default).
   */
  let {
    open = $bindable(false),
    onclose,
    oncreated,
  }: {
    open?: boolean;
    onclose: () => void;
    oncreated: (workspace: SavedWorkspace) => void;
  } = $props();

  const uid = $props.id();
  const MANAGE = "__manage-hosts";
  let target = $state("local");
  let path = $state("");
  let name = $state("");
  let busy = $state(false);
  let error = $state("");
  let hostsOpen = $state(false);
  let picker = $state<{ goto: (path: string) => void } | null>(null);
  const host = $derived(store.hosts.find((h) => h.id === target));
  const targetLabel = $derived(host ? host.label : "this machine");
  const fallbackName = $derived(path.trim() ? folderLabel(path.trim()).replace(/^~$/, "home") : "");

  // A fresh form every time it opens; a host that was removed meanwhile falls back to this machine.
  $effect(() => {
    if (!open) return;
    untrack(() => {
      path = "";
      name = "";
      error = "";
      busy = false;
      if (target !== "local" && !store.hosts.some((h) => h.id === target)) target = "local";
    });
  });

  function onTarget(event: Event) {
    const value = (event.currentTarget as HTMLSelectElement).value;
    if (value === MANAGE) {
      (event.currentTarget as HTMLSelectElement).value = target;
      hostsOpen = true;
      return;
    }
    target = value;
    path = "";
    error = "";
  }

  async function create() {
    const p = path.trim();
    if (!p || busy) return;
    busy = true;
    error = "";
    try {
      const created = await workspaces.add({ path: p, name: name.trim() || undefined, hostId: host?.id });
      rememberRecent(target, created.path);
      oncreated(created);
    } catch (e) {
      error = (e as Error).message;
    } finally {
      busy = false;
    }
  }

  function pathKey(event: KeyboardEvent) {
    if (event.key !== "Enter") return;
    event.preventDefault();
    if (path.trim()) picker?.goto(path.trim());
  }
</script>

<Modal bind:open title="New workspace" description="A folder you start sessions in. Its sessions are listed under it in the sidebar." width="max-w-lg" {onclose}>
  <!-- Not a <form>: the folder browser's buttons have no type, and inside a form each one would submit it. -->
  <div class="flex flex-col gap-4">
    <label class="flex flex-col gap-1.5">
      <span class="text-[12px] font-medium text-ink-muted">Runs on</span>
      <select class="h-9 cursor-pointer rounded-md border border-line bg-canvas px-2 text-[13px] text-ink pointer-coarse:h-11" value={target} onchange={onTarget} aria-label="Where its sessions run">
        <option value="local">This machine</option>
        {#each store.hosts as h (h.id)}
          <option value={h.id}>{h.label} ({h.user}@{h.host})</option>
        {/each}
        <option value={MANAGE}>Manage hosts…</option>
      </select>
    </label>

    <div class="flex flex-col gap-1.5">
      <label for="{uid}-path" class="text-[12px] font-medium text-ink-muted">Folder</label>
      <input
        id="{uid}-path"
        bind:value={path}
        onkeydown={pathKey}
        type="text"
        placeholder={host ? "~/repo on " + host.label : "/home/me/projects/app"}
        autocomplete="off"
        autocapitalize="none"
        spellcheck="false"
        aria-describedby="{uid}-path-help"
        class="h-9 rounded-md border border-line bg-canvas px-2.5 font-mono text-[13px] text-ink placeholder:text-ink-faint focus:border-brand/60 focus:outline-none pointer-coarse:h-11"
      />
      <p id="{uid}-path-help" class="text-[11.5px] text-ink-faint">Browse below, or type or paste a path (Enter shows it below).</p>
      {#if open}
        <FolderPicker bind:this={picker} value={path} {target} {targetLabel} onnavigate={(p) => (path = p)} />
      {/if}
    </div>

    <label class="flex flex-col gap-1.5">
      <span class="text-[12px] font-medium text-ink-muted">Name <span class="font-normal text-ink-faint">(optional)</span></span>
      <input
        bind:value={name}
        type="text"
        maxlength="80"
        onkeydown={(e) => {
          if (e.key === "Enter") {
            e.preventDefault();
            void create();
          }
        }}
        placeholder={fallbackName || "The folder's name"}
        class="h-9 rounded-md border border-line bg-canvas px-2.5 text-[13px] text-ink placeholder:text-ink-faint focus:border-brand/60 focus:outline-none pointer-coarse:h-11"
      />
    </label>

    {#if error}
      <div class="flex items-start gap-2 rounded-md bg-err/10 px-2.5 py-2 text-[12.5px] text-err" role="alert">
        <CircleAlert size={13} strokeWidth={2} class="mt-0.5 shrink-0" aria-hidden="true" />
        <span class="min-w-0 flex-1">{error}</span>
      </div>
    {/if}

    <div class="flex items-center justify-end gap-2 pt-1">
      <Button variant="ghost" size="sm" onclick={onclose}>Cancel</Button>
      <Button variant="primary" size="sm" icon={FolderPlus} onclick={() => void create()} loading={busy} disabled={!path.trim() || busy}>Create workspace</Button>
    </div>
  </div>
</Modal>

<RemoteHostsModal bind:open={hostsOpen} />
