<script lang="ts">
  import { untrack } from "svelte";
  import { slide } from "svelte/transition";
  import { flip } from "svelte/animate";
  import { Blocks, Check, Copy, ExternalLink, LogIn, LogOut, Plus, Power, RefreshCw, Trash2, X, Link2, ClipboardPaste, Wrench, ChevronDown } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import Badge from "./Badge.svelte";
  import Skeleton from "./Skeleton.svelte";
  import Spinner from "./Spinner.svelte";
  import { api } from "../api";
  import { toasts } from "../stores/toast.svelte";
  import { clock } from "../stores/clock.svelte";
  import { enter, lift, popIn, pulse, shake } from "../motion";
  import type { McpLogin, McpPreset, McpServerView } from "../types";

  /**
   * Settings → MCP. Install remote MCP servers and log in to the ones that use OAuth (Figma,
   * Linear, Notion…). The login opens the provider in a popup; the server receives the redirect
   * on `/api/mcp/oauth/callback`, swaps the code for tokens and proves them against the MCP
   * server, and this panel notices on its own (the popup's message, or the poll as a fallback).
   */
  let { open = true }: { open?: boolean } = $props();
  const uid = $props.id();

  let servers = $state<McpServerView[]>([]);
  let presets = $state<McpPreset[]>([]);
  let status = $state<"loading" | "ready" | "error">("loading");
  let busy = $state<Record<string, string>>({});
  let tools = $state<Record<string, { name: string; description?: string }[]>>({});
  let expanded = $state<Record<string, boolean>>({});

  // The custom-URL form.
  let customOpen = $state(false);
  let customUrl = $state("");
  let customName = $state("");
  let customAdvanced = $state(false);
  let customClientName = $state("");
  let customClientId = $state("");
  let customClientSecret = $state("");
  let customHeader = $state("");
  let customError = $state("");
  let customForm = $state<HTMLElement | null>(null);

  // The login in flight (one at a time).
  let login = $state<McpLogin | null>(null);
  let popup: Window | null = null;
  let pasteOpen = $state(false);
  let pasteText = $state("");
  let pasteError = $state("");
  let copied = $state(false);

  const installedPresets = $derived(new Set(servers.map((s) => s.preset).filter(Boolean)));
  const available = $derived(presets.filter((p) => !installedPresets.has(p.id)));

  async function load() {
    try {
      const r = await api.mcp();
      servers = r.servers;
      presets = r.presets;
      status = "ready";
    } catch {
      status = "error";
    }
  }

  $effect(() => {
    if (open) untrack(() => void load());
  });

  const STATE: Record<McpServerView["state"], { tone: "ok" | "warn" | "neutral" | "err"; label: string }> = {
    connected: { tone: "ok", label: "connected" },
    ready: { tone: "ok", label: "ready" },
    "needs-login": { tone: "warn", label: "needs login" },
    expired: { tone: "err", label: "login expired" },
    disabled: { tone: "neutral", label: "disabled" },
  };

  function setBusy(id: string, what: string) {
    busy = { ...busy, [id]: what };
  }
  function clearBusy(id: string) {
    const { [id]: _, ...rest } = busy;
    busy = rest;
  }

  /**
   * A popup opened INSIDE the click. Browsers only allow `window.open` during the user's gesture;
   * after the install and probe round trips (a second or more against Figma) Safari and Firefox
   * block it. So it opens now, blank with a "connecting" note, and is pointed at the provider later.
   */
  function openPopup(name: string): Window | null {
    const w = window.open("", `mcp-login-${name}`, "popup,width=520,height=720");
    try {
      w?.document.write(
        `<title>Connecting…</title><body style="margin:0;display:grid;place-items:center;height:100vh;font:14px system-ui;color:#5d5d68">Connecting to ${name.replace(/[^\w .-]/g, "")}…</body>`,
      );
    } catch {
      // a cross-origin leftover window: it is navigated anyway
    }
    return w;
  }

  async function install(body: Parameters<typeof api.mcpAdd>[0], label: string, oauth = false) {
    const key = body.preset ?? "custom";
    setBusy(key, "install");
    const early = oauth ? openPopup(label) : null;
    try {
      const r = await api.mcpAdd(body);
      await load();
      if (r.probe.needsAuth) {
        toasts.push(`${label} installed`, { detail: "Log in to give the agent access.", tone: "info" });
        await startLogin(r.server, early);
        return true;
      }
      early?.close();
      if (r.probe.ok) {
        toasts.push(`${label} connected`, { detail: `${r.probe.tools} tools available to the agent`, tone: "ok" });
      } else {
        toasts.push(`${label} installed, but not reachable`, { detail: r.probe.error, tone: "err" });
      }
      return true;
    } catch (error) {
      early?.close();
      if (key === "custom") {
        customError = (error as Error).message;
        shake(customForm);
      } else toasts.push(`Could not install ${label}`, { detail: (error as Error).message, tone: "err" });
      return false;
    } finally {
      clearBusy(key);
    }
  }

  async function submitCustom() {
    customError = "";
    const headers: Record<string, string> = {};
    const h = customHeader.trim();
    if (h) {
      const at = h.indexOf(":");
      if (at <= 0) {
        customError = "Header must look like `Name: value`";
        shake(customForm);
        return;
      }
      headers[h.slice(0, at).trim()] = h.slice(at + 1).trim();
    }
    const ok = await install(
      {
        url: customUrl.trim(),
        name: customName.trim() || undefined,
        clientName: customClientName.trim() || undefined,
        clientId: customClientId.trim() || undefined,
        clientSecret: customClientSecret.trim() || undefined,
        headers,
      },
      customName.trim() || "Server",
    );
    if (ok) {
      customOpen = false;
      customUrl = customName = customClientName = customClientId = customClientSecret = customHeader = "";
    }
  }

  // ---------------------------------------------------------------- login
  async function startLogin(server: McpServerView, opened: Window | null = null) {
    setBusy(server.id, "login");
    // Called from a click: open now (see openPopup). From install: the popup it already opened.
    popup = opened && !opened.closed ? opened : openPopup(server.name);
    try {
      const r = await api.mcpLogin(server.id);
      login = r.login;
      copied = false;
      pasteOpen = false;
      pasteText = "";
      pasteError = "";
      if (popup && !popup.closed) popup.location.href = r.login.url;
    } catch (error) {
      popup?.close();
      popup = null;
      toasts.push(`Could not start the ${server.name} login`, { detail: (error as Error).message, tone: "err" });
    } finally {
      clearBusy(server.id);
    }
  }

  function finishLogin(view: McpLogin) {
    if (!login || view.id !== login.id) return;
    login = view;
    if (view.status === "done") {
      toasts.push(`${view.serverName} connected`, { detail: `${view.toolCount ?? 0} tools available to the agent`, tone: "ok" });
      void load().then(() => pulse(document.querySelector(`[data-mcp="${view.serverId}"] [data-state]`)));
      setTimeout(() => {
        if (login?.id === view.id) login = null;
      }, 1400);
    } else if (view.status === "error") {
      toasts.push(`${view.serverName} login failed`, { detail: view.error, tone: "err" });
    }
  }

  // Detect completion: the callback page posts a message to its opener; the poll covers a
  // popup that lost its opener (some providers set COOP) or a login finished in another tab.
  $effect(() => {
    const id = login?.id;
    const pending = login?.status === "pending" || login?.status === "exchanging";
    if (!id || !pending) return;
    let stopped = false;
    const onMessage = (event: MessageEvent) => {
      if (event.origin !== location.origin || event.data?.type !== "mcp-login" || event.data.id !== id) return;
      void api.mcpLoginState(id).then((r) => finishLogin(r.login)).catch(() => undefined);
    };
    window.addEventListener("message", onMessage);
    const poll = async () => {
      while (!stopped) {
        await new Promise((r) => setTimeout(r, 1500));
        if (stopped) return;
        try {
          const r = await api.mcpLoginState(id);
          if (r.login.status === "done" || r.login.status === "error") return finishLogin(r.login);
          if (login?.id === id) login = r.login;
        } catch {
          // a missed poll is retried
        }
      }
    };
    void poll();
    // The countdown: the shared clock wakes every second while the login is on screen.
    const unwatch = clock.watch((t) => t + 1000 - (t % 1000));
    return () => {
      stopped = true;
      unwatch();
      window.removeEventListener("message", onMessage);
    };
  });

  async function cancelLogin() {
    if (!login) return;
    const id = login.id;
    login = null;
    popup?.close();
    popup = null;
    await api.mcpLoginCancel(id).catch(() => undefined);
  }

  async function copyLink() {
    if (!login) return;
    try {
      await navigator.clipboard.writeText(login.url);
      copied = true;
      setTimeout(() => (copied = false), 1800);
    } catch {
      toasts.push("Could not copy", { detail: "Select the link and copy it by hand.", tone: "err" });
    }
  }

  async function submitPaste() {
    if (!login || !pasteText.trim()) return;
    pasteError = "";
    try {
      const r = await api.mcpLoginPaste(login.id, pasteText.trim());
      finishLogin(r.login);
      if (r.login.status === "error") pasteError = r.login.error ?? "The login failed";
    } catch (error) {
      pasteError = (error as Error).message;
    }
  }

  // ---------------------------------------------------------------- row actions
  async function test(s: McpServerView) {
    setBusy(s.id, "test");
    try {
      const r = await api.mcpTest(s.id);
      servers = servers.map((x) => (x.id === s.id ? r.server : x));
      if (r.probe.ok) {
        tools = { ...tools, [s.id]: r.probe.tools as { name: string; description?: string }[] };
        expanded = { ...expanded, [s.id]: true };
      } else if (r.probe.needsAuth) toasts.push(`${s.name} needs a login`, { tone: "info", action: { label: "Log in", run: () => void startLogin(r.server) } });
      else toasts.push(`${s.name} is not reachable`, { detail: r.probe.error, tone: "err" });
    } catch (error) {
      toasts.push("Could not test", { detail: (error as Error).message, tone: "err" });
    } finally {
      clearBusy(s.id);
    }
  }

  async function logout(s: McpServerView) {
    setBusy(s.id, "logout");
    try {
      const r = await api.mcpLogout(s.id);
      servers = servers.map((x) => (x.id === s.id ? r.server : x));
      toasts.push(`Logged out of ${s.name}`, { tone: "info" });
    } finally {
      clearBusy(s.id);
    }
  }

  async function toggle(s: McpServerView) {
    setBusy(s.id, "toggle");
    try {
      const r = await api.mcpSetDisabled(s.id, !s.disabled);
      servers = servers.map((x) => (x.id === s.id ? r.server : x));
    } finally {
      clearBusy(s.id);
    }
  }

  async function remove(s: McpServerView) {
    setBusy(s.id, "remove");
    try {
      await api.mcpRemove(s.id);
      servers = servers.filter((x) => x.id !== s.id);
      toasts.push(`${s.name} removed`, { tone: "info" });
    } catch (error) {
      toasts.push("Could not remove", { detail: (error as Error).message, tone: "err" });
    } finally {
      clearBusy(s.id);
    }
  }

  function remaining(at: number): string {
    const s = Math.max(0, Math.round((at - clock.now) / 1000));
    return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
  }

  function initials(name: string): string {
    return name.replace(/[^A-Za-z0-9 ]/g, "").split(/\s+/).map((w) => w[0]).join("").slice(0, 2).toUpperCase() || "M";
  }
  const HUE: Record<string, string> = { openpencil: "#0d9488", figma: "#a259ff", linear: "#5e6ad2", notion: "#787774", atlassian: "#2684ff", stripe: "#635bff", vercel: "#888" };
