<script lang="ts">
  /**
   * Generative table: validated strings only, bounded size, and the mobile
   * rule from the standing checklist — the scroll wrapper is the affordance.
   */
  import { validateTable } from "../../ui/validate";

  let { props }: { props: Record<string, unknown> } = $props();
  const table = $derived(validateTable(props));
</script>

{#if table.ok}
  <div class="ui-table-wrap">
    <table class="ui-table">
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
              <td>{cell}</td>
            {/each}
          </tr>
        {/each}
      </tbody>
    </table>
  </div>
{:else}
  <div class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint" role="note">
    Tabla no renderizada: {table.reason}
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
  .ui-table th {
    text-align: left;
    font-weight: 600;
    color: var(--color-ink);
    background: var(--color-raised);
    padding: 0.35rem 0.55rem;
    border-bottom: 1px solid var(--color-line);
    white-space: nowrap;
  }
  .ui-table td {
    padding: 0.3rem 0.55rem;
    border-top: 1px solid var(--color-line);
    color: var(--color-ink-muted);
    overflow-wrap: anywhere;
  }
  .ui-table tr:first-child td {
    border-top: 0;
  }
</style>
