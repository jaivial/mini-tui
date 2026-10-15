<script lang="ts">
  /**
   * Generative UI dispatcher: one transcript event `ui-component` in, one native
   * Svelte component out. The template set is closed (validate.ts owns the prop
   * contracts) and nothing here can execute markup — an unknown or invalid spec
   * degrades to a quiet notice, never to an error, never to raw HTML.
   *
   * Factura Control-UI (chat patterns): bordered surface card, caption labels,
   * quiet hover states, 44px touch targets — todo con los tokens del tema.
   */
    import { validateCard, validateGallery, validateList, validateProgress, type CardProps, type GalleryProps, type ListProps, type ProgressProps } from "../../ui/validate";
  import UiForm from "./UiForm.svelte";
  import UiChart from "./UiChart.svelte";
  import UiTable from "./UiTable.svelte";
  import UiFallback from "./UiFallback.svelte";
  import { openLightbox } from "../../lightbox.svelte";

  let {
    template,
    props,
    onsubmit,
  }: {
    template: string;
    props: Record<string, unknown>;
    /** Forms submit into the chat as a normal user message. */
    onsubmit?: (message: string) => void;
  } = $props();
</script>

{#if template === "card"}
  {@const card = validateCard(props)}
  {#if card.ok}
    <div class="ui-surface" data-tone={card.props.tone}>
      <p class="ui-title">{card.props.title}</p>
      {#if card.props.body}<p class="ui-body">{card.props.body}</p>{/if}
    </div>
  {:else}
    <UiFallback reason={card.reason} />
  {/if}
{:else if template === "list"}
  {@const list = validateList(props)}
  {#if list.ok}
    <div class="ui-surface">
      {#if list.props.title}<p class="ui-title">{list.props.title}</p>{/if}
      <ul class="ui-list">
        {#each list.props.items as item, i (i)}
          <li>
            <span class="ui-item-title">{item.title}</span>
            {#if item.detail}<span class="ui-item-detail">{item.detail}</span>{/if}
          </li>
        {/each}
      </ul>
    </div>
  {:else}
    <UiFallback reason={list.reason} />
  {/if}
{:else if template === "progress"}
  {@const prog = validateProgress(props)}
  {#if prog.ok}
    <div class="ui-surface">
      {#if prog.props.label}
        <div class="flex items-baseline justify-between gap-3">
          <p class="ui-title">{prog.props.label}</p>
          <span class="tnum text-[12px] text-ink-muted">{prog.props.value}%</span>
        </div>
      {/if}
      <div class="ui-progress" role="progressbar" aria-valuenow={prog.props.value} aria-valuemin={0} aria-valuemax={100} aria-label={prog.props.label ?? "Progreso"}>
        <div class="ui-progress-fill" style:width="{prog.props.value}%"></div>
      </div>
      {#if prog.props.detail}<p class="ui-body">{prog.props.detail}</p>{/if}
    </div>
  {:else}
    <UiFallback reason={prog.reason} />
  {/if}
{:else if template === "gallery"}
  {@const gal = validateGallery(props)}
  {#if gal.ok}
    <div class="ui-surface">
      {#if gal.props.title}<p class="ui-title">{gal.props.title}</p>{/if}
      <div class="ui-gallery">
        {#each gal.props.images as img, i (i)}
          <button type="button" class="ui-gallery-item" onclick={() => openLightbox(img.src, img.alt)} aria-label={img.alt || "Abrir imagen"}>
            <img src={img.src} alt={img.alt} loading="lazy" draggable="false" />
          </button>
        {/each}
      </div>
    </div>
  {:else}
    <UiFallback reason={gal.reason} />
  {/if}
{:else if template === "form"}
  <UiForm {props} {onsubmit} />
{:else if template === "chart"}
  <UiChart {props} />
{:else if template === "table"}
  <UiTable {props} />
{:else}
  <!-- Unknown template or a __fallback__ spec from the server: the intent survives as a notice. -->
  <UiFallback reason={(props.reason as string) ?? "shape"} detail={(props.detail as string) ?? ""} requested={(props.requested as string) ?? template} />
{/if}

<style>
  .ui-surface {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    max-width: 100%;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-lg, 12px);
    background: var(--color-canvas);
  }
  .ui-surface[data-tone="info"] {
    border-color: color-mix(in oklab, var(--color-brand) 35%, var(--color-line));
  }
  .ui-surface[data-tone="ok"] {
    border-color: color-mix(in oklab, var(--color-ok) 40%, var(--color-line));
  }
  .ui-surface[data-tone="warn"] {
    border-color: color-mix(in oklab, var(--color-warn) 45%, var(--color-line));
  }
  .ui-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-ink);
  }
  .ui-body {
    font-size: 12.5px;
    line-height: 1.5;
    color: var(--color-ink-muted);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .ui-list {
    display: flex;
    flex-direction: column;
  }
  .ui-list li {
    display: flex;
    flex-direction: column;
    padding: 0.3rem 0;
    border-top: 1px solid var(--color-line);
    font-size: 13px;
  }
  .ui-list li:first-child {
    border-top: 0;
  }
  .ui-item-title {
    color: var(--color-ink);
  }
  .ui-item-detail {
    font-size: 12px;
    color: var(--color-ink-muted);
  }
  .ui-progress {
    height: 6px;
    border-radius: 999px;
    background: var(--color-raised);
    overflow: hidden;
  }
  .ui-progress-fill {
    height: 100%;
    border-radius: inherit;
    background: var(--color-brand);
    transition: width 300ms var(--ease-standard, ease);
  }
  .ui-gallery {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(96px, 1fr));
    gap: 0.375rem;
  }
  .ui-gallery-item {
    cursor: zoom-in;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-md, 8px);
    overflow: hidden;
    background: var(--color-raised);
  }
  .ui-gallery-item img {
    display: block;
    width: 100%;
    height: 80px;
    object-fit: cover;
  }
</style>
