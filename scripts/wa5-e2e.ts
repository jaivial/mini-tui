/**
 * WA-5 multichat E2E QA (run: `bun run scripts/wa5-e2e.ts`).
 *
 * Honest scope: everything that runs ON THIS MACHINE. A fake evo-weai server
 * stands in for the real instances; the REAL receiver, REAL inbox store, REAL
 * consumer loop and REAL bindings CLI run against it. No model is called: a
 * deliberately unconfigured turn env makes runTurn end in its honest failure
 * note, which is still a full reply path (ledger → send → ack) we can assert
 * on. Live WhatsApp delivery (real phone, real group mention) is the operator
 * QA step and needs Jaime's phone — not covered here.
 *
 * Asserted:
 *   1. secret→account fan-in: two accounts, each delivery lands in its own
 *      binding namespace; a wrong secret is 401 (for BOTH accounts).
 *   2. group mention gate at the accept boundary: no mention → `ignored`,
 *      nothing in the inbox; mention of the account jid → accepted.
 *   3. allowlist + dedupe still hold (unapproved sender rejected, same id+content duplicate).
 *   4. consumer identity hygiene: the reply for account A goes out through A's
 *      fake sender only, never B's; the gated group message is acked with no
 *      model turn and no send.
 *   5. bindings CLI add/remove is visible to routing immediately (bind →
 *      accepted; unbind → rejected), on a throwaway store.
 *   6. group bridge: [[mini-newgroup: …]] creates the group on the OWNING
 *      account's instance, sets the photo, binds a fresh session with a
 *      mention policy and an allowlist of exactly the requester, and confirms
 *      in-thread through the same account's sender.
 *   7. v4-H fromMe semantics: a fromMe=true GROUP delivery from an allowed
 *      sender is ACCEPTED (one shared number), a fromMe=true DM mirror is
 *      still dropped, and a delivered id that is a ledgered reply id (or is
 *      in the thread's outgoing history) is refused as input (no self-turns).
 *   8. v4-H /newsession command: the operator's allowlisted `/newsession`
 *      creates group + avatar + fresh binding with NO model turn and confirms
 *      in-thread; a non-allowlisted sender is refused at accept (422).
 */

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { ChannelInbox } from "../src/channels/inbox";
import { evoReceiver } from "../src/channels/evoReceiver";
import { startChannelConsumer, planImageMarkers, cuPoolDir } from "../src/channels/consumer";
import { SendLedger, type EvoSender } from "../src/channels/evoSend";
import { planGroupCreation, type GroupBridgeOptions } from "../src/channels/groupBridge";
import { planSessionCommand } from "../src/channels/sessionCommand";
import { isTurnFailureNote } from "../src/turnFailure";

const fail: string[] = [];
const ok = (name: string, condition: boolean, detail = "") => {
  console.log(`${condition ? "PASS" : "FAIL"}  ${name}${detail && !condition ? ` — ${detail}` : ""}`);
  if (!condition) fail.push(name);
};

const SECRET_A = "a".repeat(40);
const SECRET_B = "b".repeat(40);
const OWN_A = "34000000001@s.whatsapp.net";
const JAIME = "34692747052@s.whatsapp.net";
const GROUP = "120363999999999@g.us";

const work = mkdtempSync(join(tmpdir(), "wa5-e2e-"));
const dbPath = join(work, "channels.sqlite");
const inbox = new ChannelInbox(dbPath);

// The account's own jid must be allowlisted for group deliveries to be accepted.
inbox.bind({ channel: "whatsapp", account: "bot-a", thread: JAIME, session: "wa-a-dm", project: "wa-assistant", allowedSenders: [JAIME], policy: "", model: "" });
inbox.bind({ channel: "whatsapp", account: "bot-a", thread: GROUP, session: "wa-a-group", project: "wa-assistant", allowedSenders: [JAIME], policy: "mentions", model: "" });

