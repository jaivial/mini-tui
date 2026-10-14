/** Prepared receiver only. No server, instance mutation, bindings, task launch or sends. */
import { createHash, timingSafeEqual } from "node:crypto";
import { ChannelInbox } from "./inbox";
import { normalizeEvo } from "./evo";
import type { EvoReceiverAccount } from "./accounts";

export interface EvoReceiverConfig {
  /** Single-account form (WA-1). Absent when `accounts` is given. */
  account?: string;
  /** Configure through private service/vault configuration, never print or return it. */
  webhookSecret?: string;
  /** Multi-account form (WA-5): one entry per trusted account. The offered
   * x-webhook-secret selects the account — timing-safe, never the body. */
  accounts?: EvoReceiverAccount[];
}
const digest = (value: string) => createHash("sha256").update(value).digest();
const reply = (status: number, body: Record<string, unknown>) => Response.json(body,{status});

/** Host must expose only the intended authenticated routes and bound accounts. */
export function evoReceiver(inbox: ChannelInbox, config: EvoReceiverConfig) {
  const accounts: EvoReceiverAccount[] = config.accounts ?? [
    { account: config.account ?? "", webhookSecret: config.webhookSecret ?? "" },
  ];
  if (!accounts.length) throw new Error("invalid private Evo receiver configuration: no accounts");
  for (const entry of accounts) {
    if (!entry.account || Buffer.byteLength(entry.account) > 256 || /[\x00-\x1f]/.test(entry.account)
      || Buffer.byteLength(entry.webhookSecret) < 32 || Buffer.byteLength(entry.webhookSecret) > 256) throw new Error("invalid private Evo receiver configuration");
  }
  // A rejected secret is compared against every hash in constant total time;
  // the reply never says which (or whether any) account matched.
  const secrets = accounts.map(entry => ({ account: entry.account, hash: digest(entry.webhookSecret) }));
  return async (request: Request): Promise<Response> => {
    if (request.method !== "POST") return reply(405,{error:"method_not_allowed"});
    const offered = request.headers.get("x-webhook-secret") ?? "";
    if (Buffer.byteLength(offered) > 256) return reply(401,{error:"unauthorized"});
    const offeredHash = digest(offered);
    let account: string | null = null;
    for (const entry of secrets) if (timingSafeEqual(offeredHash,entry.hash)) { account = entry.account; break; }
    if (!account) return reply(401,{error:"unauthorized"});
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
      const messages = normalizeEvo(payload,account);
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
