<script lang="ts">
  import { boundedText } from "../format";
  import { markdown } from "../markdown";

  let { text, class: klass = "" }: { text: string; class?: string } = $props();

  // The engine arrives with the first message. Until it does the same text shows as plain
  // lines, so nothing shifts when the HTML replaces it a moment later.
  let html = $state("");
  $effect(() => {
    const source = boundedText(text, 400, 20_000);
    let live = true;
    void markdown.render(source).then((value) => {
      if (live) html = value;
    });
    return () => {
      live = false;
    };
  });
</script>

<div class="prose-mini {klass}">{@html html}</div>
