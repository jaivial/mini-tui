<script lang="ts">
  /**
   * Generative table: validated strings only, bounded size, and the mobile
   * rule from the standing checklist — the scroll wrapper is the affordance.
   *
   * A table is the one generative surface that carries DATA, so it is also the
   * one that has to say what it is and what it left out:
   *
   * - `<caption>` is the table's name. Measured against the built app, the
   *   accessibility tree held three `table` nodes and **all three were named
   *   ""**: a reader arriving at a 60-row liquidation was told "table, 60 rows,
   *   4 columns" and nothing else. The model's `title` never even reached the
   *   DOM — `validateTable` dropped it as an unknown key — so the caption
   *   cannot be conditional on the model having been helpful.
   * - The first column is the row's identity (`Ruta`, `Tren`, `Anden`), so it
   *   is a `<th scope="row">`: without it a cell announces as "Madrid" with no
   *   subject, and with it "R-014, Origen: Madrid".
   * - `skipped` is drawn. validateTable used to reject the WHOLE table when one
   *   row was malformed, so a single miscounted row out of sixty erased sixty
   *   good ones behind a "Tabla no renderizada" notice. Rows that still do not
   *   fit are now counted, and the count says so out loud rather than the table
   *   pretending to be complete.
   */
  import { TABLE_MAX, validateTable } from "../../ui/validate";
  import { TABLE_NOUNS, omittedNotice } from "../../ui/omittedNotice";

  let { props }: { props: Record<string, unknown> } = $props();
  const table = $derived(validateTable(props));
  /**
   * What the table left out, in one sentence. `skipped` counts rows it could not draw;
   * E23 measured the other half, which nobody was counting: the rows past the 60 cap
   * were dropped in silence, so a 100-row liquidation arrived on screen holding 60 rows
   * and saying nothing, which reads as "that was all of them".
   *
   * It reads `table` AFTER the declaration on purpose. `svelte-check` cannot narrow a
   * `$derived` union inside a sibling `$derived`, which is the same reason
   * `tableReason` below pulls `table.reason` out instead of reading it in the template.
   */
  const skippedNotice = $derived(
    table.ok
      ? omittedNotice({ ...TABLE_NOUNS, skipped: table.props.skipped, truncated: table.props.truncated, cap: TABLE_MAX })
      : "",
  );
  // Same reason as `UiChart`: the `{:else}` branch cannot narrow the `$derived`,
  // so `table.reason` there is a type error even though only an invalid one gets there.
  const tableReason = $derived(table.ok ? "" : table.reason);
  /** What the table is called when the model gave no title of its own. */
  const caption = $derived(
    !table.ok
      ? ""
      : table.props.title ||
        `Tabla: ${table.props.columns.length} columnas y ${table.props.rows.length} filas`,
  );
</script>

{#if table.ok}
  <div class="ui-table-wrap">
    <table class="ui-table">
      <caption class="ui-caption">{caption}</caption>
      <thead>
        <tr>
          {#each table.props.columns as column, i (i)}
            <th scope="col">{column}</th>
          {/each}
        </tr>
      </thead>
      <tbody>
        {#each table.props.rows as row, i (i)}
          <tr>
            {#each row as cell, j (j)}
              {#if j === 0}
                <th scope="row">{cell}</th>
              {:else}
                <td>{cell}</td>
              {/if}
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
  {#if skippedNotice}
    <!-- `role="note"`, not `role="status"`: a live region exists to announce CHANGES to
         its content, and this notice is written once, when the table is drawn. Measured both
         ways in the built app — each way reaches the accessibility tree with the text as
         its static children — so the difference is not legibility but intent: `note` says
         "this is an aside", `status` says "watch this". It is also what the sibling
         "Tabla no renderizada" branch below already uses.
         The wording lives in `ui/omittedNotice` so this notice and the list's cannot drift
         apart, and so `bun test` can hold the sentences without a DOM. -->
    <p class="ui-skip" role="note">{skippedNotice}</p>
  {/if}
{:else}
  <div class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint" role="note">
    Tabla no renderizada: {tableReason}
  </div>
{/if}

<style>
  .ui-table-wrap {
    max-width: 100%;
    overflow-x: auto;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-lg, 12px);
    background: var(--color-canvas);
  }
  .ui-table {
    border-collapse: collapse;
    width: 100%;
    font-size: 12.5px;
  }
  /* The caption is a real cell of the table, so it must read as the table's name and
     not as a floating label: it sits above the header, inside the wrapper's border. */
  .ui-caption {
    caption-side: top;
    text-align: left;
    padding: 0.5rem 0.55rem 0.35rem;
    font-weight: 600;
    font-size: 13px;
    color: var(--color-ink);
    /* A `<caption>` takes the TABLE's width, and on a wide table inside the scroll
       wrapper that is wider than what is on screen: measured at 390px, the caption of
       the 8-column table measured 501px in a 350px box, so its last words were only
       reachable by scrolling sideways.
       `position: sticky` alone does NOT fix it here — measured, a `table-caption`
       ignores it and kept travelling with the scroll (-141px at the far end). Leaving
       the caption's own `table-caption` display DOES pin it, and `max-width` in px is
       what actually brings the box back to the width of the screen: measured at the far
       right of the scroll the caption sits at x=1 in both cases, instead of -141.
       The name in the accessibility tree is unaffected — it is read from the DOM. */
    display: block;
    position: sticky;
    left: 0;
    max-width: calc(100% - 0px);
    box-sizing: border-box;
    /* The scroll wrapper paints the caption's own background, not the table's canvas
       underneath it, or the cells would show through while it slides over them. */
    background: var(--color-canvas);
  }
  .ui-table th {
    text-align: left;
    font-weight: 600;
    color: var(--color-ink);
    background: var(--color-raised);
    padding: 0.35rem 0.55rem;
    border-bottom: 1px solid var(--color-line);
    white-space: nowrap;
  }
  /* The row header shares the header look but stays in the body's reading order:
     it names the row instead of announcing a column header. */
  .ui-table tbody th {
    background: transparent;
    font-weight: 600;
    color: var(--color-ink);
    border-bottom: 0;
  }
  .ui-table td {
    padding: 0.3rem 0.55rem;
    border-top: 1px solid var(--color-line);
    color: var(--color-ink-muted);
    overflow-wrap: anywhere;
  }
  .ui-table tbody th {
    padding: 0.3rem 0.55rem;
  }
  /* Scoped to `tbody` on purpose: a bare `tr:first-child` also matches the header row
     (it is the first child of `thead`), which would take the header's own rule with it. */
  .ui-table tbody tr:first-child td,
  .ui-table tbody tr:first-child th {
    border-top: 0;
  }
  .ui-skip {
    margin-top: 0.3rem;
    padding: 0 0.15rem;
    font-size: 11.5px;
    color: var(--color-warn);
  }
</style>
