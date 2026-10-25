<script lang="ts">
  import { X, RefreshCw, Camera, Radio, Hand, Maximize2, Minimize2 } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import { api } from "../api";
  import { toasts } from "../stores/toast.svelte";
  import { queue } from "../stores/queue.svelte";
  import type { CuTab } from "../types";

  /**
   * The agents' browser (the persistent `cu` daemon): its tabs, a screenshot of the chosen one,
   * or its live stream. "Take control" relays the mouse and keyboard to that tab, which is how a
   * human solves a captcha, scans a QR or logs in for a task, in the agent's own browser.
   */
  let { onclose, tab = $bindable(""), live = false, full = false, onfull }: { onclose?: () => void; tab?: string; live?: boolean; full?: boolean; onfull?: () => void } = $props();

  let tabs = $state<CuTab[]>([]);
  let available = $state(true);
  let loading = $state(true);
  let mode = $state<"shot" | "live">(live ? "live" : "shot");
  // A worker asking for a human switches the view to live on its tab.
  $effect(() => {
    const ask = asks.find((t) => t.browser?.tab === tab);
    if (ask) mode = "live";
  });
  let shotUrl = $state("");
  let shotAt = $state(0);
  let control = $state(false);
  let status = $state("");
  let canvas = $state<HTMLCanvasElement | null>(null);
  let ws: WebSocket | null = null;
  let connected = $state(false);
  /** Tasks whose worker is waiting for the human in a tab. */
  const asks = $derived(queue.tasks.filter((t) => t.browser && (t.status === "running" || t.status === "queued")));
  async function done(id: string) {
    try {
      await api.queueBrowserDone(id);
    } catch (e) {
      toasts.push("Could not tell the worker", { detail: (e as Error).message, tone: "err" });
    }
  }

  async function loadTabs() {
    loading = true;
    try {
      const r = await api.browserTabs();
      available = r.available;
      tabs = r.tabs;
      if (!tab || !tabs.some((t) => t.id === tab)) tab = (tabs.find((t) => t.default) ?? tabs[0])?.id ?? "";
    } catch (e) {
      available = false;
      toasts.push("Could not read the browser's tabs", { detail: (e as Error).message, tone: "err" });
    } finally {
      loading = false;
    }
  }

  function takeShot() {
    if (!tab) return;
    shotUrl = `/api/browser/tabs/${encodeURIComponent(tab)}/shot?t=${Date.now()}`;
    shotAt = Date.now();
  }

  function stopLive() {
    ws?.close();
    ws = null;
    connected = false;
    control = false;
    status = "";
  }

  function startLive() {
    stopLive();
    if (!tab || !canvas) return;
    const proto = location.protocol === "https:" ? "wss" : "ws";
    const sock = new WebSocket(`${proto}://${location.host}/api/browser/tabs/${encodeURIComponent(tab)}/live?control=1`);
    sock.binaryType = "arraybuffer";
    ws = sock;
    status = "Connecting…";
    sock.onopen = () => {
      status = "Live";
      connected = true;
    };
    sock.onclose = (e) => {
      if (ws !== sock) return;
      connected = false;
      status = e.reason ? `Stream closed: ${e.reason}` : "Stream closed";
    };
    sock.onmessage = async (ev) => {
      if (typeof ev.data === "string") {
        try {
          const m = JSON.parse(ev.data);
          if (m.t === "control" && "controlling" in m) control = !!m.controlling;
          else if (m.t === "denied") status = "Press Take control first";
          else if (m.t === "error") status = String(m.error ?? "error");
        } catch {
          // not ours
        }
        return;
      }
      const v = new DataView(ev.data as ArrayBuffer);
      if (v.getUint8(0) !== 1 || !canvas) return;
      try {
        const bmp = await createImageBitmap(new Blob([(ev.data as ArrayBuffer).slice(9)], { type: "image/jpeg" }));
        if (canvas.width !== bmp.width || canvas.height !== bmp.height) {
          canvas.width = bmp.width;
          canvas.height = bmp.height;
        }
        canvas.getContext("2d")?.drawImage(bmp, 0, 0);
        bmp.close();
      } catch {
        // a torn frame: the next one replaces it
      }
      sock.send(JSON.stringify({ t: "ack", seq: v.getUint32(1) }));
    };
  }

  const send = (o: Record<string, unknown>) => ws?.readyState === 1 && ws.send(JSON.stringify(o));
  /** Input goes through the server's input route (the daemon applies tap / scroll / type / press). */
  let typed = $state("");
  // One at a time, in order: keystrokes sent as parallel requests landed out of order.
  let chain: Promise<unknown> = Promise.resolve();
  function input(body: Record<string, unknown>) {
    if (!control || !tab) return;
    const t = tab;
    chain = chain.then(() => api.browserInput(t, body)).catch((e) => (status = `Input failed: ${(e as Error).message}`));
  }
  /** Pointer position as a fraction of the page, whatever the canvas scale. */
  function pos(e: MouseEvent) {
    const r = canvas!.getBoundingClientRect();
    return { x: (e.clientX - r.left) / r.width, y: (e.clientY - r.top) / r.height };
  }
  let down: { x: number; y: number; cx: number; cy: number } | null = null;
  function onDown(e: MouseEvent) {
    canvas?.focus();
    if (!control || e.button !== 0) return;
    down = { ...pos(e), cx: e.clientX, cy: e.clientY };
  }
  function onUp(e: MouseEvent) {
    if (!control || !down) return;
    const moved = Math.hypot(e.clientX - down.cx, e.clientY - down.cy);
    const p = pos(e);
    if (moved < 8) input({ do: "tap", x: p.x, y: p.y });
    else input({ do: "scroll", x: down.x, y: down.y, dx: (down.x - p.x) * canvas!.width, dy: (down.y - p.y) * canvas!.height });
    down = null;
  }
  function onKey(e: KeyboardEvent) {
    if (!control) return;
    if (e.key === "Enter" || e.key === "Backspace" || e.key === "Tab" || e.key === "Escape") {
      e.preventDefault();
      input({ do: "press", name: e.key });
    } else if (e.key.length === 1 && !e.ctrlKey && !e.metaKey && !e.altKey) {
      e.preventDefault();
      input({ do: "type", text: e.key });
    }
  }

  $effect(() => {
    void loadTabs();
    return stopLive;
  });
  // Switching tab or mode restarts what is shown.
  $effect(() => {
    tab;
    if (mode === "live") startLive();
    else {
      stopLive();
      takeShot();
    }
  });
