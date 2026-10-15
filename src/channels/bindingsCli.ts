/**
 * `bun run src/channels/bindingsCli.ts <command> …` — the WA-5 operator CLI for
 * channel bindings. Every change here is an explicit operator action: routing
 * is NEVER derived from message content, and the CLI is the only write path
 * besides `ChannelInbox.bind` used by group creation.
 *
 *   EVO_INBOX_DB   the shared channel store (default ~/.local/share/mini-tui/channels.sqlite)
 *
 * Commands (channel is `whatsapp` unless --channel says otherwise):
 *   list [--account A] [--json]
 *   bind --account A --thread T --allow jid[,jid…] [--session S] [--project P]
 *        [--policy default|mentions|all] [--model provider/model] [--channel C]
 *        Missing --session derives the repo convention `wa-<account>-<hex8>`;
 *        re-binding keeps the stored session unless --session is given, so an
 *        accidental re-run never forks the conversation.
 *   unbind --account A --thread T [--channel C]
 *   allow --account A --thread T (--add jid | --remove jid) [--channel C]
 *   model --account A --thread T --model provider/model   (empty string clears)
 *   models — the model ids mini currently has configured (the validation set)
 *   groups --account A — the groups the account's instance is in
 *   refresh-icons --account A — re-upload the emoji avatar of every bound
 *        WhatsApp group (one face per session, the web panel's), so existing
 *        groups pick up the redesign without being recreated
 *   new-group --account A --subject S --participants N1,N2 [--project P]
 *        [--model provider/model] [--policy default|mentions|all]
 *        [--picture JPG] [--sticker WEBP] [--welcome TEXT]
 *        — WA-5 group-per-session: create a WhatsApp group (one group = one
 *        fresh session), dress it with the mascot cover and bind it. The
 *        session row itself is created by the consumer on the first message.
 *
 * The bound model is validated as the mini `provider/model` shape here; the
 * consumer re-resolves it per turn against the configured providers, so an
 * unknown provider fails the turn honestly instead of silently rerouting.
 */

import { homedir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { ChannelInbox, checkModel, type Binding, type Channel } from "./inbox";
import { parseConsumerAccounts } from "./accounts";
import { connectionModelOptions, loadConnections } from "../providers";
import { avatarFileFor } from "./groupAvatar";
import { setGroupPicture } from "./groupPicture";

const CHANNELS: Channel[] = ["whatsapp", "gmail", "apple-messages"];

function usage(code: number): never {
  console.error(`usage: bindingsCli <list|bind|unbind|allow|model|groups|refresh-icons|new-group> [options]
  list    [--account A] [--json]
  bind    --account A --thread T --allow jid[,jid…] [--session S] [--project P]
          [--policy default|mentions|all] [--model provider/model] [--channel C]
  unbind  --account A --thread T [--channel C]
  allow   --account A --thread T (--add jid | --remove jid) [--channel C]
  model   --account A --thread T --model provider/model
  refresh-icons --account A   re-upload every bound group's emoji avatar
env: EVO_INBOX_DB (default ~/.local/share/mini-tui/channels.sqlite)`);
  process.exit(code);
}

const die = (message: string): never => {
  console.error(`bindingsCli: ${message}`);
  process.exit(1);
};

const args = process.argv.slice(2);
const command = args.shift();
if (!command || command === "-h" || command === "--help") usage(command ? 0 : 2);

/** Typed flag parser: repeated flags are an error, values may be empty only
 * where the command allows it (model ""). */
function flags(names: string[]): Record<string, string | undefined> {
  const out: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const flag = args[i];
    if (!flag.startsWith("--")) die(`unexpected argument ${flag}`);
    const name = flag.slice(2);
    if (!names.includes(name)) die(`unknown flag --${name}`);
    if (name in out) die(`repeated flag --${name}`);
    const value = args[i + 1];
    if (value === undefined) die(`flag --${name} needs a value`);
    out[name] = value as string;
    i++;
  }
  return out;
}

const inbox = new ChannelInbox(process.env.EVO_INBOX_DB ?? join(homedir(), ".local/share/mini-tui/channels.sqlite"));
const randomHex8 = (): string => [...crypto.getRandomValues(new Uint8Array(4))].map((b) => b.toString(16).padStart(2, "0")).join("");

/** Jaime's rule: the model of each session is the one the user chose, validated
 * against the models mini actually has configured — an unknown model is
 * refused here, not discovered broken mid-conversation. */
function requireConfiguredModel(model: string): string {
  checkModel(model);
  if (!model) return "";
  const configured = new Set(connectionModelOptions(loadConnections()).map((option) => option.value));
  if (!configured.has(model)) {
    die(`model ${model} is not configured in mini — run the "models" command for the valid set`);
  }
  return model;
}

/** Minimal evo-weai client for the group commands: loopback URL + the
 * account's own instance token, read from the same env the consumer uses.
 * Tokens are sent, never printed. */
