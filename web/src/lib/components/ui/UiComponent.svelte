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
    import { LIST_MAX, validateCard, validateGallery, validateList, validateProgress, type CardProps, type GalleryProps, type ListProps, type ProgressProps } from "../../ui/validate";
  import { LIST_NOUNS, omittedNotice } from "../../ui/omittedNotice";
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

  /** Stable per-instance id so the list's `aria-labelledby` can point at its own title. */
  // `$props.id()` tiene que ser la declaracion misma, no una plantilla: Svelte 5 lo
  // rechaza como "initializer" si lo envuelves en otro sitio (`svelte-check` lo dice).
  const uid = $props.id();
  const uidTitle = `${uid}-title`;
  const rawList = $derived(validateList(props));
  /** What the list is called when the model wrote no title of its own. */
  const listName = $derived(
    rawList.ok
      ? `Lista: ${rawList.props.items.length} ${rawList.props.items.length === 1 ? "elemento" : "elementos"}`
      : "",
  );
  /** What the list left out: items it could not draw, and items past the cap. */
  const listNotice = $derived(
    rawList.ok
      ? omittedNotice({ ...LIST_NOUNS, skipped: rawList.props.skipped, truncated: rawList.props.truncated, cap: LIST_MAX })
      : "",
  );
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
      <!--
        The list was the one generative surface that never said what it was. Measured
        against the deployed build, the accessibility tree held four `list` nodes and
        three of them were named "" — the model's `title` arrived, but as a loose `<p>`
        ABOVE the `<ul>`, where nothing links it to the list. A reader entering a
        fifty-step checklist heard "list, 50 items" and nothing else.

        A `<ul>` has no `<caption>`, so the name goes on the list itself. It points at
        the title element rather than repeating the text in `aria-label`: one string,
        one place, and the visible title and the announced name cannot drift apart.
        When the model wrote no title the list is still named, from its own shape —
        the same rule E22 set for the table, whose caption cannot depend on the model
        having been helpful.
      -->
      {#if list.props.title}<p class="ui-title" id={uidTitle}>{list.props.title}</p>{/if}
      <ul class="ui-list" aria-labelledby={list.props.title ? uidTitle : undefined} aria-label={list.props.title ? undefined : listName}>
        {#each list.props.items as item, i (i)}
          <li>
            <span class="ui-item-title">{item.title}</span>
            {#if item.detail}<span class="ui-item-detail">{item.detail}</span>{/if}
          </li>
        {/each}
      </ul>
      {#if listNotice}
        <!-- `role="note"`, not `role="status"`: same reason as the table's sibling notice
             below — a live region announces CHANGES to its content, and this text is
             written once, when the list is drawn. -->
        <p class="ui-skip" role="note">{listNotice}</p>
      {/if}
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
  /* The same aside as the table's, one surface down: the notice is information ABOUT the
     list, not part of it, so it sits outside the <ul> and can never be counted as an item. */
  .ui-skip {
    margin-top: 0.3rem;
    padding: 0 0.15rem;
    font-size: 11.5px;
    color: var(--color-warn);
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
