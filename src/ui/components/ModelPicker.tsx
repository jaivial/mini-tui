import { useEffect, useState } from "react";
import type { SelectOption } from "@opentui/core";
import { useKeyboard, usePaste } from "@opentui/react";

import { gatewayServes, loadCliproxyCatalog, type CliproxyCatalog } from "../../cliproxyCatalog";
import { colors } from "../theme";
import { pasteText, pastedToken } from "../../clipboard";
import { MODELS } from "../../models";

export { MODELS };

/** Case-insensitive substring filter over option names (and model ids). */
export function filterOptions(options: SelectOption[], query: string): SelectOption[] {
  const needle = query.trim().toLowerCase();
  if (!needle) return options;
  return options.filter(
    (option) => option.name.toLowerCase().includes(needle) || String(option.value ?? "").toLowerCase().includes(needle),
  );
}

export function indexForModel(model: string | undefined): number {
  const index = MODELS.findIndex((option) => option.value === model);
  return index >= 0 ? index : 1;
}

export function ModelPicker(props: {
  current?: string;
  models?: SelectOption[];
  areaHeight?: number;
  onPick: (model: string) => void;
  onCancel: () => void;
}) {
  const models = props.models ?? MODELS;
  // cli-proxy drops a model from /v1/models when its subscription signs out, so the picker checks
  // the catalog and says so instead of letting the run fail with `auth_unavailable` later.
  const [catalog, setCatalog] = useState<CliproxyCatalog | null>(null);
  useEffect(() => {
    let alive = true;
    loadCliproxyCatalog().then((next) => {
      if (alive) setCatalog(next);
    });
    return () => {
      alive = false;
    };
  }, []);
  const unserved = (model: string): boolean => gatewayServes(catalog, model) === false;
  const annotate = (option: SelectOption): SelectOption =>
    unserved(String(option.value))
        ? { ...option, description: `${option.description ?? ""} — NOT SERVED by cli-proxy (subscription signed out)`.trim() }
      : option;
  const annotated = models.map(annotate);
  const indexFor = (model: string | undefined): number => {
    const index = annotated.findIndex((option) => option.value === model);
    return index >= 0 ? index : 0;
  };
  const [selectedIndex, setSelectedIndex] = useState(() => indexFor(props.current));
  const [query, setQuery] = useState("");
  const options = filterOptions(annotated, query);
  const search = (text: string) => {
    const token = pastedToken(text);
    if (!token) return;
    setQuery((current) => current + token);
    setSelectedIndex(0);
  };

  // The focused select keeps ↑/↓/Enter; the search line takes typing and pastes
  // (it is display-only, like the /connect wizard's inputs).
  useKeyboard((key) => {
    if (key.name === "backspace") {
      setQuery((current) => current.slice(0, -1));
      setSelectedIndex(0);
      return;
    }
    if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) return search(pasteText());
    const ch = key.sequence;
    if (ch && !key.ctrl && !key.meta && ch >= " ") search(ch);
  });
  usePaste((event) => {
    const token = pastedToken(new TextDecoder().decode(event.bytes));
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    setQuery((current) => current + token);
    setSelectedIndex(0);
  });
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
      <text fg={colors.dim}>model · ↑/↓ choose · Enter apply · Esc close (applies from the next step)</text>
      <box flexDirection="row" gap={1}>
        <text fg={colors.faint}>search</text>
        <text fg={colors.text}>{query}▏</text>
      </box>
      {options.length === 0 ? <text fg={colors.faint}>no models match</text> : null}
      <select
        options={options}
        selectedIndex={selectedIndex}
        focused
        wrapSelection
        showDescription
        showScrollIndicator
        width="100%"
        height={Math.max(5, Math.min(14, (props.areaHeight ?? 18) - 5))}
        backgroundColor={colors.bg}
        focusedBackgroundColor={colors.bg}
        focusedTextColor={colors.text}
        textColor={colors.dim}
        selectedBackgroundColor={colors.panel}
        selectedTextColor={colors.text}
        descriptionColor={colors.faint}
        selectedDescriptionColor={colors.dim}
        onChange={(index: number) => setSelectedIndex(index)}
        onSelect={(_index: number, option: SelectOption | null) => {
          if (option?.value) props.onPick(String(option.value));
        }}
      />
    </box>
  );
}
