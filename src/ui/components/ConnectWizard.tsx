import { colors } from "../theme";
import { filterModels, visibleSlice, type ConnectStep } from "../../connect";
import type { ProviderDef } from "../../providers";

/** `/connect` wizard: provider → API key → model → connection test. */
export function ConnectWizard(props: { step: ConnectStep; providers: ProviderDef[]; areaHeight?: number }) {
  const step = props.step;
  // Keep the panel inside the available area: window the lists instead of overflowing.
  const budget = Math.max(4, (props.areaHeight ?? 24) - 4);
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" marginLeft="auto" marginRight="auto" paddingX={1} gap={0}>
      <text fg={colors.dim}>connect provider · Esc close</text>

      {step.kind === "provider" ? (
        <>
          {visibleSlice(props.providers, step.index, budget).items.map((provider) => {
            const index = props.providers.indexOf(provider);
            const selected = index === step.index;
            return (
              <box key={provider.id} flexDirection="row" gap={2}>
                <text fg={colors.accent}>{selected ? "▸" : " "}</text>
                <text fg={selected ? colors.text : colors.dim}>{provider.name}</text>
                <text fg={colors.faint}>{provider.description}</text>
              </box>
            );
          })}
          <text fg={colors.faint}>↑/↓ move · Enter select</text>
        </>
      ) : null}

      {step.kind === "key" ? (
        <>
          <text fg={colors.text}>{step.def.name}</text>
          <text fg={colors.dim}>paste your API key — it is stored locally and injected into mini runs</text>
          <box flexDirection="row" gap={1}>
            <text fg={colors.faint}>key</text>
            <text fg={colors.text}>{step.value ? "•".repeat(Math.min(step.value.length, 32)) : "▏"}</text>
          </box>
          <text fg={colors.faint}>Enter continue · Esc back</text>
        </>
      ) : null}

      {step.kind === "models" ? (
        <>
          <text fg={colors.text}>{step.def.name} · pick the default model ({step.models.length} available)</text>
          <box flexDirection="row" gap={1}>
            <text fg={colors.faint}>search</text>
            <text fg={colors.text}>{step.query}▏</text>
          </box>
          {step.models.length === 0 ? <text fg={colors.faint}>no models match</text> : null}
          {visibleSlice(filterModels(step.models, step.query), step.index, budget - 2).items.map((model, i, all) => {
            const filtered = filterModels(step.models, step.query);
            const index = filtered.indexOf(model, filtered.length - all.length >= 0 ? 0 : 0);
            const selected = model === filtered[step.index];
            return (
              <box key={model} flexDirection="row" gap={1}>
                <text fg={colors.accent}>{selected ? "▸" : " "}</text>
                <text fg={selected ? colors.text : colors.dim}>{model}</text>
              </box>
            );
          })}
          {step.error ? <text fg={colors.err}>✗ {step.error}</text> : null}
          <text fg={colors.faint}>↑/↓ move · Enter test &amp; save · Esc back</text>
        </>
      ) : null}

      {step.kind === "testing" ? (
        <>
          <text fg={colors.text}>
            {step.def.name} · {step.model}
          </text>
          <text fg={colors.dim}>testing the connection with your key…</text>
        </>
      ) : null}

      {step.kind === "done" ? (
        <>
          <text fg={colors.ok}>● connected</text>
          <text fg={colors.text}>
            {step.def.name} · {step.model}
          </text>
          <text fg={colors.dim}>{step.count} models added to /model</text>
          <text fg={colors.faint}>Esc close</text>
        </>
      ) : null}

      {step.kind === "error" ? (
        <>
          <text fg={colors.err}>✗ could not connect</text>
          <text fg={colors.dim}>{step.message}</text>
          <text fg={colors.faint}>Esc close · /connect to retry</text>
        </>
      ) : null}
    </box>
  );
}
