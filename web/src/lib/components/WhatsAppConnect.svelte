<script lang="ts">
  /**
   * "Conectar WhatsApp": the assistant instance's connection state plus the
   * two pairing paths the weai-mini API offers over loopback — the QR the
   * phone scans and the short code the phone types. The server holds the
   * apikey and regenerates both on demand (rate-limited, ~60 s TTL); this
   * section only renders what it is given and never sees a secret.
   */
  import { RefreshCw } from "@lucide/svelte";
  import Button from "./Button.svelte";
  import {
    ChannelsClient,
    type EvoPair,
    type EvoQr,
    type EvoStatus,
  } from "../channelsClient";

  let { open = false }: { open?: boolean } = $props();

  const client = new ChannelsClient();
  let evo = $state<EvoStatus | null>(null);
  let qr = $state<EvoQr | null>(null);
  let qrBusy = $state(false);
  let qrError = $state("");

  let number = $state("");
  let pair = $state<EvoPair | null>(null);
  let pairBusy = $state(false);
  let pairError = $state("");
  let remaining = $state(0);
  let ticker: ReturnType<typeof setInterval> | undefined;
  let poller: ReturnType<typeof setInterval> | undefined;

  async function loadStatus() {
    try {
      evo = await client.evoStatus();
    } catch {
      evo = null;
    }
  }

  async function refreshQr() {
    if (qrBusy) return;
    qrBusy = true;
    qrError = "";
    try {
      qr = await client.evoQr();
      if (qr.error && qr.error !== "already_connected") qrError = qr.error === "qr_rate_limited" ? "Espera unos segundos y vuelve a intentarlo." : "QR no disponible ahora.";
      else if (qr.error === "already_connected") qrError = "";
    } catch (e) {
      qrError = (e as Error).message;
    } finally {
      qrBusy = false;
    }
  }

  function stopTicker() {
    if (ticker) clearInterval(ticker);
    ticker = undefined;
  }

  function startTicker(expiresAt: number) {
    stopTicker();
    remaining = Math.max(0, Math.ceil((expiresAt - Date.now()) / 1000));
    ticker = setInterval(() => {
      remaining = Math.max(0, Math.ceil(((pair?.expiresAt ?? expiresAt) - Date.now()) / 1000));
      if (remaining <= 0) stopTicker();
    }, 1000);
  }

  function pairMessage(error?: string): string {
    switch (error) {
      case "invalid_number": return "Ese número no parece válido. Usa formato internacional, p. ej. +34 600 000 000.";
      case "code_rate_limited": return "Espera unos segundos y vuelve a intentarlo.";
      case "already_connected": return "La instancia ya está conectada. No hace falta emparejar nada.";
      case "no_code_available": return "No llegó ningún código. Comprueba el estado y reintenta en unos segundos.";
      default: return "No se pudo pedir el código.";
    }
  }

  async function requestCode() {
    if (pairBusy || !number.trim()) return;
    pairBusy = true;
    pairError = "";
    stopTicker();
    try {
      pair = await client.evoPairingCode(number.trim());
      if (pair.code && pair.expiresAt) startTicker(pair.expiresAt);
      else pairError = pairMessage(pair.error);
    } catch (e) {
      pair = null;
      pairError = (e as Error).message;
    } finally {
      pairBusy = false;
    }
  }

  $effect(() => {
    if (!open) return;
    void loadStatus();
    poller = setInterval(() => { void loadStatus(); }, 10_000);
    return () => {
      if (poller) clearInterval(poller);
      poller = undefined;
      stopTicker();
    };
  });

  const stateLabel = (state?: string) =>
    ({ connected: "Conectado", connecting: "Conectando…", qr: "Esperando escaneo del QR", disconnected: "Desconectado", unreachable: "weai-mini no responde (loopback)" } as Record<string, string>)[state ?? ""] ?? "Sin configurar";
</script>

