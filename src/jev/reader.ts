/**
 * Picking the cheap model that reads the diff for the verifier phase.
 *
 * The reader is deliberately NOT a separate credential: it is a normal `/connect` provider, the
 * smallest one available, so the user configures it the same way they configure a run and nothing
 * new has to be typed. Preference order is explicit before implicit: a model named in the settings
 * wins, then the first connection that serves a known-cheap id, then the smallest model of the
 * first OpenAI-compatible connection. `null` is a valid answer — the phase degrades with a reason.
 */

import { loadConnections, type SavedConnection } from "../providers";
import { cheapReader, type CheapReader } from "./verifier";

/** Models cheap enough to read a diff on every finished turn, best first. */
const CHEAP_PREFERENCE = [
  "gemini-2.0-flash",
  "gemini-2.5-flash",
  "llama-3.3-70b-versatile",
  "qwen-turbo",
  "deepseek-chat",
  "glm-4-flash",
  "haiku",
  "flash",
  "mini",
];

function openAiCompatible(connection: SavedConnection): boolean {
  // `native` connections speak a provider's own protocol; only the OpenAI-shaped ones can be
  // called with a plain /chat/completions request.
  return connection.route !== "native" || /\/v\d$/.test(connection.baseUrl) || connection.baseUrl.includes("openai");
}

export interface ReaderChoice {
  reader: CheapReader | null;
  /** Which connection + model it came from, for the report and the settings hint. */
  label: string;
  reason?: string;
}

/**
 * Resolve a reader from the saved connections.
 * `preferredModel` is the settings-panel override (`<prefix>/<id>` or a bare id).
 */
export function pickReader(preferredModel?: string, connections: SavedConnection[] = loadConnections()): ReaderChoice {
  const usable = connections.filter((c) => openAiCompatible(c));
  if (!usable.length) return { reader: null, label: "", reason: "no OpenAI-compatible provider connected (use /connect)" };

  if (preferredModel) {
    for (const connection of connections) {
      const prefix = `${connection.prefix}/`;
      const id = preferredModel.startsWith(prefix) ? preferredModel.slice(prefix.length) : preferredModel;
      if (connection.models.includes(id)) {
        return { reader: cheapReader(connection.baseUrl, connection.key, id), label: `${connection.name} · ${id}` };
      }
    }
    return { reader: null, label: "", reason: `reviewer model "${preferredModel}" is not in any connection` };
  }

  // Best cheap id across every connection, then whatever the first connection can serve.
  for (const wanted of CHEAP_PREFERENCE) {
    for (const connection of usable) {
      const id = connection.models.find((m) => m.toLowerCase().includes(wanted));
      if (id) return { reader: cheapReader(connection.baseUrl, connection.key, id), label: `${connection.name} · ${id}` };
    }
  }
  const fallback = usable[0]!;
  // No known-cheap id matched, so the connection's own default is the best guess left: `/connect`
  // already stores the model's smallest sane choice, and alphabetical order would happily hand
  // back a large one.
  const smallest = fallback.defaultModel && fallback.models.includes(fallback.defaultModel) ? fallback.defaultModel : fallback.models[0];
  if (!smallest) return { reader: null, label: "", reason: `${fallback.name} serves no models` };
  return { reader: cheapReader(fallback.baseUrl, fallback.key, smallest), label: `${fallback.name} · ${smallest}` };
}