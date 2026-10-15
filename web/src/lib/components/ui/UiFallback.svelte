<script lang="ts">
  /**
   * The elegant fallback: an unknown template, a spec that failed validation or
   * a block that never parsed still shows up as a quiet notice — the bot's
   * intent is never silently dropped, and nothing unvalidated ever renders.
   */
  import { Puzzle } from "@lucide/svelte";

  let { reason, requested = "", detail = "" }: { reason: string; requested?: string; detail?: string } = $props();

  const labels: Record<string, string> = {
    json: "no se pudo leer el JSON del componente",
    shape: "la forma del componente no es válida",
    template: "plantilla no disponible",
    props: "props fuera de rango",
  };
  const text = labels[reason] ?? "componente no disponible";
</script>

<div
  class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint"
  role="note"
>
  <Puzzle size={13} strokeWidth={1.75} class="mt-0.5 shrink-0" aria-hidden="true" />
  <span>
    Componente no renderizado{requested ? ` (${requested})` : ""}: {text}{detail ? ` — ${detail}` : ""}
  </span>
</div>