</script>

<aside class="flex h-full min-h-0 w-full flex-col border-l border-line/80 bg-surface" aria-label="Browser">
  <header class="flex min-h-13 shrink-0 items-center gap-1.5 border-b border-line/80 px-3">
    <h2 class="text-[13.5px] font-semibold">Browser</h2>
    <select class="h-8 min-w-0 flex-1 cursor-pointer rounded-md border border-line bg-canvas px-2 text-[12px] text-ink" aria-label="Tab" bind:value={tab} disabled={!tabs.length}>
      {#each tabs as t (t.id)}<option value={t.id}>{t.title || t.url}</option>{/each}
    </select>
    <Button variant="ghost" size="icon-sm" icon={RefreshCw} title="Reload tabs" aria-label="Reload tabs" onclick={loadTabs} />
    {#if onfull}<Button variant="ghost" size="icon-sm" icon={full ? Minimize2 : Maximize2} title={full ? "Exit full screen (Esc · Ctrl/⌘ ⇧ F)" : "Full screen (Ctrl/⌘ ⇧ F)"} aria-label={full ? "Exit full screen" : "Full screen"} aria-pressed={full} onclick={onfull} />{/if}
    {#if onclose}<Button variant="ghost" size="icon-sm" icon={X} title="Hide browser" aria-label="Hide browser" onclick={onclose} />{/if}
  </header>
  <div class="flex shrink-0 items-center gap-1 border-b border-line/80 px-2 py-1.5" role="tablist" aria-label="View">
    <button type="button" role="tab" aria-selected={mode === "shot"} class="interactive flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] {mode === 'shot' ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink'}" onclick={() => (mode = "shot")}><Camera size={13} />Screenshot</button>
    <button type="button" role="tab" aria-selected={mode === "live"} class="interactive flex min-h-7 cursor-pointer items-center gap-1.5 rounded-md px-2 text-[12px] {mode === 'live' ? 'bg-raised text-ink' : 'text-ink-muted hover:text-ink'}" onclick={() => (mode = "live")}><Radio size={13} />Live</button>
    <span class="flex-1"></span>
    {#if mode === "shot"}
      <Button variant="outline" size="sm" icon={RefreshCw} onclick={takeShot} disabled={!tab}>Capture</Button>
    {:else}
      <Button variant={control ? "primary" : "outline"} size="sm" icon={Hand} onclick={() => send({ t: control ? "release" : "take" })} disabled={!connected}>{control ? "Release control" : "Take control"}</Button>
    {/if}
  </div>
  {#each asks as t (t.id)}
    <div class="flex shrink-0 items-start gap-2 border-b border-line/80 bg-brand-soft px-3 py-2 text-[12.5px]" role="status">
      <span class="min-w-0 flex-1"><span class="font-medium">{t.id} · {t.title}</span> needs you: {t.browser?.message}</span>
      {#if t.browser?.tab !== tab}<Button variant="outline" size="sm" onclick={() => { tab = t.browser!.tab; mode = "live"; }}>Show</Button>{/if}
      <Button variant="primary" size="sm" onclick={() => done(t.id)}>Done</Button>
    </div>
  {/each}
  <div class="min-h-0 flex-1 overflow-auto bg-black/90 p-2">
    {#if loading}
      <p class="p-3 text-[12.5px] text-ink-muted">Reading the browser…</p>
    {:else if !available}
      <p class="p-3 text-[12.5px] text-ink-muted">The agents' browser (the cu daemon) is not running on this machine.</p>
    {:else if !tabs.length}
      <p class="p-3 text-[12.5px] text-ink-muted">No page open. A task that uses the browser will show up here.</p>
    {:else if mode === "shot"}
      {#if shotUrl}
        <img src={shotUrl} alt="Screenshot of the selected tab" class="w-full rounded-sm bg-white" />
        <p class="mt-1 text-[11px] text-ink-faint">Captured {new Date(shotAt).toLocaleTimeString()}</p>
      {/if}
    {:else}
      <!-- svelte-ignore a11y_no_noninteractive_tabindex a11y_no_noninteractive_element_interactions -->
      <canvas
        bind:this={canvas}
        tabindex="0"
        aria-label="Live view of the selected tab; take control to click, scroll and type"
        class="w-full rounded-sm bg-white outline-none {control ? 'cursor-crosshair ring-2 ring-brand' : ''}"
        oncontextmenu={(e) => e.preventDefault()}
        onmousedown={onDown}
        onmouseup={onUp}
        onwheel={(e) => { if (!control) return; e.preventDefault(); const p = pos(e); input({ do: "scroll", x: p.x, y: p.y, dx: e.deltaX, dy: e.deltaY }); }}
        onkeydown={onKey}
      ></canvas>
      {#if control}
        <form class="mt-1.5 flex items-center gap-1.5" onsubmit={(e) => { e.preventDefault(); if (typed) input({ do: "type", text: typed }); typed = ""; }}>
          <input class="h-8 min-w-0 flex-1 rounded-md border border-line bg-canvas px-2 text-[12.5px] text-ink" placeholder="Type or paste text for the page…" aria-label="Text to type into the page" bind:value={typed} />
          <Button variant="outline" size="sm" type="submit" disabled={!typed}>Type</Button>
          <Button variant="outline" size="sm" onclick={() => input({ do: "press", name: "Enter" })}>Enter</Button>
        </form>
      {/if}
      <p class="mt-1 text-[11px] text-ink-faint">{status}{control ? " · you are controlling this tab" : ""}</p>
    {/if}
  </div>
</aside>
