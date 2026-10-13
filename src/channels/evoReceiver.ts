/** Prepared receiver only. No server, instance mutation, bindings, task launch or sends. */
import { createHash, timingSafeEqual } from "node:crypto";
import { ChannelInbox } from "./inbox";
import { normalizeEvo } from "./evo";

export interface EvoReceiverConfig {
  /** Account selected by trusted operator config, never by webhook payload.instance. */
  account: string;
  /** Configure through private service/vault configuration, never print or return it. */
  webhookSecret: string;
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const reply = (status: number, body: Record<string, unknown>) => Response.json(body,{status});

/** Host must expose only the intended authenticated route and bound account. */
export function evoReceiver(inbox: ChannelInbox, config: EvoReceiverConfig) {
  if (!config.account || Buffer.byteLength(config.account) > 256 || /[\x00-\x1f]/.test(config.account)
    || Buffer.byteLength(config.webhookSecret) < 32 || Buffer.byteLength(config.webhookSecret) > 256) throw new Error("invalid private Evo receiver configuration");
  const secretHash = digest(config.webhookSecret);
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return reply(405,{error:"method_not_allowed"});
    const offered = request.headers.get("x-webhook-secret") ?? "";
    if (Buffer.byteLength(offered) > 256 || !timingSafeEqual(digest(offered),secretHash)) return reply(401,{error:"unauthorized"});
    if ((request.headers.get("content-type") ?? "").split(";",1)[0].trim().toLowerCase() !== "application/json") return reply(415,{error:"json_required"});
    const declared = request.headers.get("content-length");
    if (declared && (!/^\d+$/.test(declared) || Number(declared) > 256_000)) return reply(413,{error:"payload_too_large"});
    const reader = request.body?.getReader();
    if (!reader) return reply(400,{error:"invalid_delivery"});
    const chunks: Uint8Array[] = []; let bytes = 0;
    let timedOut = false;
    const timer = setTimeout(() => { timedOut = true; void reader.cancel().catch(() => {}); },10_000);
    try {
      for (;;) {
        const part = await reader.read(); if (part.done) break;
        bytes += part.value.byteLength;
        if (bytes > 256_000) { await reader.cancel(); return reply(413,{error:"payload_too_large"}); }
        chunks.push(part.value);
      }
      if (timedOut) return reply(408,{error:"delivery_timeout"});
      const payload: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const messages = normalizeEvo(payload,config.account);
      // Dedupe is durable per message. A rejected batch may have an accepted prefix;
      // retries use the same IDs and never acknowledge the entire failed batch.
      const accepted = messages.map(message => inbox.accept(message));
      return reply(200,{accepted:accepted.length,duplicates:accepted.filter(row => row.duplicate).length});
    } catch {
      // No sender/session/project, secret, original body or DB errors leak outward.
      return reply(422,{error:"delivery_not_accepted"});
    } finally { clearTimeout(timer); reader.releaseLock(); }
  };
}
