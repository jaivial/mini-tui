import { colors } from "../theme";
import { visibleSlice } from "../../connect";
import { STATE_LABEL, addRows, remaining, type McpStep } from "../../mcpPanel";
import type { McpPreset, McpServerView } from "../../mcp/index";

const STATE_COLOR = (state: McpServerView["state"]) =>
  state === "connected" || state === "ready" ? colors.ok : state === "disabled" ? colors.faint : colors.warn;

/**
 * `/mcp`: install remote MCP servers and log in to the ones that use OAuth. The login runs in the
 * background (a loopback listener waits for the browser); this panel only shows where it is.
 */
export function McpPanel(props: { step: McpStep; servers: McpServerView[]; presets: McpPreset[]; areaHeight?: number; now?: number }) {
  const { step, servers } = props;
  const budget = Math.max(4, (props.areaHeight ?? 24) - 6);
  return (
    <box borderStyle="rounded" borderColor={colors.border} backgroundColor={colors.panel} width="80%" marginLeft="auto" marginRight="auto" paddingX={1} gap={0}>
      <text fg={colors.dim}>mcp servers · Esc {step.kind === "list" ? "close" : "back"}</text>

      {step.kind === "list" ? (
        <>
          {servers.length === 0 ? <text fg={colors.faint}>no MCP servers installed yet</text> : null}
          {visibleSlice([...servers, null], step.index, budget).items.map((s) => {
            const at = s ? servers.indexOf(s) : servers.length;
            const selected = at === step.index;
            if (!s) {
              return (
                <box key="add" flexDirection="row" gap={1}>
                  <text fg={colors.accent}>{selected ? "▸" : " "}</text>
                  <text fg={selected ? colors.text : colors.dim}>+ add a server</text>
                </box>
              );
            }
            return (
              <box key={s.id} flexDirection="row" gap={2}>
                <text fg={colors.accent}>{selected ? "▸" : " "}</text>
                <text fg={selected ? colors.text : colors.dim}>{s.name}</text>
                <text fg={STATE_COLOR(s.state)}>● {STATE_LABEL[s.state]}</text>
                <text fg={colors.faint}>{s.url}</text>
              </box>
            );
          })}
          {step.busy ? <text fg={colors.accent}>… {step.busy}</text> : null}
          {step.note ? <text fg={colors.dim}>{step.note}</text> : null}
          <text fg={colors.faint}>↑/↓ move · Enter log in / test · a add · l log out · x enable/disable · d remove</text>
        </>
      ) : null}

      {step.kind === "add" ? (
        <>
          <box flexDirection="row" gap={1}>
            <text fg={colors.faint}>search</text>
            <text fg={colors.text}>{step.query}▏</text>
          </box>
          {(() => {
            const rows = addRows(props.presets, step.query, servers.map((s) => s.preset ?? ""));
            return visibleSlice(rows, step.index, budget - 1).items.map((row) => {
              const selected = row === rows[step.index];
              const key = row === "custom" ? "custom" : row.id;
              return (
                <box key={key} flexDirection="row" gap={2}>
                  <text fg={colors.accent}>{selected ? "▸" : " "}</text>
                  <text fg={selected ? colors.text : colors.dim}>{row === "custom" ? "custom URL…" : row.name}</text>
                  <text fg={colors.faint}>{row === "custom" ? "any Streamable HTTP MCP server" : `${row.description}${row.auth === "oauth" ? " · OAuth" : row.auth === "local" ? " · local" : ""}`}</text>
                </box>
              );
            });
          })()}
          <text fg={colors.faint}>↑/↓ move · Enter install · type to search</text>
        </>
      ) : null}

      {step.kind === "url" ? (
        <>
          <text fg={colors.text}>MCP server URL (Streamable HTTP)</text>
          <box flexDirection="row" gap={1}>
            <text fg={colors.faint}>url</text>
            <text fg={colors.text}>{step.value}▏</text>
          </box>
          {step.error ? <text fg={colors.err}>✗ {step.error}</text> : null}
          <text fg={colors.faint}>Enter add · Esc back · Ctrl+V paste</text>
        </>
      ) : null}

      {step.kind === "login" ? (
        <>
          <text fg={colors.text}>
            log in to {step.login.serverName} {step.login.status === "exchanging" ? "· finishing…" : "· waiting for the browser"}
          </text>
          <text fg={colors.dim}>open this link, approve access, and this panel completes by itself:</text>
          <text fg={colors.accent} wrapMode="char">
            <a href={step.login.url}>{step.login.url}</a>
          </text>
          <box flexDirection="row" gap={2}>
            <text fg={step.copied ? colors.ok : colors.text}>[c] {step.copied ? "copied ✓" : "copy link"}</text>
            <text fg={step.opened ? colors.ok : colors.text}>[o] {step.opened ? `opened (${step.opened}) ✓` : "open in browser"}</text>
            <text fg={step.pasting !== undefined ? colors.accent : colors.text}>[p] paste the redirect URL</text>
          </box>
          {step.pasting !== undefined ? (
            <>
              <text fg={colors.dim}>browser on another machine? after approving, paste the address it ended on:</text>
              <box flexDirection="row" gap={1}>
                <text fg={colors.faint}>url</text>
                <text fg={colors.text} wrapMode="char">{step.pasting}▏</text>
              </box>
            </>
          ) : null}
          {step.pasteError ? <text fg={colors.err}>✗ {step.pasteError}</text> : null}
          <text fg={colors.faint}>
            callback {step.login.redirectUri} · expires in {remaining(step.login.expiresAt, props.now)} · Esc cancel
          </text>
        </>
      ) : null}

      {step.kind === "done" ? (
        <>
          <text fg={colors.ok}>● {step.name} connected</text>
          <text fg={colors.dim}>{step.tools} tools available to the agent from the next turn</text>
          <text fg={colors.faint}>Enter / Esc back to the list</text>
        </>
      ) : null}

      {step.kind === "error" ? (
        <>
          <text fg={colors.err}>✗ {step.message}</text>
          <text fg={colors.faint}>{step.serverId ? "r retry · " : ""}Enter / Esc back to the list</text>
        </>
      ) : null}
    </box>
  );
}
