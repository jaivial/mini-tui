<script lang="ts">
  import { Cpu, KeyRound, Layers, Plug, Server, Smartphone, SquareSlash, Terminal } from "@lucide/svelte";
  const icons = { layers: Layers, plug: Plug, server: Server, "square-slash": SquareSlash, cpu: Cpu, "key-round": KeyRound, smartphone: Smartphone, terminal: Terminal } as const;
  let { name }: { name: keyof typeof icons } = $props();
  const Icon = $derived(icons[name]);
</script>

<Icon aria-hidden="true" class="size-5" strokeWidth={1.75} />
