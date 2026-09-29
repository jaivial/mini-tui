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

<div class="pointer-events-none fixed top-[max(1rem,env(safe-area-inset-top))] right-4 z-[60] flex w-80 flex-col gap-2 max-sm:right-3 max-sm:left-3 max-sm:w-auto" role="status" aria-live="polite">
  {#each toasts.items as toast (toast.id)}
    {@const IconCmp = ICONS[toast.tone]}
    <div
      class="elev-pop pointer-events-auto flex items-start gap-2.5 rounded-lg border px-3.5 py-2.5 {TONE[toast.tone]}"
    >
      <IconCmp size={15} class="mt-px shrink-0" strokeWidth={2} />
      <div class="min-w-0 flex-1">
        <div class="text-[12.5px] leading-4 font-medium">{toast.title}</div>
        {#if toast.detail}
          <div class="mt-0.5 text-[11.5px] leading-4 opacity-80">{toast.detail}</div>
        {/if}
      </div>
      <button
        class="-mt-1 -mr-2 grid size-8 shrink-0 cursor-pointer place-items-center rounded-md opacity-60 hover:opacity-100 pointer-coarse:size-11 pointer-coarse:-mt-2.5"
        onclick={() => toasts.dismiss(toast.id)}
        aria-label="Dismiss"
      >
        <X size={13} strokeWidth={2} />
      </button>
    </div>
  {/each}
</div>
