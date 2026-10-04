<script lang="ts">
  import { Cpu, KeyRound, Layers, LayoutGrid, MonitorSmartphone, Plug, Server, Smartphone, SquareSlash, Terminal, Workflow } from "@lucide/svelte";
  const icons = { layers: Layers, "layout-grid": LayoutGrid, plug: Plug, server: Server, "square-slash": SquareSlash, cpu: Cpu, "key-round": KeyRound, smartphone: Smartphone, terminal: Terminal, "monitor-smartphone": MonitorSmartphone, workflow: Workflow } as const;
  let { name }: { name: keyof typeof icons } = $props();
  const Icon = $derived(icons[name]);
</script>

<Icon aria-hidden="true" class="size-5" strokeWidth={1.75} />