<div class="rounded-md border border-line/70 p-2" aria-label="Conectar WhatsApp">
  <div class="flex items-center justify-between gap-2">
    <h4 class="text-[11px] font-medium text-ink-muted">Conectar WhatsApp</h4>
    {#if evo?.configured}
      <span class="text-[10.5px] {evo.state === 'connected' ? 'text-ok' : evo.state === 'unreachable' ? 'text-warn' : 'text-ink-muted'}">{stateLabel(evo.state)}</span>
    {/if}
  </div>
  {#if !evo}
    <p class="mt-1 text-[11px] text-ink-faint">Estado de conexión no disponible.</p>
  {:else if !evo.configured}
    <p class="mt-1 text-[11px] text-ink-faint">Instancia de WhatsApp no configurada en este servidor.</p>
  {:else if evo.state === "connected"}
    <p class="mt-1 text-[11px] text-ink-muted">La instancia {evo.instance} está conectada. No hace falta escanear nada.</p>
  {:else}
    <p class="mt-1 text-[11px] text-ink-muted">Escanea el QR con WhatsApp → Dispositivos vinculados → Vincular un dispositivo. Caduca en ~60 s.</p>
    {#if qr?.qr}
      <div class="mt-2 flex justify-center rounded-md bg-white p-2">
        <img src={qr.qr} alt="QR de vinculación de WhatsApp" class="h-48 w-48" />
      </div>
      {#if qr.code}<p class="mt-1 text-center text-[10.5px] text-ink-faint">Código de emparejamiento: <span class="tnum">{qr.code}</span></p>{/if}
    {/if}
    {#if qrError}<p role="status" class="mt-1 text-[11px] text-warn">{qrError}</p>{/if}
    <div class="mt-2 flex justify-end">
      <Button variant="outline" size="sm" onclick={refreshQr} disabled={qrBusy} aria-label="Generar QR de vinculación">
        <RefreshCw size={13} strokeWidth={2} class={qrBusy ? "animate-spin" : ""} aria-hidden="true" />
        {qr?.qr ? "Regenerar QR" : "Mostrar QR"}
      </Button>
    </div>

    <div class="mt-3 border-t border-line/70 pt-2" aria-label="Emparejar con código">
      <p class="text-[11px] text-ink-muted">
        O empareja con un código: escribe tu número, y en el teléfono marca
        WhatsApp → Dispositivos vinculados → Vincular con el número de teléfono.
      </p>
      <form
        class="mt-2 flex items-end gap-2"
        onsubmit={(event) => {
          event.preventDefault();
          void requestCode();
        }}
        aria-busy={pairBusy}
      >
        <div class="min-w-0 flex-1">
          <label for="wa-pair-number" class="sr-only">Número de teléfono</label>
          <input
            id="wa-pair-number"
            bind:value={number}
            type="tel"
            inputmode="tel"
            autocomplete="off"
            autocapitalize="off"
            spellcheck="false"
            enterkeyhint="go"
            placeholder="+34 600 000 000"
            disabled={pairBusy}
            aria-invalid={pairError ? true : undefined}
            class="pair-input w-full"
          />
        </div>
        <Button variant="outline" size="sm" loading={pairBusy} disabled={!number.trim()} onclick={requestCode}>
          {pair?.code ? "Nuevo código" : "Generar código"}
        </Button>
      </form>

      {#if pairError}
        <p role="status" class="mt-1 text-[11px] text-warn">{pairError}</p>
      {:else if pair?.code}
        {#if remaining > 0}
          <div class="mt-2 rounded-md border border-line/70 bg-surface p-3 text-center">
            <p class="font-mono text-2xl font-semibold tracking-[0.2em] text-ink tnum" aria-label="Código de emparejamiento">{pair.code}</p>
            <p class="mt-1 text-[10.5px] text-ink-faint tnum" role="timer">Caduca en {remaining} s — escríbelo en el teléfono antes de que venza.</p>
          </div>
        {:else}
          <p role="status" class="mt-2 text-[11px] text-warn">El código ha caducado. Genera otro y escríbelo de nuevo.</p>
        {/if}
      {/if}
    </div>
  {/if}
</div>

<style>
  .pair-input {
    height: 2rem;
    border-radius: var(--radius-md);
    border: 1px solid var(--color-line-strong);
    background: var(--color-canvas);
    padding: 0 0.65rem;
    font-size: 16px;
    color: var(--color-ink);
  }
  @media (pointer: coarse) {
    .pair-input {
      height: 2.75rem;
    }
  }
  .pair-input:focus {
    border-color: var(--color-brand);
    outline: none;
  }
  .pair-input::placeholder {
    color: var(--color-ink-faint);
  }
</style>
