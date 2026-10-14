/**
 * Trusted per-account configuration (WA-5 multichat). One identity per evo-weai
 * instance/number: the receiver fans in N accounts by matching each delivery's
 * x-webhook-secret against a per-account secret, and the consumer sends each
 * reply with the tokens of the account that owns the binding — never with one
 * guessed from a webhook body.
 *
 * Configuration comes only from the service environment (0600 env files or
 * JSON env values the operator controls). Secrets and tokens are returned but
 * never logged by callers.
 */

export interface EvoReceiverAccount {
  /** The binding namespace this account owns (channel_bindings.account). */
  account: string;
  /** This account's webhook secret (32..256 bytes, exactly as configured in weai). */
  webhookSecret: string;
}

export interface EvoConsumerAccount {
  account: string;
  /** weai instance name that IS this bot identity. */
  instance: string;
  /** Instance apikey; read but never logged. */
  token: string;
  /** The account's own WhatsApp jid (or bare number) — the mention-gate needle
   * for group policy. Absent = the account cannot be mention-matched (its bound
   * groups should use policy "all" or stay unbound). */
  jid?: string;
}

const ACCOUNT_RE = /^[A-Za-z0-9][A-Za-z0-9_.-]{0,63}$/;

const checkAccount = (account: string): string => {
  if (!ACCOUNT_RE.test(account)) throw new Error("invalid account name");
  return account;
};

const checkSecret = (secret: string): string => {
  const bytes = Buffer.byteLength(secret);
  if (bytes < 32 || bytes > 256) throw new Error("invalid webhook secret (32..256 bytes required)");
  return secret;
};

/** Parse JSON array form: `[{"account":"a","webhookSecret":"…"},…]`. */
function parseReceiverJson(raw: string): EvoReceiverAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("EVO_RECEIVER_ACCOUNTS is not valid JSON");
  }
  if (!Array.isArray(data) || data.length < 1 || data.length > 64) throw new Error("EVO_RECEIVER_ACCOUNTS must be a 1..64 array");
  const seen = new Set<string>();
  return data.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid receiver account entry");
    const account = checkAccount(String((item as Record<string, unknown>).account ?? ""));
    const webhookSecret = checkSecret(String((item as Record<string, unknown>).webhookSecret ?? ""));
    if (seen.has(account)) throw new Error(`duplicate receiver account ${account}`);
    seen.add(account);
    return { account, webhookSecret };
  });
}

/** Receiver accounts: EVO_RECEIVER_ACCOUNTS JSON, or the WA-1 single-account
 * pair (EVO_RECEIVER_ACCOUNT + EVO_WEBHOOK_SECRET) when the JSON is absent. */
export function parseReceiverAccounts(env: Record<string, string | undefined> = process.env): EvoReceiverAccount[] {
  const json = env.EVO_RECEIVER_ACCOUNTS ?? "";
  if (json) return parseReceiverJson(json);
  const account = env.EVO_RECEIVER_ACCOUNT ?? "";
  const webhookSecret = env.EVO_WEBHOOK_SECRET ?? "";
  if (!account && !webhookSecret) return [];
  return [{ account: checkAccount(account), webhookSecret: checkSecret(webhookSecret) }];
}

/** Parse JSON array form: `[{"account":"a","instance":"i","token":"…","jid":"…"},…]`. */
function parseConsumerJson(raw: string): EvoConsumerAccount[] {
  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch {
    throw new Error("EVO_ACCOUNTS is not valid JSON");
  }
  if (!Array.isArray(data) || data.length < 1 || data.length > 64) throw new Error("EVO_ACCOUNTS must be a 1..64 array");
  const seen = new Set<string>();
  return data.map((item) => {
    if (!item || typeof item !== "object") throw new Error("invalid consumer account entry");
    const record = item as Record<string, unknown>;
    const account = checkAccount(String(record.account ?? ""));
    const instance = String(record.instance ?? "");
    const token = String(record.token ?? "");
    const jid = typeof record.jid === "string" && record.jid ? record.jid : undefined;
    if (!instance || /[\x00-\x1f]/.test(instance) || instance.length > 128) throw new Error(`invalid instance for account ${account}`);
    if (!token || Buffer.byteLength(token) > 512) throw new Error(`invalid token for account ${account}`);
    if (jid && (/[\x00-\x1f]/.test(jid) || jid.length > 256)) throw new Error(`invalid jid for account ${account}`);
    if (seen.has(account)) throw new Error(`duplicate consumer account ${account}`);
    seen.add(account);
    return { account, instance, token, ...(jid ? { jid } : {}) };
  });
}

/** Consumer accounts: EVO_ACCOUNTS JSON, or the single-account env trio
 * (EVO_INSTANCE + EVO_INSTANCE_TOKEN, jid from EVO_ACCOUNT_JID) when absent. */
export function parseConsumerAccounts(env: Record<string, string | undefined> = process.env): EvoConsumerAccount[] {
  const json = env.EVO_ACCOUNTS ?? "";
  if (json) return parseConsumerJson(json);
  const instance = env.EVO_INSTANCE ?? "";
  const token = env.EVO_INSTANCE_TOKEN ?? "";
  if (!instance && !token) return [];
  const account = env.EVO_RECEIVER_ACCOUNT ?? env.EVO_ACCOUNT ?? "";
  const jid = env.EVO_ACCOUNT_JID ?? undefined;
  return [{ account: checkAccount(account || instance), instance, token, ...(jid ? { jid } : {}) }];
}

/** Does a mention list name this account? The configured identity may carry
 * several jid forms (WhatsApp groups mention community LIDs while the operator
 * configures the phone number, e.g. "346…@s.whatsapp.net,2425…@lid"). Matches
 * each form's full jid and its bare number part. */
export function mentionsAccount(mentions: string[] | undefined, jids: string | string[] | undefined): boolean {
  if (!mentions?.length || !jids) return false;
  const forms = (Array.isArray(jids) ? jids : jids.split(",")).map((j) => String(j).trim()).filter(Boolean);
  if (!forms.length) return false;
  return mentions.some((m) => {
    const candidate = String(m).replace(/:.*/, "").toLowerCase();
    const candidateNumber = candidate.split("@")[0];
    return forms.some((form) => {
      const needle = form.replace(/:.*/, "").toLowerCase();
      return needle === candidate || needle.split("@")[0] === candidateNumber;
    });
  });
}
