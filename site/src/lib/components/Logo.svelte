<script lang="ts">
  let { class: klass = "size-6" }: { class?: string } = $props();
</script>

<svg class={klass} viewBox="0 0 32 32" fill="none" aria-hidden="true">
  <rect width="32" height="32" rx="8" fill="currentColor" class="text-primary" />
  <path d="M9 11l5 5-5 5" stroke="var(--primary-foreground)" stroke-width="2.4" stroke-linecap="round" stroke-linejoin="round" />
  <path d="M17 21h6" stroke="var(--primary-foreground)" stroke-width="2.4" stroke-linecap="round" />
</svg>