function apiFor(account: string): { instance: string; token: string; call: (method: string, path: string, body?: unknown) => Promise<any> } {
  const base = (process.env.EVO_API_URL ?? "").replace(/\/+$/, "");
  if (!base) die("EVO_API_URL is required for group commands");
  const entry = parseConsumerAccounts().find((a) => a.account === account);
  if (!entry) throw new Error(`account ${account} is not configured (EVO_ACCOUNTS or the single-account envs)`);
  const instance: string = entry.instance;
  const token: string = entry.token;
  const call = async (method: string, path: string, body?: unknown): Promise<any> => {
    const response = await fetch(`${base}${path}`, {
      method,
      headers: { "Content-Type": "application/json", apikey: token },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    const json = await response.json().catch(() => null);
    if (response.status >= 300) throw new Error(`${method} ${path} → ${response.status}: ${JSON.stringify(json).slice(0, 300)}`);
    return json;
  };
  return { instance: entry.instance, token: entry.token, call };
}

try {
  if (command === "list") {
    const f = flags(["account", "json"]);
    const bindings = inbox.listBindings(f.account);
    if (f.json) {
      console.log(JSON.stringify(bindings, null, 2));
    } else {
      for (const b of bindings) {
        const policy = b.policy || "default";
        const model = b.model || "(consumer default)";
        console.log(`${b.channel}\t${b.account}\t${b.thread}\t${b.session}\t${b.project}\tpolicy=${policy}\tmodel=${model}\tallow=${b.allowedSenders.join(",")}`);
      }
      console.error(`${bindings.length} binding(s)`);
    }
  } else if (command === "bind") {
    const f = flags(["account", "thread", "allow", "session", "project", "policy", "model", "channel"]);
    if (!f.account || !f.thread || !f.allow) usage(2);
    const channel = (f.channel ?? "whatsapp") as Channel;
    if (!CHANNELS.includes(channel)) die(`unknown channel ${channel}`);
    const policy = f.policy === undefined || f.policy === "default" ? "" : f.policy;
    if (!["", "mentions", "all"].includes(policy)) die(`invalid policy ${f.policy}`);
    const model = requireConfiguredModel(f.model ?? "");
    const existing = inbox.bindingFor(channel, f.account, f.thread);
    const binding: Binding = {
      channel,
      account: f.account,
      thread: f.thread,
      session: f.session ?? existing?.session ?? `wa-${f.account}-${randomHex8()}`,
      project: f.project ?? existing?.project ?? "wa-assistant",
      allowedSenders: f.allow.split(",").map((s) => s.trim()).filter(Boolean),
      policy: policy as Binding["policy"],
      model,
    };
    inbox.bind(binding);
    console.log(`bound ${channel}/${f.account}/${f.thread} → session ${binding.session} (project ${binding.project}, policy ${policy || "default"}, model ${binding.model || "default"}, allow ${binding.allowedSenders.join(",")})`);
  } else if (command === "unbind") {
    const f = flags(["account", "thread", "channel"]);
    if (!f.account || !f.thread) usage(2);
    const channel = (f.channel ?? "whatsapp") as Channel;
    if (!inbox.unbind(channel, f.account, f.thread)) die(`no binding for ${channel}/${f.account}/${f.thread}`);
    console.log(`unbound ${channel}/${f.account}/${f.thread} (messages from that thread are rejected from now on; the session and its history remain)`);
  } else if (command === "allow") {
    const f = flags(["account", "thread", "add", "remove", "channel"]);
    if (!f.account || !f.thread || (!!f.add === !!f.remove)) usage(2);
    const sender = (f.add ?? f.remove ?? "").trim();
    if (!sender) usage(2);
    const channel = (f.channel ?? "whatsapp") as Channel;
    inbox.allow(channel, f.account, f.thread, sender, !!f.add);
    console.log(`${f.add ? "added" : "removed"} ${sender} ${f.add ? "to" : "from"} ${channel}/${f.account}/${f.thread}`);
  } else if (command === "model") {
    const f = flags(["account", "thread", "model", "channel"]);
    if (!f.account || !f.thread || f.model === undefined) usage(2);
    const channel = (f.channel ?? "whatsapp") as Channel;
    const model = requireConfiguredModel(f.model);
    const existing = inbox.bindingFor(channel, f.account, f.thread);
    if (!existing) throw new Error(`no binding for ${channel}/${f.account}/${f.thread}`);
    inbox.bind({ ...existing, model });
    console.log(`model for ${channel}/${f.account}/${f.thread} → ${model || "(consumer default)"}`);
  } else if (command === "models") {
    flags([]);
    for (const model of [...new Set(connectionModelOptions(loadConnections()).map((option) => option.value))].sort()) console.log(model);
  } else if (command === "groups") {
    const f = flags(["account"]);
    if (!f.account) usage(2);
    const { instance, call } = apiFor(f.account);
    const groups = await call("GET", `/group/fetchAllGroups/${encodeURIComponent(instance)}?getParticipants=false`);
    for (const group of Array.isArray(groups) ? groups : []) console.log(`${group.id ?? group.jid ?? "?"}\t${group.subject ?? ""}`);
  } else if (command === "refresh-icons") {
    // The redesign carried to the groups that already exist: every bound
    // WhatsApp group re-dresses in its session's emoji avatar (the same face
    // the web sidebar shows). One account per run: the instance is per-account.
    const f = flags(["account"]);
    if (!f.account) usage(2);
    const { instance, token } = apiFor(f.account);
    const base = (process.env.EVO_API_URL ?? "").replace(/\/+$/, "");
    const groups = inbox.listBindings(f.account).filter((b) => b.channel === "whatsapp" && b.thread.endsWith("@g.us"));
    if (!groups.length) console.log(`no WhatsApp group bindings for ${f.account}`);
    let done = 0;
    for (const binding of groups) {
      const avatar = avatarFileFor(binding.session);
      if (!avatar) {
        console.log(`skip ${binding.thread} (${binding.session}): no avatar asset`);
        continue;
      }
      try {
        const photo = await setGroupPicture(base, instance, token, binding.thread, avatar);
        if (!photo.ok) throw new Error(`status ${photo.status}: ${photo.error.slice(0, 120)}`);
        console.log(`updated ${binding.thread} (${binding.session})`);
        done++;
      } catch (error) {
        console.error(`failed ${binding.thread} (${binding.session}): ${error instanceof Error ? error.message : String(error)}`);
      }
    }
    console.log(`${done}/${groups.length} group icons updated`);
  } else if (command === "new-group") {
    const f = flags(["account", "subject", "participants", "project", "model", "policy", "picture", "sticker", "welcome", "description"]);
    if (!f.account || !f.subject || !f.participants) usage(2);
    const participants = f.participants.split(",").map((s) => s.trim()).filter(Boolean);
    if (!participants.length) die("--participants needs at least one number or jid");
    const model = requireConfiguredModel(f.model ?? "");
    const policy = f.policy === undefined || f.policy === "default" ? "" : f.policy;
    if (!["", "mentions", "all"].includes(policy)) die(`invalid policy ${f.policy}`);
    const { instance, call, token } = apiFor(f.account);
    const created = await call("POST", `/group/create/${encodeURIComponent(instance)}`, {
      subject: f.subject,
      participants,
      ...(f.description ? { description: f.description } : {}),
    });
    let jid: string | undefined = created?.id ?? created?.jid ?? created?.groupJid ?? created?.wid ?? (Array.isArray(created) ? created[0]?.id : undefined);
    if (!jid || !String(jid).endsWith("@g.us")) {
      // Honest fallback: find the fresh group by its (just-set) unique subject.
      const groups = await call("GET", `/group/fetchAllGroups/${encodeURIComponent(instance)}?getParticipants=false`);
      jid = (Array.isArray(groups) ? groups : []).filter((g: any) => g.subject === f.subject).map((g: any) => g.id ?? g.jid).pop();
    }
    if (!jid || !String(jid).endsWith("@g.us")) die(`group created but its jid was not found: ${JSON.stringify(created).slice(0, 300)}`);
    const groupJid = jid as string; // die() above exits when absent
    const session = `wa-${f.account}-${randomHex8()}`;
    const project = f.project ?? "wa-assistant";
    // The cover: the session's blob-emoji avatar — the same face the web
    // panel shows (WhatsApp group photos are a static square image). The
    // bizbots mascot frame is the fallback; --picture overrides both.
    const picture = f.picture ?? avatarFileFor(session) ?? join(import.meta.dir, "assets", "group-mascot.jpg");
    const photo = await setGroupPicture(process.env.EVO_API_URL ?? "", instance, token, groupJid, picture)
      .catch((error: unknown) => ({ ok: false, status: 0, error: error instanceof Error ? error.message : String(error) }));
    if (!photo.ok) console.error(`(group photo failed — the group is still ready: ${photo.error})`);
    // The group's first participant is Jaime (the operator) — the allowlist
    // starts with exactly him; more via the allow command, never from traffic.
    inbox.bind({ channel: "whatsapp", account: f.account as string, thread: groupJid, session, project, allowedSenders: [participants[0]!], policy: policy as Binding["policy"], model });
    if (f.sticker) {
      const sticker = readFileSync(f.sticker).toString("base64");
      await call("POST", `/message/sendMedia/${encodeURIComponent(instance)}`, { number: groupJid, mediatype: "sticker", media: sticker, mimetype: "image/webp" })
        .catch((error: unknown) => console.error(`(sticker send failed — the group is still ready: ${error instanceof Error ? error.message : String(error)})`));
    }
    if (f.welcome) await call("POST", `/message/sendText/${encodeURIComponent(instance)}`, { number: groupJid, text: f.welcome });
    console.log(`group ${f.subject} created: ${groupJid}\nsession ${session} (project ${project}${model ? `, model ${model}` : ""}, policy ${policy || "default"})\nmembers: ${participants.join(", ")} — mention the bot in the group to talk to this session.`);
  } else {
    usage(2);
  }
} catch (error) {
  die(error instanceof Error ? error.message : String(error));
} finally {
  inbox.close();
}
