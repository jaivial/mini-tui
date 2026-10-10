import { useEffect, useMemo, useRef, useState } from "react";
import { useKeyboard, usePaste } from "@opentui/react";

import { colors } from "../theme";
import { pasteText, pastedToken } from "../../clipboard";
import { jevModels } from "../../jev/client";
import { JEV_KEY_NAME, getSecret, maskKeyHint, setSecret } from "../../jev/vault";
import { pickReader } from "../../jev/reader";
import type { Settings } from "../../settings";

type Row = "enabled" | "verifier" | "key";
const ROWS: Row[] = ["enabled", "verifier", "key"];

/**
 * `/settings` → group 3: the two Jev toggles and the API key.
 *
 * They are separate rows on purpose. "jev" is the decision service being available (its key, its
 * checks); "verifier phase" is the post-code phase that spends money on every finished turn. A user
 * who wants the service but not the automatic phase — or the phase but wants to feed it their own
 * machine-wide key — can say exactly that: neither toggle reads the other's state.
 *
 * The panel owns every key while it is open (App only routes Tab to this group), because the key
 * field needs plain characters and the other rows need ↑/↓.
 */
export function JevSettings(props: {
  settings: Settings;
  onChange: (patch: Partial<Settings>) => void;
  onDone: () => void;
}) {
  const [row, setRow] = useState<Row>("enabled");
  // A ref, not a second piece of state: the keyboard callback must see the current row on the very
  // first keypress after a move, without waiting for the next render.
  const rowRef = useRef<Row>("enabled");
  const move = (delta: number) => {
    const next = ROWS[(ROWS.indexOf(rowRef.current) + delta + ROWS.length) % ROWS.length]!;
    rowRef.current = next;
    setRow(next);
  };
  // An empty draft means "nothing typed yet", which is how a saved key is never wiped by a stray
  // Enter on the row: the draft only commits when the user actually typed something.
  const [draft, setDraft] = useState("");
  const [showKey, setShowKey] = useState(false);
  const [saved, setSaved] = useState(() => getSecret(JEV_KEY_NAME));
  const [status, setStatus] = useState<string>("");
  const [checking, setChecking] = useState(false);

  const enabled = Boolean(props.settings.jevEnabled);
  const verifier = Boolean(props.settings.jevVerifierEnabled);
  const hint = saved ? maskKeyHint(saved) : "not set";
  // One read of providers.json for the label; the connections only change through /connect.
  const readerLabel = useMemo(() => pickReader().label || "none", [props.settings.jevVerifierEnabled]);

  // The reachability probe: a real GET /v1/models with the key in force, so "on" is never a lie
  // about a key that does not work. Only runs when the user asks (the `c` key), never on a render.
  const check = async () => {
    setChecking(true);
    setStatus("checking api.typesafe.ai…");
    const result = await jevModels();
    setChecking(false);
    setStatus(
      result.ok
        ? `ok · ${result.models.join(", ") || result.model} · key from ${result.source}`
        : `unreachable · ${result.error ?? "unknown"} · key from ${result.source || "nothing"}`,
    );
  };

  const commit = (value: string) => {
    setSecret(JEV_KEY_NAME, value);
    setSaved(getSecret(JEV_KEY_NAME));
    setDraft("");
    setShowKey(false);
    setStatus(value ? "key saved to the vault as jev-api-key" : "key cleared");
  };

  useKeyboard((key) => {
    if (key.name === "escape") return props.onDone();
    if (key.name === "up") return move(-1);
    if (key.name === "down") return move(1);
    if (key.name === "tab") {
      if (rowRef.current === "key") return setShowKey((v) => !v);
      return move(1);
    }
    if (key.name === "return" || key.name === "enter" || key.name === "kpenter") {
      if (rowRef.current === "enabled") return props.onChange({ jevEnabled: !enabled });
      if (rowRef.current === "verifier") return props.onChange({ jevVerifierEnabled: !verifier });
      return commit(draft || saved); // Enter with no draft re-saves what is stored (a no-op write)
    }
    if (rowRef.current === "key") {
      if (key.name === "backspace") return setDraft((current) => current.slice(0, -1));
      if ((key.ctrl && key.name === "v") || (key.shift && key.name === "insert")) {
        const token = pastedToken(pasteText());
        if (token) setDraft((current) => current + token);
        return;
      }
      const ch = key.sequence;
      if (ch && !key.ctrl && !key.meta && ch >= " ") return setDraft((current) => current + ch);
      return;
    }
    // `c` tests the key from any row, so a failed connection is diagnosable without leaving /settings.
    if (key.sequence === "c" && !key.ctrl && !key.meta) return void check();
  });

  usePaste((event) => {
    if (rowRef.current === "key") return;
    const token = pastedToken(new TextDecoder().decode(event.bytes));
    if (!token) return;
    event.preventDefault();
    event.stopPropagation();
    setDraft((current) => current + token);
  });

  // Refresh the masked hint when the panel re-opens after a key was saved elsewhere (e.g. the CLI).
  useEffect(() => {
    setSaved(getSecret(JEV_KEY_NAME));
  }, [props.settings.jevEnabled]);

  const toggleRow = (name: string, value: boolean, description: string, focused: boolean) => (
    <box key={name} flexDirection="column">
      <box flexDirection="row" gap={1}>
        <text fg={colors.accent}>{focused ? "▸" : " "}</text>
        <text fg={focused ? colors.text : colors.dim}>{name}</text>
        <text fg={value ? colors.ok : colors.faint}>{value ? "ON" : "OFF"}</text>
      </box>
      <text fg={colors.faint}>  {description}</text>
    </box>
  );

  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" paddingX={1} gap={0}>
      <text fg={colors.dim}>jev · ↑/↓ row · Enter toggle/save · Esc close</text>

      {toggleRow("jev", enabled, "TypeSafe System One decisions · OFF = no jev calls at all", row === "enabled")}
      {toggleRow("verifier phase", verifier, `after a finished turn: cheap LLM reads the diff, jev judges · reviewer ${readerLabel}`, row === "verifier")}

      <box flexDirection="column">
        <box flexDirection="row" gap={1}>
          <text fg={colors.accent}>{row === "key" ? "▸" : " "}</text>
          <text fg={row === "key" ? colors.text : colors.dim}>api key</text>
          <text fg={colors.faint}>{saved && !draft ? hint : ""}</text>
        </box>
        <box flexDirection="row" gap={1}>
          <text fg={colors.faint}>{"  "}</text>
          <text fg={colors.text}>{draft ? (showKey ? draft : "•".repeat(draft.length)) : row === "key" ? "▏" : ""}</text>
        </box>
        <text fg={colors.faint}>  vault entry jev-api-key (0600) · Tab shows/hides · Enter saves</text>
      </box>

      {status ? <text fg={colors.dim}>{status}</text> : null}
      <text fg={colors.faint}>c = test this key against api.typesafe.ai {checking ? "· checking…" : ""}</text>
    </box>
  );
}