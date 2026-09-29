<script lang="ts">
  // Loading placeholder. Size it to the content that will replace it so nothing jumps
  // when the real thing lands. Decorative, so hidden from assistive tech: pair a group
  // of skeletons with one labelled `role="status"` instead.
  let {
    variant = "shimmer",
    class: klass = "",
  }: { variant?: "shimmer" | "pulse" | "none"; class?: string } = $props();
</script>

<div aria-hidden="true" data-variant={variant} class="skeleton rounded-md bg-raised {klass}"></div>

<style>
  .skeleton[data-variant="shimmer"] {
    background-image: linear-gradient(90deg, transparent 30%, color-mix(in oklab, var(--color-ink) 7%, transparent) 50%, transparent 70%);
    background-size: 200% 100%;
    animation: shimmer-bar 1.6s linear infinite;
  }
  .skeleton[data-variant="pulse"] {
    animation: pulse-dot 1.6s var(--ease-standard) infinite;
  }
</style>
