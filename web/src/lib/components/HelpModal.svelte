<script lang="ts">
  import Modal from "./Modal.svelte";
  import { catalog } from "../stores/catalog.svelte";

  let { open = $bindable(false) }: { open?: boolean } = $props();

  const KEYS: [string, string][] = [
    ["Enter", "Send the message"],
    ["Shift + Enter", "New line"],
    ["/", "Commands, at the start of a message"],
    ["/resume", "Reopen any saved session and keep going"],
    ["$", "Skills, anywhere in a message"],
    ["↑ ↓ then Enter or Tab", "Pick a command, skill or model"],
    ["Esc", "Close a menu or panel"],
    ["Ctrl/⌘ + K", "New chat"],
    ["Ctrl/⌘ + ,", "Settings"],
    ["Ctrl/⌘ + B", "Show or hide the sessions list"],
    ["Ctrl + \\", "Split the pane right (a new chat)"],
    ["Ctrl + Shift + \\", "Split the pane down"],
    ["Alt + 1…6", "Go to pane 1 to 6"],
    ["Ctrl/⌘ + Alt + arrows", "Next or previous pane"],
    ["Alt + X", "Close the pane (the session keeps running)"],
    ["Ctrl/⌘ + Shift + .", "Open or close notes"],
    ["Ctrl/⌘ + S", "Save notes now (they also save as you type)"],
    ["Ctrl + `", "Open or close the terminal"],
    ["Ctrl/⌘ + and −", "Interface size (Shift: text size), 0 resets"],
  ];
</script>

<Modal bind:open title="Commands and keys" description="Everything here also works from the prompt bar." width="max-w-lg" onclose={() => (open = false)}>
  <div class="flex flex-col gap-6">
    <section aria-labelledby="help-commands">
      <h3 id="help-commands" class="mb-2 text-[13px] font-medium text-ink">Commands</h3>
      <dl class="flex flex-col gap-1.5">
        {#each catalog.commands as c (c.name)}
          <div class="flex items-baseline gap-3">
            <dt class="w-28 shrink-0 font-mono text-[12.5px] text-ink">{c.insert}{c.args ? ` ${c.args}` : ""}</dt>
            <dd class="text-[12.5px] text-ink-muted">{c.detail}</dd>
          </div>
        {/each}
      </dl>
    </section>
    <section aria-labelledby="help-keys">
      <h3 id="help-keys" class="mb-2 text-[13px] font-medium text-ink">Keyboard</h3>
      <dl class="flex flex-col gap-1.5">
        {#each KEYS as [key, what] (key)}
          <div class="flex items-baseline gap-3">
            <dt class="w-40 shrink-0 font-mono text-[12.5px] text-ink">{key}</dt>
            <dd class="text-[12.5px] text-ink-muted">{what}</dd>
          </div>
        {/each}
      </dl>
    </section>
  </div>
</Modal>
