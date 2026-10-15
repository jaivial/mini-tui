/**
 * Operator chat command (v6-C): `/router on|off|status|why` in a bound thread
 * drives the model router from WhatsApp, with no model turn and no
 * prompt-injection surface:
 *
 *   - Authority is operator-grade configuration, never message content: the
 *     command only fires for a sender already on the thread's own allowlist
 *     (the exact same list the accept boundary enforces). Anyone else's
 *     "/router on" is plain text for the normal turn.
 *   - **It is the same toggle as the Settings panel.** Both read and write
 *     `settings.json`, so flipping the switch in the web UI and typing `/router
 *     off` in a thread are the same act — which is what "toggle en Settings Y
 *     comando de WhatsApp equivalente" has to mean.
 *   - Handled rows are acknowledged BEFORE the deferred work runs, exactly like
 *     `/rename` and `/newsession`: a crash mid-command replays nothing.
 *
 * `/router why <id>` is the audit made conversational: it answers "why did that
 * run pick that model" from the decision trail, with the variables that weighed.
 */

import type { Inbound } from "./inbox";
import type { PendingRow } from "./consumer";
import type { GroupBridgeOptions } from "./groupBridge";
import { loadSettings, saveSettings } from "../settings";
import { auditStore, breakerStore, routerStatus, route } from "../router";
import { layaHealth } from "../router/laya";
import { loadCatalog } from "../router/candidates";

/** The whole message must be the command: a mention of it mid-sentence is text. */
export const ROUTER_COMMAND = /^\/router(?:\s+([\s\S]+))?$/;
const MAX_ARGS_BYTES = 200;

export interface RouterCommandPlan {
  after: () => Promise<void>;
}

function reply(line: string, detail: string): string {
  return detail ? `${line}\n${detail}` : line;
}

/** `/router` with no argument, or `status`: what the router can see right now. */
function statusText(): string {
  const status = routerStatus();
  const lines = [
    `Router ${status.enabled ? "ON" : "OFF"}.`,
    `Catálogo: ${status.catalogModels} modelos (${status.catalogUnknownIndex} sin índice de inteligencia), ${status.connected} con conexión.`,
    `Decisiones 24h: ${status.decisions24h} (${status.fallbacks24h} por fallback).`,
  ];
  if (status.breakers.length) {
    const open = status.breakers.filter((b) => b.state !== "closed").slice(0, 4);
    if (open.length) {
      lines.push(`Circuitos abiertos: ${open.map((b) => `${b.model} (${b.reason})`).join(", ")}.`);
    }
  }
  lines.push(
    status.enabled
      ? "Cada tarea, subagente delegado y sub-tarea se enruta sola. `/router why <id>` explica una decisión."
      : "Con el router apagado manda el selector manual de modelo, como siempre. `/router on` para activarlo.",
  );
  return reply(lines[0]!, lines.slice(1).join("\n"));
}

/** `/router why [id]` — the audit trail, in chat. */
function whyText(argument: string): string {
  const audit = auditStore();
  const id = Number(argument.trim());
  const entry = Number.isFinite(id) && id > 0
    ? audit.recent(500).find((row) => row.id === id)
    : audit.recent(1)[0];
  if (!entry) return "No encuentro esa decisión en el historial.";
  const lines = [
    `Decisión #${entry.id} · ${new Date(entry.at).toLocaleString("es")} · nivel ${entry.level}`,
    `Elegido: ${entry.chosen} (${entry.source})`,
  ];
  if (entry.layaProbability !== null) {
    lines.push(`Laya P=${entry.layaProbability.toFixed(3)} confianza=${(entry.layaConfidence ?? 0).toFixed(3)} · checkpoint ${entry.layaCheckpoint || "?"}`);
  } else if (entry.layaReason) {
    lines.push(`Laya no respondió: ${entry.layaReason}`);
  }
  if (entry.from) lines.push(`Fallback desde: ${entry.from}${entry.fallbackReason ? ` (${entry.fallbackReason})` : ""}`);
  lines.push(`Motivo: ${entry.reason}`);
  const top = entry.ranking.slice(0, 5);
  if (top.length) {
    lines.push("Candidatos:");
    for (const row of top) {
      const parts = [
        `  ${row.model} score=${row.score.toFixed(4)}`,
        row.terms.intelligence !== null ? `idx=${row.terms.intelligence}` : "idx=?",
        row.terms.price !== null ? `$${Number(row.terms.price).toFixed(3)}/1M` : "precio=?",
        row.excluded ? `EXCLUIDO (${row.excluded})` : "",
      ].filter(Boolean);
      lines.push(parts.join(" "));
    }
  }
  return reply(lines.join("\n"), "");
}

