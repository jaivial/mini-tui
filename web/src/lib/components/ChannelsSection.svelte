<script lang="ts">
  /**
   * Read-only channel visibility for the operator: bound routes, recent
   * inbound messages (with transcript states) and consumer cursors, plus the
   * "Conectar WhatsApp" block (state + QR + pairing code, in
   * WhatsAppConnect.svelte). Nothing here can advance a cursor, replay a
   * delivery or send.
   *
   * v3.3: same visual bill as the rest of the Routines drawer — card
   * sections with the chat's radii and tokens, hairline rows that lift on
   * hover, section labels in the drawer's small-caps voice.
   */
  import { Radio } from "@lucide/svelte";
  import { ChannelsClient, type ChannelsView } from "../channelsClient";
  import { cancelRead, createReadState, isCancel, isLatest, settleRead, startRead } from "../channelsLoad";
  import { senderDisplayName } from "../../../../src/channels/senderName";
  import WhatsAppConnect from "./WhatsAppConnect.svelte";

  let { open = false }: { open?: boolean } = $props();

  const client = new ChannelsClient();
  let view = $state<ChannelsView | null>(null);
  let error = $state("");
  let poller: ReturnType<typeof setInterval> | undefined;
  // Which read is allowed to paint, and how the one before it gets cancelled: without
  // this, a response that arrives late wins on being last, and closing the panel left
  // every poll in flight. See channelsLoad.ts for the measurement.
  const reads = createReadState();

  /** One read. Supersedes whatever is in flight and takes ownership of the panel. */
  async function load() {
    const token = startRead(reads, "inbox");
    try {
      const next = await client.inbox(token.controller.signal);
      if (!isLatest(reads, token)) return;
      view = next;
      error = "";
    } catch (e) {
      // A superseded or cancelled read is not a failure of the ledger: painting it would
      // show "Reintentando..." over data we already know is good.
      if (isCancel(e) || !isLatest(reads, token)) return;
      error = (e as Error).message;
    } finally {
      settleRead(reads, token);
    }
  }

  $effect(() => {
    if (!open) return;
    void load();
    poller = setInterval(() => {
      // Skip the tick while a read is in flight rather than opening a second one: against
      // the deployed build with the endpoint silent, the old code opened one request every
      // 10 s and none of them ever finished.
      if (!reads.current) void load();
    }, 10_000);
    return () => {
      if (poller) clearInterval(poller);
      poller = undefined;
      cancelRead(reads);
    };
  });

  function time(ts: number) {
    if (!ts) return "";
    return new Date(ts).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  }
</script>

<section class="mb-3 rounded-2xl border border-line/80 bg-surface/70 p-3" aria-label="Canales">
  <div class="flex items-center gap-2">
    <span class="grid size-6 shrink-0 place-items-center rounded-lg bg-brand-soft text-brand" aria-hidden="true">
      <Radio size={13} strokeWidth={1.75} />
    </span>
    <h3 class="min-w-0 flex-1 text-[12.5px] font-semibold tracking-[-0.01em] text-ink">Canales</h3>
    <span class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Solo lectura</span>
  </div>

  {#if error}
    <p role="status" class="mt-2 text-[11.5px] leading-5 text-warn">{error}. Reintentando…</p>
  {:else if !view}
    <p role="status" class="mt-2 text-[11.5px] text-ink-muted">Leyendo canal…</p>
  {:else if !view.configured}
    <p class="mt-2 text-[11.5px] leading-5 text-ink-muted">Sin almacén de canal configurado en este host.</p>
  {/if}

  {#if view?.configured}
    <div class="mt-3">
      <h4 class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Rutas enlazadas · {view.bindings.length}</h4>
      {#if !view.bindings.length}
        <p class="mt-1 text-[11px] text-ink-faint">Ninguna ruta enlazada todavía.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-1">
          {#each view.bindings as b (b.channel + b.account + b.thread)}
            <li class="interactive rounded-lg border border-line/70 bg-canvas/60 px-2 py-1.5 text-[10.5px] leading-4 hover:border-line-strong">
              <span class="font-medium text-ink">{b.channel}</span>
              <span class="text-ink-muted"> · {b.account} · hilo {b.thread}</span>
              <span class="block font-mono text-[10px] text-ink-faint">→ sesión {b.session} · proyecto {b.project}</span>
              <span class="block text-ink-faint">Permitidos: {b.allowedSenders.join(", ")}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="mt-3">
      <h4 class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Mensajes recientes · {view.messages.length} de seq {view.lastSeq}</h4>
      {#if !view.messages.length}
        <p class="mt-1 text-[11px] text-ink-faint">Ningún mensaje aceptado todavía.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-1">
          {#each view.messages as m (m.seq)}
            <li class="interactive rounded-lg border border-line/70 bg-canvas/60 px-2 py-1.5 text-[10.5px] leading-4 hover:border-line-strong">
              <span class="tnum font-medium text-ink">#{m.seq}</span>
              <!-- Name when the delivery carried one, jid otherwise — the same
                   rule the transcript header uses, so the two never disagree. -->
              <span class="text-ink-muted" title={m.sender}>
                {senderDisplayName(m.sender, m.senderName)} · {time(m.receivedAt)}
              </span>
              <span class="block break-words text-ink-muted">{m.text}{m.truncated ? "…" : ""}</span>
              {#if m.attachments.length}
                <span class="block text-ink-faint">
                  Adjuntos: {m.attachments.map(a => `${a.kind}${a.transcriptionState ? ` (${a.transcriptionState})` : ""}`).join(", ")}
                </span>
              {/if}
              <span class="block font-mono text-[10px] text-ink-faint">→ {m.session} · {m.project}</span>
            </li>
          {/each}
        </ul>
      {/if}
    </div>

    <div class="mt-3">
      <h4 class="text-[10px] font-semibold tracking-wider text-ink-faint uppercase">Consumidores</h4>
      {#if !view.consumers.length}
        <p class="mt-1 text-[11px] text-ink-faint">Ninguno registrado.</p>
      {:else}
        <ul class="mt-1 flex flex-col gap-0.5">
          {#each view.consumers as c (c.consumer)}
            <li class="tnum rounded-md px-1 py-0.5 text-[10.5px] leading-4">
              <span class="font-sans text-ink">{c.consumer}</span>
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
