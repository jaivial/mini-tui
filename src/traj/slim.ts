/**
 * What the TUI keeps of each raw trajectory message once it has become UI events.
 *
 * The agent's messages carry heavy extras nothing downstream needs: `extra.response` (the full
 * API reply, ~35 % of a trajectory) and `extra.raw_output` (a second copy of every tool
 * output, already rendered into events). Kept in memory they dominated the live TUI's growth,
 * and every transcript save stringified them again. `mini --resume` only reads the protocol
 * keys plus `extra.actions`/`interrupt_type`/`exit_status`/`submission`, which all stay. The
 * trajectory files on disk remain complete.
 */
import type { TrajectoryMessage } from "./schema";

const HEAVY_EXTRA = new Set(["response", "raw_output"]);

export function slimMessage(message: TrajectoryMessage): TrajectoryMessage {
  const extra = message.extra;
  if (!extra || typeof extra !== "object" || !Object.keys(extra).some((key) => HEAVY_EXTRA.has(key))) return message;
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(extra)) if (!HEAVY_EXTRA.has(key)) kept[key] = value;
  return { ...message, extra: kept };
}
