<script lang="ts">
  import Modal from "./Modal.svelte";
  import { catalog } from "../stores/catalog.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  // The server decides; the browser only checks again and renders nothing on a mismatch.
  const live = $derived(catalog.settings?.liveScreen);
  const src = $derived.by(() => {
    if (!live?.enabled || !live.viewerUrl) return null;
    try {
      const u = new URL(live.viewerUrl);
      return u.protocol === "https:" && u.origin === live.origin && u.pathname === "/vault/live2" && !u.search && !u.hash && !u.username ? u.href : null;
    } catch {
      return null;
    }
  });
</script>

<Modal bind:open title="Live screen" width="max-w-5xl" onclose={() => (open = false)}>
  {#if open && src}
    <!-- Mounted only while open: closing the modal closes the socket. No token in the URL: the viewer uses its own session cookie. -->
    <div class="flex flex-col gap-2">
      {#if live?.loginUrl}
        <p class="text-[12.5px] text-ink-muted">
          Session ended? <a class="underline" href={live.loginUrl} target="_blank" rel="noopener noreferrer">Open the login in a new tab</a>, then reopen this panel.
        </p>
      {/if}
      <!-- Height from the dynamic viewport minus the dialog chrome, so the title bar, this line and Close stay visible in landscape. -->
      <iframe
        title="Live screen"
        {src}
        sandbox="allow-scripts allow-same-origin"
        referrerpolicy="no-referrer"
        allow=""
        class="h-[calc(85dvh-8rem)] min-h-[200px] w-full rounded-md border border-line bg-black"
      ></iframe>
    </div>
  {:else}
    <p class="text-[13px] text-ink-muted">Live screen is not configured.</p>
  {/if}
</Modal>