/**
 * Recognize the operator's `/router` command in an accepted row. Returns null
 * when the message is not this command (wrong sender, wrong shape) and must flow
 * through the normal turn path.
 */
export function planRouterCommand(options: GroupBridgeOptions, row: PendingRow, message: Inbound): RouterCommandPlan | null {
  const log = options.log ?? (() => {});
  const match = ROUTER_COMMAND.exec(message.text.trim());
  if (!match) return null;
  const binding = options.inbox.bindingFor("whatsapp", row.account, row.thread);
  if (!binding || !binding.allowedSenders.includes(message.sender)) {
    log("channel.router_command.denied", { seq: row.seq, thread: row.thread, sender: message.sender });
    return null;
  }
  const argument = (match[1] ?? "").trim();
  const quoted = { id: message.messageId, remoteJid: row.thread, ...(message.sender ? { participant: message.sender } : {}) };

  const after = async (): Promise<void> => {
    const sender = options.senderFor(row.account);
    const send = (text: string) => sender?.sendText({ number: row.thread, text, quoted }).catch(() => {});
    if (Buffer.byteLength(argument) > MAX_ARGS_BYTES) {
      await send("Uso: /router on | off | status | why [id]");
      return;
    }
    const verb = argument.split(/\s+/)[0]?.toLowerCase() ?? "";
    try {
      if (verb === "on" || verb === "off") {
        const next = verb === "on";
        const settings = loadSettings();
        saveSettings({ ...settings, modelRouterEnabled: next });
        log("channel.router_command.toggled", { seq: row.seq, enabled: next });
        // The state is echoed back with the consequence spelled out, because the
        // operator's real question is "what changes now", not "is the flag set".
        await send(
          next
            ? "Router activado. A partir de ahora cada tarea, cada subagente delegado y cada sub-tarea dentro de un agente eligen su propio modelo por cuota, precio, índice de inteligencia y disponibilidad, con fallback automático si un proveedor falla. `/router why` explica la última decisión."
            : "Router apagado. Vuelve a mandar el selector manual de modelo exactamente como antes: nada cambia en cómo se elige el modelo.",
        );
        return;
      }
      if (verb === "why") {
        await send(whyText(argument.split(/\s+/).slice(1).join(" ")));
        return;
      }
      if (verb === "status" || argument === "") {
        await send(statusText());
        return;
      }
      // An unrecognised verb still answers with something useful rather than a
      // silent no-op: the operator learns the real state and the real syntax.
      const health = await layaHealth();
      const catalog = loadCatalog();
      await send(
        `No entiendo "${argument}".\n${statusText()}\nLaya: ${health.reachable ? `disponible (${health.detail})` : `no disponible (${health.detail})`}. Catálogo: ${catalog.models.length} modelos.`,
      );
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      log("channel.router_command.failed", { seq: row.seq, error: reason.slice(0, 200) });
      await send(`(no pude ejecutar /router: ${reason.slice(0, 120)})`);
    }
  };
  return { after };
}

/** Exported for the tests: the command's own decision path, without a channel. */
export { statusText, whyText };