// ---- fake evo-weai: records every send, answers the group API --------------
const sent: Array<{ account: string; number: string; text: string }> = [];
let createdGroups = 0;
let picturesSet = 0;
const createdParticipants: string[][] = [];
const fakeServer = Bun.serve({
  hostname: "127.0.0.1",
  port: 0,
  fetch: async (request) => {
    const url = new URL(request.url);
    const account = url.pathname.includes("/bot-a-instance") ? "bot-a" : url.pathname.includes("/bot-b-instance") ? "bot-b" : null;
    if (url.pathname.startsWith("/message/sendText/")) {
      const body = (await request.json()) as { number: string; text: string };
      sent.push({ account: account ?? "?", number: body.number, text: body.text });
      return Response.json({ key: { id: `fake-${sent.length}` } }, { status: 201 });
    }
    if (url.pathname.startsWith("/group/create/")) {
      createdGroups++;
      const body = (await request.json()) as { participants?: string[] };
      createdParticipants.push(body.participants ?? []);
      return Response.json({ data: { groupJid: `1203637777777${createdGroups}@g.us` } }, { status: 200 });
    }
    if (url.pathname.startsWith("/group/updateGroupPicture/")) {
      // Behave like the DEPLOYED fork: multipart is refused with a
      // content-type rejection; only the JSON {image: base64} shape works.
      const contentType = (request.headers.get("content-type") ?? "").split(";", 1)[0]!.trim();
      if (contentType === "multipart/form-data") {
        await request.formData().catch(() => {});
        return Response.json({ error: "Bad Request", message: "Expected request with `Content-Type: application/json`", status: 400 }, { status: 400 });
      }
      await request.json();
      picturesSet++;
      return Response.json({ ok: true }, { status: 200 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  },
});
const base = `http://127.0.0.1:${fakeServer.port}`;
const senderOf = (account: string, instance: string): EvoSender => ({
  async sendText(args) {
    sent.push({ account, number: args.number, text: args.text, quoted: args.quoted?.id ?? null } as any);
    return { kind: "sent", replyId: `ledger-${sent.length}` };
  },
  async recentOutgoing() { return []; },
  async sendImage(args) {
    imagesSent.push({ account, number: args.number, bytes: Buffer.byteLength(args.mediaBase64, "base64") });
    return { kind: "sent", replyId: `img-${imagesSent.length}` };
  },
});
const imagesSent: Array<{ account: string; number: string; bytes: number }> = [];

// ---- real receiver with two accounts ---------------------------------------
// The mention gate lives in the consumer (WA-5): the receiver accepts any
// authentic delivery; the consumer drops non-mention group rows policy-gated.
const receiver = evoReceiver(inbox, {
  accounts: [
    { account: "bot-a", webhookSecret: SECRET_A },
    { account: "bot-b", webhookSecret: SECRET_B },
  ],
});
const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: receiver });
const post = async (secret: string, payload: unknown) => {
  const response = await fetch(`${base2()}/`, { method: "POST", headers: { "x-webhook-secret": secret, "content-type": "application/json" }, body: JSON.stringify(payload) });
  if (response.status !== 200) console.error(`[post ${response.status}]`, await response.clone().text());
  return response;
};
const base2 = () => `http://127.0.0.1:${server.port}`;
const evoMessage = (overrides: Record<string, unknown> = {}) => {
  const key = { id: `msg-${Math.random().toString(36).slice(2, 10)}`, remoteJid: JAIME, fromMe: false, participant: undefined, ...((overrides.key as object) ?? {}) };
  const message = { conversation: "hola", ...((overrides.message as object) ?? {}) };
  return { event: "messages.upsert", date_time: new Date().toISOString().replace(/\.\d{3}Z$/, ".000Z"), data: [{ key, message, messageTimestamp: Math.floor(Date.now() / 1000) }], ...((overrides.envelopeExtra as object) ?? {}) };
};

// 1. fan-in + wrong secret
{
  const rA = await post(SECRET_A, evoMessage({ key: { id: "fan-in-a" } }));
  ok("delivery with A's secret accepted", rA.status === 200 && (await rA.json()).accepted === 1);
  const rBad = await post("x".repeat(40), evoMessage({ key: { id: "never" } }));
  ok("wrong secret rejected (401)", rBad.status === 401);
  const row = inbox.read(0, 10).find((r) => (r as any).message_id === "fan-in-a") as any;
  ok("delivery landed in A's namespace", row?.account === "bot-a" && row?.session === "wa-a-dm");
}

// 2 + 3. accept-time behavior: group rows, allowlist, dedupe
{
  const noMention = await post(SECRET_A, evoMessage({ key: { id: "grp-1", remoteJid: GROUP, participant: JAIME }, message: { conversation: "buenos días a todos" } }));
  const noMentionBody = await noMention.json();
  ok("authentic group delivery accepted at the receiver", noMention.status === 200 && noMentionBody.accepted === 1);
  const mention = await post(SECRET_A, evoMessage({ key: { id: "grp-2", remoteJid: GROUP, participant: JAIME }, message: { extendedTextMessage: { text: `@34000000001 hola bot`, contextInfo: { mentionedJid: [OWN_A], mentionedJidArray: [OWN_A] } } } }));
  ok("group message with mention accepted", (await mention.json()).accepted === 1);
  // allowlist: bound route but sender not in the list
  inbox.bind({ channel: "whatsapp", account: "bot-a", thread: "999@s.whatsapp.net", session: "wa-a-x", project: "wa-assistant", allowedSenders: [OWN_A], policy: "", model: "" });
  const stranger2 = await post(SECRET_A, evoMessage({ key: { id: "str-2", remoteJid: "999@s.whatsapp.net" } }));
  ok("unapproved sender rejected (422)", stranger2.status === 422);
  const dup = await post(SECRET_A, evoMessage({ key: { id: "fan-in-a" } }));
  ok("duplicate id+content is a duplicate", (await dup.json()).duplicates === 1);
}

// ---- consumer: identity hygiene + group gate, no model call -----------------
{
  // The turn env is unconfigured (unknown provider) so every runTurn ends in
  // the honest failure note — a full ledger → send → ack path with no model.
  // The consumer syncs at the present, so the deliveries it must process are
  // posted while it is already running.
  const consumerA = startChannelConsumer({
    inbox,
    sender: senderOf("bot-a", "bot-a-instance"),
    ledger: new SendLedger(inbox.db),
    consumer: "qa-a",
    sessionsDbPath: join(work, "sessions.sqlite"),
    cwd: join(work, "cwd-a"),
    model: "qa-missing-provider/no-model",
    accountJids: new Map([["bot-a", OWN_A], ["bot-b", undefined]]),
    idleMs: 50,
    turnTimeoutS: 5,
    log: (event, fields) => console.error("[consumer]", event, JSON.stringify(fields ?? {})),
  });
  await new Promise((r) => setTimeout(r, 300));
  await post(SECRET_A, evoMessage({ key: { id: "cons-dm" } }));
  await post(SECRET_A, evoMessage({ key: { id: "cons-grp1", remoteJid: GROUP, participant: JAIME }, message: { conversation: "buenos días a todos (sin mencionar)" } }));
  await post(SECRET_A, evoMessage({ key: { id: "cons-grp2", remoteJid: GROUP, participant: JAIME }, message: { extendedTextMessage: { text: `@34000000001 hola bot`, contextInfo: { mentionedJid: [OWN_A], mentionedJidArray: [OWN_A] } } } }));
  await new Promise((r) => setTimeout(r, 9_000));
  consumerA.stop();
  await consumerA.done.catch(() => {});
  const dmReply = sent.find((s) => s.account === "bot-a" && s.number === JAIME);
  ok("DM reply went out through the OWNING account's sender", !!dmReply && isTurnFailureNote(dmReply.text), JSON.stringify(sent));
  const groupSends = sent.filter((s) => s.number === GROUP);
  ok("group message WITHOUT mention never sent", groupSends.length === 1, JSON.stringify(sent));
  ok("group message WITH mention answered in-group via its own identity", groupSends.length === 1 && groupSends[0]!.account === "bot-a");
  ok("no reply ever went out via another identity", !sent.some((s) => s.account === "bot-b"));
}

// ---- bindings CLI: add/remove reflected immediately -------------------------
{
  const { execSync } = await import("node:child_process");
  const cli = (args: string) => execSync(`/home/jaime/.bun/bin/bun run src/channels/bindingsCli.ts ${args}`, {
    env: { ...process.env, EVO_INBOX_DB: dbPath },
    encoding: "utf8",
    cwd: join(import.meta.dir, ".."),
  });
  const newThread = "777@s.whatsapp.net";
  let rejected = false;
  try {
    await post(SECRET_A, evoMessage({ key: { id: "cli-1", remoteJid: newThread, participant: undefined } }));
  } catch { rejected = true; }
  const r1 = await post(SECRET_A, evoMessage({ key: { id: "cli-1", remoteJid: newThread, participant: undefined } }));
  ok("unbound route rejected before CLI bind", r1.status === 422);
  cli(`bind --account bot-a --thread ${newThread} --allow ${newThread} --session wa-a-cli --policy mentions --model ""`);
  const r2 = await post(SECRET_A, evoMessage({ key: { id: "cli-2", remoteJid: newThread, participant: undefined } }));
  ok("CLI bind → route accepted immediately", r2.status === 200 && (await r2.json()).accepted === 1);
  const stored = inbox.bindingFor("whatsapp", "bot-a", newThread);
  ok("CLI bind durable with policy+model fields", stored?.session === "wa-a-cli" && stored?.policy === "mentions");
  cli(`unbind --account bot-a --thread ${newThread}`);
  const r3 = await post(SECRET_A, evoMessage({ key: { id: "cli-3", remoteJid: newThread, participant: undefined } }));
  ok("CLI unbind → route rejected immediately", r3.status === 422);
}

// ---- group bridge: directive → create + photo + bind + confirm --------------
{
  const pendingRow = { seq: 1, channel: "whatsapp", account: "bot-a", thread: JAIME, message_id: "m", sent_at: 0, payload: "{}", session: "wa-a-dm", project: "wa-assistant" };
  const message = { channel: "whatsapp" as const, account: "bot-a", thread: JAIME, messageId: "m", sender: JAIME, sentAt: 0, text: "Quiero una sesión nueva", attachments: [] };
  const options: GroupBridgeOptions = {
    inbox,
    accountFor: (account) => (account === "bot-a" ? { instance: "bot-a-instance", token: "t" } : undefined),
    baseUrl: base,
    photoPath: join(import.meta.dir, "../src/channels/assets/group-mascot.jpg"),
    newSessionId: () => "wa-a-fresh",
    senderFor: (account) => (account === "bot-a" ? senderOf("bot-a", "bot-a-instance") : undefined),
    log: (event, fields) => console.error("[groupbridge]", event, JSON.stringify(fields ?? {})),
  };
  const planned = planGroupCreation(options, pendingRow as any, message as any, "Claro, abro un hilo nuevo.\n[[mini-newgroup: Proyecto Cacahuete]]");
  ok("directive stripped from the chat reply", !planned.text.includes("mini-newgroup") && planned.text.includes("Claro"));
  await planned.after?.();
  const bound = inbox.bindingFor("whatsapp", "bot-a", "12036377777771@g.us");
  ok("group created on the owning instance + photo set", createdGroups === 1 && picturesSet === 1);
  ok("fresh session bound with mention policy + requester allowlist", bound?.session === "wa-a-fresh" && bound?.policy === "mentions" && JSON.stringify(bound?.allowedSenders) === JSON.stringify([JAIME]));
  ok("confirmation sent in the requesting thread via the same identity", sent.some((s) => s.account === "bot-a" && s.number === JAIME && s.text.startsWith(`Grupo "Proyecto Cacahuete"`)));
}

// ---- v4-H: fromMe group semantics + own-send echo guards --------------------
{
  // The operator's real group sends arrive fromMe=true (one shared number):
  // they must be ACCEPTED, never dropped by the direction bit.
  const fromMeGroup = await post(SECRET_A, evoMessage({ key: { id: "fm-grp-1", remoteJid: GROUP, fromMe: true, participant: JAIME }, message: { extendedTextMessage: { text: `@34000000001 prueba fromMe`, contextInfo: { mentionedJid: [OWN_A], mentionedJidArray: [OWN_A] } } } }));
  const fmBody = await fromMeGroup.json();
  ok("fromMe=true GROUP delivery from an allowed sender is ACCEPTED", fromMeGroup.status === 200 && fmBody.accepted === 1, JSON.stringify(fmBody));
  // Outside groups the bit still means "our own device": mirrors are dropped.
  const fromMeDm = await post(SECRET_A, evoMessage({ key: { id: "fm-dm-1", fromMe: true } }));
  const dmBody = await fromMeDm.json();
  ok("fromMe=true DM mirror still dropped (no recursive bot work)", fromMeDm.status === 200 && dmBody.accepted === 0 && dmBody.duplicates === 0, JSON.stringify(dmBody));
  // The bot's own ledgered replies echo back with fromMe=true too: a delivered
  // id that IS a recorded reply id is refused at the accept boundary.
  const ledger = new SendLedger(inbox.db);
  ledger.begin(9001, "respuesta propia", null);
  ledger.markSent(9001, "echo-own-1");
  const echo = await post(SECRET_A, evoMessage({ key: { id: "echo-own-1", remoteJid: GROUP, fromMe: true, participant: JAIME }, message: { conversation: "respuesta propia" } }));
  const echoBody = await echo.json();
  ok("own ledgered reply id echoed back is NOT accepted as input", echo.status === 200 && echoBody.accepted === 0 && echoBody.duplicates === 0, JSON.stringify(echoBody));
}

// ---- v4-H: consumer-side own-send guard (non-ledgered sends) ----------------
{
  // A bridge confirmation is sent outside the ledger; its echo is refused by
  // correlation with the thread's recent OUTGOING history instead.
const senderWithHistory: EvoSender = {
    ...senderOf("bot-a", "bot-a-instance"),
    async recentOutgoing(thread) {
      return thread === GROUP ? [{ id: "own-unledgered-1", text: 'Grupo "X" creado…', quotedStanzaId: null, ts: Math.floor(Date.now() / 1000) }] : [];
    },
  };
  const consumerOwn = startChannelConsumer({
    inbox,
    sender: senderWithHistory,
    ledger: new SendLedger(inbox.db),
    consumer: "qa-own",
    sessionsDbPath: join(work, "sessions.sqlite"),
    cwd: join(work, "cwd-a"),
    model: "qa-missing-provider/no-model",
    accountJids: new Map([["bot-a", OWN_A]]),
    idleMs: 50,
    turnTimeoutS: 5,
    log: (event, fields) => console.error("[consumer-own]", event, JSON.stringify(fields ?? {})),
  });
  await new Promise((r) => setTimeout(r, 300));
  await post(SECRET_A, evoMessage({ key: { id: "own-unledgered-1", remoteJid: GROUP, fromMe: true, participant: JAIME }, message: { conversation: 'Grupo "X" creado…' } }));
  await new Promise((r) => setTimeout(r, 1_500));
  consumerOwn.stop();
  await consumerOwn.done.catch(() => {});
  ok("own unledgered send echoed back is acked with NO turn and NO reply", !sent.some((s) => s.number === GROUP && s.text.includes('Grupo "X" creado…') && s.text.startsWith("(mini")), JSON.stringify(sent.slice(-3)));
}

// ---- v4-H: the operator's /newsession chat command --------------------------
{
  let freshSessions = 0;
  const lidForms = new Map([["bot-a", "34000000001@s.whatsapp.net,242554100576489@lid"]]);
  // The trusted account jid forms (EVO_ACCOUNTS shape): the LID↔phone pair
  // the participant resolver maps through.
  const lidResolver = (jid: string): string => {
    if (!jid.endsWith("@lid")) return jid;
    const bare = jid.replace(/:.*/, "").toLowerCase();
    const forms = (lidForms.get("bot-a") ?? "").split(",").map((f) => f.trim()).filter(Boolean);
    if (forms.some((f) => f.replace(/:.*/, "").toLowerCase() === bare)) return forms.find((f) => f.endsWith("@s.whatsapp.net")) ?? jid;
    return jid;
  };
  const options: GroupBridgeOptions = {
    inbox,
    accountFor: (account) => (account === "bot-a" ? { instance: "bot-a-instance", token: "t" } : undefined),
    baseUrl: base,
    photoPath: join(import.meta.dir, "../src/channels/assets/group-mascot.jpg"),
    newSessionId: () => `wa-a-cmd-${++freshSessions}`,
    senderFor: (account) => (account === "bot-a" ? senderOf("bot-a", "bot-a-instance") : undefined),
    resolveParticipant: lidResolver,
    log: (event, fields) => console.error("[sessioncmd]", event, JSON.stringify(fields ?? {})),
  };
  const consumerCmd = startChannelConsumer({
    inbox,
    sender: senderOf("bot-a", "bot-a-instance"),
    ledger: new SendLedger(inbox.db),
    consumer: "qa-cmd",
    sessionsDbPath: join(work, "sessions.sqlite"),
    cwd: join(work, "cwd-a"),
    model: "qa-missing-provider/no-model",
    accountJids: new Map([["bot-a", OWN_A]]),
    idleMs: 50,
    turnTimeoutS: 5,
    planSessionCommand: (row, message) => planSessionCommand(options, row, message),
    log: (event, fields) => console.error("[consumer-cmd]", event, JSON.stringify(fields ?? {})),
  });
  await new Promise((r) => setTimeout(r, 300));
  // The operator (allowlisted) types the command in the group — no mention.
  // Live, his group messages arrive with the @lid participant form: accept
  // must pass (allowlist holds both forms) and the group-create call must
  // carry the PHONE jid (WhatsApp refuses @lid participants), while the new
  // binding's allowlist keeps the original LID.
  const JAIME_LID = "242554100576489@lid";
  inbox.allow("whatsapp", "bot-a", GROUP, JAIME_LID, true);
  await post(SECRET_A, evoMessage({ key: { id: "cmd-1", remoteJid: GROUP, participant: JAIME_LID }, message: { conversation: "/newsession Proyecto Nueva Era" } }));
  await new Promise((r) => setTimeout(r, 1_500));
  // A non-allowlisted sender never even reaches the consumer: the accept
  // boundary (same allowlist) refuses the delivery outright (422).
  const strangerPost = await post(SECRET_A, evoMessage({ key: { id: "cmd-2", remoteJid: GROUP, participant: OWN_A }, message: { conversation: "/newsession Grupo Ajeno" } }));
  ok("a NON-allowlisted sender's command is refused at accept (no group, no turn)", strangerPost.status === 422 && createdGroups === 2 && !sent.some((s) => (s as any).quoted === "cmd-2"), `status=${strangerPost.status} created=${createdGroups}`);
  consumerCmd.stop();
  await consumerCmd.done.catch(() => {});
  const bound = inbox.bindingFor("whatsapp", "bot-a", "12036377777772@g.us");
  ok("command created the group + avatar with NO model turn", createdGroups === 2 && picturesSet === 2, `created=${createdGroups} pictures=${picturesSet}`);
  ok("LID requester resolved to the PHONE jid for group-create only", JSON.stringify(createdParticipants[1]) === JSON.stringify([OWN_A]), JSON.stringify(createdParticipants));
  ok("command bound a FRESH session (mention policy, allowlist keeps the LID form)", bound?.session === "wa-a-cmd-1" && bound?.policy === "mentions" && JSON.stringify(bound?.allowedSenders) === JSON.stringify([JAIME_LID]), JSON.stringify(bound));
  ok("command confirmed in the requesting thread, origin binding untouched", sent.some((s) => s.number === GROUP && s.text.startsWith(`Grupo "Proyecto Nueva Era"`)) && inbox.bindingFor("whatsapp", "bot-a", GROUP)?.session === "wa-a-group");
}

// ---- v4-F: [[mini-image: <path>]] markers → validated pool screenshots ------
{
  const { mkdirSync, writeFileSync, rmSync: rm } = await import("node:fs");
  const pool = join(work, "cu-pool");
  mkdirSync(pool, { recursive: true });
  const shot = join(pool, "shot-e2e.png");
  writeFileSync(shot, Buffer.from("89504e470d0a1a0a0000000d49484452", "hex"));
  const good = planImageMarkers(`Aquí tienes:\n[[mini-image: ${shot}]]`, pool);
  ok("a pool screenshot marker is stripped and its path validated", good.text === "Aquí tienes:" && good.images.length === 1 && good.images[0] === shot, JSON.stringify(good));
  const evil = planImageMarkers("[[mini-image: /etc/passwd.png]] [[mini-image: " + join(work, "cwd-a", "secret.png") + "]] [[mini-image: " + shot + "]] [[mini-image: " + shot + "]]", pool);
  ok("markers outside the pool (and duplicates) are refused", evil.images.length === 1, JSON.stringify(evil));
  rm(shot);
  ok("no media went out in the harness flows (markers only validated)", imagesSent.length === 0);
}

inbox.close();
server.stop(true);
fakeServer.stop(true);
rmSync(work, { recursive: true, force: true });
console.log(fail.length ? `\n${fail.length} FAILED` : "\nALL WA-5 E2E CHECKS PASSED");
process.exit(fail.length ? 1 : 0);