</script>

<div class="flex flex-col gap-5">
  <p class="-mt-1 text-[12.5px] text-ink-muted">
    MCP servers give the agent tools from other apps. Servers that use OAuth open their login in a popup; once you approve,
    the connection completes here by itself. Tokens stay on this server and refresh automatically.
  </p>

  {#if login}
    <section
      transition:popIn
      class="login-card relative flex flex-col gap-3 overflow-hidden rounded-xl border border-brand/40 bg-surface p-4"
      aria-live="polite"
      aria-labelledby="{uid}-login"
      data-status={login.status}
    >
      <div class="flex items-start gap-3">
        <span class="relative grid size-9 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">
          {#if login.status === "done"}
            <Check size={18} strokeWidth={2.25} class="check-pop" />
          {:else}
            <LogIn size={16} strokeWidth={2} />
            <span class="ring absolute inset-0 rounded-lg"></span>
          {/if}
        </span>
        <div class="min-w-0 flex-1">
          <h3 id="{uid}-login" class="text-[13.5px] font-medium text-ink">
            {#if login.status === "done"}{login.serverName} connected
            {:else if login.status === "exchanging"}Finishing the {login.serverName} login…
            {:else if login.status === "error"}{login.serverName} login failed
            {:else}Log in to {login.serverName}{/if}
          </h3>
          <p class="mt-0.5 text-[12.5px] text-ink-muted">
            {#if login.status === "pending"}
              Approve access in the window that opened. This card notices when you are done.
            {:else if login.status === "exchanging"}
              Exchanging the code and checking the server accepts it.
            {:else if login.status === "done"}
              {login.toolCount ?? 0} tools are available to the agent from its next task.
            {:else}
              {login.error}
            {/if}
          </p>
        </div>
        {#if login.status === "pending" || login.status === "exchanging"}
          <span class="tnum flex shrink-0 items-center gap-1.5 text-[11.5px] text-ink-faint">
            <Spinner size={12} label="Waiting" />{remaining(login.expiresAt)}
          </span>
        {/if}
        <Button variant="ghost" size="icon-sm" icon={X} aria-label="Close the login" title={login.status === "pending" ? "Cancel" : "Close"} onclick={cancelLogin} />
      </div>

      {#if login.status === "pending"}
        <div class="flex flex-wrap items-center gap-2">
          <Button variant="primary" size="sm" icon={ExternalLink} onclick={() => { popup = window.open(login!.url, `mcp-login-${login!.serverId}`, "popup,width=520,height=720"); }}>Open login</Button>
          <Button variant="outline" size="sm" icon={copied ? Check : Copy} onclick={copyLink}>{copied ? "Copied" : "Copy link"}</Button>
          <Button variant="ghost" size="sm" icon={ClipboardPaste} aria-expanded={pasteOpen} onclick={() => (pasteOpen = !pasteOpen)}>Paste redirect URL</Button>
        </div>
        <a href={login.url} target="_blank" rel="noopener noreferrer" class="block truncate rounded-md bg-canvas px-2.5 py-1.5 font-mono text-[11.5px] text-ink-muted hover:text-ink" title={login.url}>{login.url}</a>
        {#if pasteOpen}
          <form
            transition:slide={{ duration: 180 }}
            class="flex flex-col gap-1.5"
            onsubmit={(e) => {
              e.preventDefault();
              void submitPaste();
            }}
          >
            <label for="{uid}-paste" class="text-[12px] text-ink-muted">Logged in from another device? Paste the address the browser ended on.</label>
            <div class="flex gap-2">
              <input id="{uid}-paste" bind:value={pasteText} class="field min-w-0 flex-1 font-mono" placeholder="https://…/api/mcp/oauth/callback?code=…" autocomplete="off" spellcheck="false" />
              <Button variant="secondary" size="md" type="submit" disabled={!pasteText.trim()}>Finish</Button>
            </div>
            {#if pasteError}<p role="alert" class="text-[12px] text-err">{pasteError}</p>{/if}
          </form>
        {/if}
      {:else if login.status === "error"}
        <div class="flex gap-2">
          <Button
            variant="primary"
            size="sm"
            icon={RefreshCw}
            onclick={() => {
              const s = servers.find((x) => x.id === login?.serverId);
              if (s) void startLogin(s);
            }}>Try again</Button>
        </div>
      {/if}
      <div class="progress absolute right-0 bottom-0 left-0 h-0.5" data-status={login.status} aria-hidden="true"></div>
    </section>
  {/if}

  <section aria-labelledby="{uid}-installed" class="flex flex-col gap-2">
    <h3 id="{uid}-installed" class="text-[13px] font-medium text-ink">Installed</h3>
    {#if status === "loading"}
      <div class="flex flex-col gap-2" role="status" aria-label="Loading MCP servers"><Skeleton class="h-14" /><Skeleton class="h-14" /></div>
    {:else if status === "error"}
      <p class="text-[12.5px] text-ink-muted" role="status">
        Could not load MCP servers. <button type="button" class="cursor-pointer text-brand underline underline-offset-2" onclick={load}>Retry</button>
      </p>
    {:else if !servers.length}
      <div use:enter class="flex flex-col items-center gap-2 rounded-xl border border-dashed border-line px-4 py-7 text-center">
        <span class="grid size-10 place-items-center rounded-full bg-raised text-ink-muted"><Blocks size={18} strokeWidth={1.75} /></span>
        <p class="text-[12.5px] text-ink-muted">No MCP servers yet. Pick one below — Figma is a good start.</p>
      </div>
    {:else}
      <ul class="flex flex-col gap-2">
        {#each servers as s, i (s.id)}
          {@const st = STATE[s.state]}
          <li
            animate:flip={{ duration: 220 }}
            transition:slide={{ duration: 180 }}
            use:enter={{ delay: i * 0.03 }}
            data-mcp={s.id}
            class="rounded-xl border border-line bg-surface transition-colors {s.disabled ? 'opacity-70' : ''}"
          >
            <div class="flex items-center gap-3 px-3 py-2.5">
              <span class="grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold text-white" style="background: {HUE[s.preset ?? ''] ?? 'var(--color-ink-faint)'}" aria-hidden="true">{initials(s.name)}</span>
              <div class="min-w-0 flex-1">
                <div class="flex flex-wrap items-center gap-2">
                  <span class="truncate text-[13px] font-medium text-ink">{s.name}</span>
                  <span data-state={s.state} class="inline-flex"><Badge tone={st.tone} dot>{st.label}</Badge></span>
                  {#if s.oauth}<span class="text-[11px] text-ink-faint">OAuth</span>{:else if s.tokenFile}<span class="text-[11px] text-ink-faint" title="Token read from {s.tokenFile}">self-hosted</span>{/if}
                </div>
                <span class="mt-0.5 block truncate font-mono text-[11.5px] text-ink-muted" title={s.url}>{s.url}</span>
              </div>
              <div class="flex shrink-0 items-center gap-0.5">
                {#if s.state === "needs-login" || s.state === "expired"}
                  <Button variant="primary" size="sm" icon={LogIn} loading={busy[s.id] === "login"} onclick={() => startLogin(s)}>Log in</Button>
                {:else}
                  <Button variant="ghost" size="icon-sm" icon={Wrench} title="Test and list tools" aria-label="Test {s.name}" loading={busy[s.id] === "test"} onclick={() => test(s)} />
                {/if}
                {#if s.loggedIn}
                  <Button variant="ghost" size="icon-sm" icon={LogOut} title="Log out" aria-label="Log out of {s.name}" loading={busy[s.id] === "logout"} onclick={() => logout(s)} />
                {/if}
                <Button variant="ghost" size="icon-sm" icon={Power} title={s.disabled ? "Enable" : "Disable"} aria-label="{s.disabled ? 'Enable' : 'Disable'} {s.name}" active={!s.disabled} loading={busy[s.id] === "toggle"} onclick={() => toggle(s)} />
                <Button variant="danger" size="icon-sm" icon={Trash2} title="Remove" aria-label="Remove {s.name}" loading={busy[s.id] === "remove"} onclick={() => remove(s)} />
              </div>
            </div>
            {#if expanded[s.id] && tools[s.id]}
              <div transition:slide={{ duration: 200 }} class="border-t border-line px-3 py-2.5">
                <button type="button" class="mb-1.5 flex w-full cursor-pointer items-center justify-between text-[11.5px] font-medium text-ink-faint uppercase tracking-wide" onclick={() => (expanded = { ...expanded, [s.id]: false })}>
                  {tools[s.id]!.length} tools <ChevronDown size={13} class="rotate-180" />
                </button>
                <ul class="flex max-h-48 flex-col gap-0.5 overflow-y-auto">
                  {#each tools[s.id]! as t (t.name)}
                    <li class="flex gap-2 rounded px-1.5 py-1 text-[12px] hover:bg-raised">
                      <span class="shrink-0 font-mono text-ink">{t.name}</span>
                      {#if t.description}<span class="truncate text-ink-muted">{t.description}</span>{/if}
                    </li>
                  {/each}
                </ul>
              </div>
            {/if}
          </li>
        {/each}
      </ul>
    {/if}
  </section>

  <section aria-labelledby="{uid}-add" class="flex flex-col gap-2">
    <div class="flex items-center justify-between gap-3">
      <h3 id="{uid}-add" class="text-[13px] font-medium text-ink">Add a server</h3>
      <Button variant="ghost" size="sm" icon={customOpen ? X : Link2} onclick={() => (customOpen = !customOpen)}>{customOpen ? "Close" : "Custom URL"}</Button>
    </div>

    {#if customOpen}
      <form
        bind:this={customForm}
        transition:slide={{ duration: 200 }}
        class="flex flex-col gap-3 rounded-xl border border-line bg-surface p-4"
        onsubmit={(e) => {
          e.preventDefault();
          void submitCustom();
        }}
      >
        <div class="grid gap-3 sm:grid-cols-[2fr_1fr]">
          <label class="flex flex-col gap-1 text-[12.5px] font-medium text-ink-muted">
            Server URL
            <input bind:value={customUrl} class="field font-mono" type="url" placeholder="https://mcp.example.com/mcp" required autocomplete="off" spellcheck="false" />
          </label>
          <label class="flex flex-col gap-1 text-[12.5px] font-medium text-ink-muted">
            Name
            <input bind:value={customName} class="field" placeholder="Optional" autocomplete="off" />
          </label>
        </div>
        <button type="button" class="flex w-fit cursor-pointer items-center gap-1 text-[12px] text-ink-muted hover:text-ink" aria-expanded={customAdvanced} onclick={() => (customAdvanced = !customAdvanced)}>
          <ChevronDown size={13} class="transition-transform duration-200 {customAdvanced ? 'rotate-180' : ''}" /> Authentication options
        </button>
        {#if customAdvanced}
          <div transition:slide={{ duration: 180 }} class="grid gap-3 sm:grid-cols-2">
            <label class="flex flex-col gap-1 text-[12px] text-ink-muted sm:col-span-2">
              Header (API key servers)
              <input bind:value={customHeader} class="field font-mono" placeholder="Authorization: Bearer …" autocomplete="off" spellcheck="false" />
            </label>
            <label class="flex flex-col gap-1 text-[12px] text-ink-muted">
              OAuth client name
              <input bind:value={customClientName} class="field" placeholder="mini-tui" autocomplete="off" />
            </label>
            <label class="flex flex-col gap-1 text-[12px] text-ink-muted">
              OAuth client id
              <input bind:value={customClientId} class="field font-mono" placeholder="Dynamic registration" autocomplete="off" spellcheck="false" />
            </label>
            <label class="flex flex-col gap-1 text-[12px] text-ink-muted sm:col-span-2">
              OAuth client secret
              <input bind:value={customClientSecret} class="field font-mono" type="password" placeholder="Only for confidential clients" autocomplete="off" />
            </label>
          </div>
        {/if}
        {#if customError}<p role="alert" class="text-[12.5px] text-err">{customError}</p>{/if}
        <div class="flex justify-end">
          <Button variant="primary" size="sm" icon={Plus} type="submit" loading={busy.custom === "install"} disabled={!customUrl.trim()}>Add server</Button>
        </div>
      </form>
    {/if}

    {#if status === "ready"}
      {#if !available.length}
        <p class="px-1 py-2 text-[12.5px] text-ink-muted">Every preset is installed. Use a custom URL for anything else.</p>
      {:else}
        <ul class="grid gap-2 sm:grid-cols-2">
          {#each available as p, i (p.id)}
            <li use:enter={{ delay: 0.04 + i * 0.03 }} animate:flip={{ duration: 200 }}>
              <button
                type="button"
                use:lift
                class="preset interactive group flex min-h-11 w-full cursor-pointer items-center gap-3 rounded-xl border border-line bg-surface p-3 text-left hover:border-line-strong hover:bg-raised/60"
                aria-label="Install {p.name}"
                disabled={!!busy[p.id]}
                onclick={() => install({ preset: p.id }, p.name, p.auth === "oauth")}
              >
                <span class="grid size-8 shrink-0 place-items-center rounded-lg text-[11px] font-semibold text-white transition-transform duration-200 group-hover:scale-105" style="background: {HUE[p.id] ?? 'var(--color-ink-faint)'}" aria-hidden="true">{initials(p.name)}</span>
                <span class="min-w-0 flex-1">
                  <span class="flex items-center gap-1.5 text-[13px] font-medium text-ink">{p.name}{#if p.auth === "oauth"}<span class="rounded bg-raised px-1 text-[10px] font-medium text-ink-faint">OAuth</span>{:else if p.auth === "local"}<span class="rounded bg-ok/12 px-1 text-[10px] font-medium text-ok">this machine</span>{/if}</span>
                  <span class="block truncate text-[12px] text-ink-muted">{p.description}</span>
                </span>
                {#if busy[p.id]}<Spinner size={14} label="Installing" />{:else}<Plus size={15} strokeWidth={2} class="shrink-0 text-ink-faint transition-transform duration-200 group-hover:rotate-90 group-hover:text-ink" aria-hidden="true" />{/if}
              </button>
            </li>
          {/each}
        </ul>
      {/if}
    {/if}
  </section>
</div>

<style>
  .field {
    height: 2.25rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line-strong);
    background: var(--color-canvas);
    padding: 0 0.65rem;
    font-size: 16px;
    color: var(--color-ink);
    transition: border-color 150ms var(--ease-standard), box-shadow 150ms var(--ease-standard);
  }
  .field:focus {
    border-color: var(--color-brand);
    box-shadow: 0 0 0 3px var(--color-brand-soft);
    outline: none;
  }
  .field::placeholder {
    color: var(--color-ink-faint);
  }
  .ring {
    border: 1.5px solid var(--color-brand);
    animation: ring 1.6s var(--ease-standard) infinite;
  }
  @keyframes ring {
    0% {
      opacity: 0.7;
      transform: scale(1);
    }
    100% {
      opacity: 0;
      transform: scale(1.45);
    }
  }
  .progress {
    background: linear-gradient(90deg, transparent, var(--color-brand), transparent);
    background-size: 50% 100%;
    background-repeat: no-repeat;
    animation: sweep 1.4s var(--ease-standard) infinite;
  }
  .progress[data-status="done"] {
    background: var(--color-ok);
    animation: none;
  }
  .progress[data-status="error"] {
    background: var(--color-err);
    animation: none;
  }
  @keyframes sweep {
    from {
      background-position: -50% 0;
    }
    to {
      background-position: 150% 0;
    }
  }
  .login-card[data-status="done"] {
    border-color: color-mix(in oklab, var(--color-ok) 45%, transparent);
  }
  .login-card[data-status="error"] {
    border-color: color-mix(in oklab, var(--color-err) 45%, transparent);
  }
  :global(.check-pop) {
    animation: pop-in 320ms var(--ease-emphasized) both;
  }
  .preset:disabled {
    opacity: 0.6;
    pointer-events: none;
  }
</style>
