<script lang="ts">
  import { CheckCircle2, AlertCircle, Info, X } from "@lucide/svelte";
  import { toasts } from "../stores/toast.svelte";

  const ICONS = { ok: CheckCircle2, err: AlertCircle, info: Info };
  const TONE = {
    ok: "border-ok/30 bg-ok/10 text-ok",
    err: "border-err/30 bg-err/10 text-err",
    info: "border-line bg-overlay text-ink",
  };
</script>

<!--
  One polite live region reads each toast as it arrives. The action button is a real button in the tab
  order; hovering or focusing a toast pauses its timer, so it cannot vanish under the pointer.
-->
<div class="pointer-events-none fixed top-[max(1rem,env(safe-area-inset-top))] right-4 z-[60] flex w-80 flex-col gap-2 max-sm:right-3 max-sm:left-3 max-sm:w-auto" role="status" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    {@const IconCmp = ICONS[toast.tone]}
    <div
      class="toast elev-pop pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 {TONE[toast.tone]}"
      role="group"
      aria-label={toast.title}
      data-toast={toast.id}
      onpointerenter={() => toasts.pause(toast.id)}
      onpointerleave={() => toasts.resume(toast.id)}
      onfocusin={() => toasts.pause(toast.id)}
      onfocusout={(e) => { if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) toasts.resume(toast.id); }}
    >
      <IconCmp size={15} class="mt-px shrink-0" strokeWidth={2} aria-hidden="true" />
      <div class="min-w-0 flex-1">
        <div class="text-[12.5px] leading-4 font-medium">{toast.title}</div>
        {#if toast.detail}
          <div class="mt-0.5 truncate text-[11.5px] leading-4 opacity-80" title={toast.detail}>{toast.detail}</div>
        {/if}
      </div>
      {#if toast.action}
        {@const action = toast.action}
        <button
          type="button"
          class="toast-action -my-1 shrink-0 cursor-pointer rounded-md border border-current/30 px-2.5 text-[12px] font-medium text-ink hover:bg-raised pointer-coarse:min-h-11 min-h-7"
          onclick={() => {
            toasts.dismiss(toast.id);
            action.run();
          }}
        >
          {action.label}
        </button>
      {/if}
      <button
        class="-mt-1 -mr-2 grid size-8 shrink-0 cursor-pointer place-items-center rounded-md opacity-60 hover:opacity-100 pointer-coarse:size-11 pointer-coarse:-mt-2.5"
        onclick={() => toasts.dismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  {/each}
</div>

<style>
  .toast-action {
    transition-property: background-color, scale;
    transition-duration: 150ms;
    transition-timing-function: cubic-bezier(0.2, 0, 0, 1);
  }
  .toast-action:active {
    scale: 0.96;
  }
</style>
