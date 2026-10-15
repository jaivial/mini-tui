<script lang="ts">
  /**
   * Generative form: the bot asks for structured input and the answer posts
   * back into the chat as a normal user message (one turn, no new transport).
   * Fields are the validated whitelist from validate.ts; ⌘/Ctrl+Enter sends,
   * like the Control-UI discussion composer.
   */
  import { validateForm } from "../../ui/validate";

  let {
    props,
    onsubmit,
  }: {
    props: Record<string, unknown>;
    onsubmit?: (message: string) => void;
  } = $props();

  const form = $derived(validateForm(props));
  let values = $state<Record<string, string | boolean>>({});
  let sent = $state(false);

  // Reset the draft when a different form arrives in the transcript.
  $effect(() => {
    props;
    values = {};
    sent = false;
  });

  function submit(event: SubmitEvent) {
    event.preventDefault();
    if (!form.ok || sent) return;
    const parts: string[] = [];
    for (const field of form.props.fields) {
      const value = values[field.name];
      if (field.required && (value === undefined || value === "" || value === false)) return; // HTML5 also guards this
      if (value === undefined || value === "" || value === false) continue;
      parts.push(`${field.label}: ${value === true ? "sí" : String(value)}`);
    }
    sent = true;
    const head = form.props.title ? `${form.props.title}` : "Formulario";
    onsubmit?.(`[${head}] ${parts.join(" · ")}`);
  }
</script>

{#if form.ok}
  <form class="ui-form" aria-label={form.props.title ?? "Formulario"} onsubmit={submit}>
    {#if form.props.title}<p class="ui-form-title">{form.props.title}</p>{/if}
    {#each form.props.fields as field (field.name)}
      <label class="ui-field">
        <span class="ui-field-label">
          {field.label}{#if field.required}<span class="ui-required" aria-hidden="true">*</span>{/if}
        </span>
        {#if field.type === "select"}
          <select class="ui-input" bind:value={values[field.name]} required={field.required}>
            <option value="" disabled selected>Elige…</option>
            {#each field.options ?? [] as option (option)}
              <option value={option}>{option}</option>
            {/each}
          </select>
        {:else if field.type === "checkbox"}
          <input
            class="ui-checkbox"
            type="checkbox"
            checked={values[field.name] === true}
            onchange={(event) => (values[field.name] = event.currentTarget.checked)}
          />
        {:else}
          <input
            class="ui-input"
            type={field.type}
            bind:value={values[field.name]}
            required={field.required}
            placeholder={field.placeholder}
          />
        {/if}
      </label>
    {/each}
    <div class="ui-form-actions">
      <span class="ui-form-hint">⌘ Enter para enviar</span>
      <button type="submit" class="ui-submit" disabled={sent}>{sent ? "Enviado" : form.props.submitLabel}</button>
    </div>
  </form>
{:else}
  <!-- invalid: same quiet notice as every other broken spec -->
  <div class="flex items-start gap-2 rounded-lg border border-dashed border-line px-3 py-2 text-[12px] text-ink-faint" role="note">
    Formulario no renderizado: {form.ok ? "" : form.reason}
  </div>
{/if}

<style>
  .ui-form {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    max-width: 100%;
    padding: 0.75rem 0.875rem;
    border: 1px solid var(--color-line);
    border-radius: var(--radius-lg, 12px);
    background: var(--color-canvas);
  }
  .ui-form-title {
    font-weight: 600;
    font-size: 13px;
    color: var(--color-ink);
  }
  .ui-field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .ui-field-label {
    font-size: 12px;
    color: var(--color-ink-muted);
  }
  .ui-required {
    color: var(--color-warn);
  }
  .ui-input {
    min-height: 2.25rem;
    padding: 0.25rem 0.5rem;
    border: 1px solid var(--color-line-strong, var(--color-line));
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface, var(--color-canvas));
    color: var(--color-ink);
    font-size: 13px;
  }
  .ui-input:focus-visible {
    outline: 2px solid var(--color-brand);
    outline-offset: 1px;
  }
  .ui-checkbox {
    width: 1rem;
    height: 1rem;
    accent-color: var(--color-brand);
  }
  .ui-form-actions {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    margin-top: 0.25rem;
  }
  .ui-form-hint {
    font-size: 11.5px;
    color: var(--color-ink-faint);
  }
  .ui-submit {
    min-height: 2.25rem;
    padding: 0 0.875rem;
    border: 0;
    border-radius: 999px;
    background: var(--color-brand);
    color: var(--color-brand-ink, #fff);
    font-size: 12.5px;
    font-weight: 600;
    cursor: pointer;
  }
  .ui-submit:disabled {
    opacity: 0.55;
    cursor: default;
  }
  @media (pointer: coarse) {
    .ui-input {
      font-size: 16px; /* no iOS focus zoom */
    }
    .ui-submit {
      min-height: 2.75rem;
    }
  }
</style>
