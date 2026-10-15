<script lang="ts">
  /**
   * Read-only channel visibility for the operator: bound routes, recent
   * inbound messages (with transcript states) and consumer cursors, plus the
   * "Conectar WhatsApp" block (state + QR + pairing code, in
   * WhatsAppConnect.svelte). Nothing here can advance a cursor, replay a
   * delivery or send.
   */
  import { ChannelsClient, type ChannelsView } from "../channelsClient";
  import WhatsAppConnect from "./WhatsAppConnect.svelte";

  let { open = false }: { open?: boolean } = $props();

  const client = new ChannelsClient();
  let view = $state<ChannelsView | null>(null);
  let error = $state("");
  let poller: ReturnType<typeof setInterval> | undefined;

  async function load() {
    try {
      view = await client.inbox();
      error = "";
    } catch (e) {
      error = (e as Error).message;
    }
  }

  $effect(() => {
    if (!open) return;
    void load();
    poller = setInterval(() => { void load(); }, 10_000);
    return () => {
      if (poller) clearInterval(poller);
      poller = undefined;
    };
  });

  function time(ts: number) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString();
  }
</script>

<section class="mb-3 rounded-lg border border-line bg-raised/40 p-3" aria-label="Canales">
  <div class="flex items-center justify-between gap-2">
    <h3 class="text-[12.5px] font-medium text-ink">Canales</h3>
    <span class="text-[10.5px] text-ink-faint">Solo lectura</span>
  </div>

  {#if error}
    <p role="status" class="mt-2 text-[11.5px] leading-5 text-warn">{error}. Reintentando…</p>
  {:else if !view}
    <p role="status" class="mt-2 text-[11.5px] text-ink-muted">Leyendo canal…</p>
  {:else if !view.configured}
    <p class="mt-2 text-[11.5px] leading-5 text-ink-muted">Sin almacén de canal configurado en este host.</p>
  {/if}

  {#if view?.configured}
    <div class="mt-2">
      <h4 class="text-[11px] font-medium text-ink-muted">Rutas enlazadas ({view.bindings.length})</h4>
      {#if !view.bindings.length}
        <p class="mt-1 text-[11px] text-ink-faint">Ninguna ruta enlazada todavía.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-1">
          {#each view.bindings as b (b.channel + b.account + b.thread)}
            <li class="rounded-md border border-line/70 px-2 py-1 text-[10.5px] leading-4">
              <span class="font-medium text-ink">{b.channel}</span>
              <span class="text-ink-muted"> · {b.account} · hilo {b.thread}</span>
              <span class="block text-ink-faint">→ sesión {b.session} · proyecto {b.project}</span>
              <span class="block text-ink-faint">Permitidos: {b.allowedSenders.join(", ")}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="mt-3">
      <h4 class="text-[11px] font-medium text-ink-muted">Mensajes recientes ({view.messages.length} de seq {view.lastSeq})</h4>
      {#if !view.messages.length}
        <p class="mt-1 text-[11px] text-ink-faint">Ningún mensaje aceptado todavía.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-1">
          {#each view.messages as m (m.seq)}
            <li class="rounded-md border border-line/70 px-2 py-1 text-[10.5px] leading-4">
              <span class="font-medium text-ink">#{m.seq}</span>
              <span class="text-ink-muted"> {m.sender} · {time(m.receivedAt)}</span>
              <span class="block break-words text-ink-muted">{m.text}{m.truncated ? "…" : ""}</span>
              {#if m.attachments.length}
                <span class="block text-ink-faint">
                  Adjuntos: {m.attachments.map(a => `${a.kind}${a.transcriptionState ? ` (${a.transcriptionState})` : ""}`).join(", ")}
                </span>
              {/if}
              <span class="block text-ink-faint">→ {m.session} · {m.project}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="mt-3">
      <h4 class="text-[11px] font-medium text-ink-muted">Consumidores</h4>
      {#if !view.consumers.length}
        <p class="mt-1 text-[11px] text-ink-faint">Ninguno registrado.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-1">
          {#each view.consumers as c (c.consumer)}
            <li class="text-[10.5px] leading-4">
              <span class="text-ink">{c.consumer}</span>
              <span class="text-ink-muted"> · cursor {c.cursor}</span>
              {#if c.lag > 0}<span class="text-warn"> · {c.lag} sin confirmar</span>{/if}
            </li>
          {/each}
        </ul>
      {/if}
    </div>
  {/if}

  <div class="mt-3">
    <WhatsAppConnect {open} />
  </div>
</section>
