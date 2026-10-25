/**
 * MCP OAuth end to end against a local fake of what Figma serves: a 401 with
 * `resource_metadata`, RFC 9728 + RFC 8414 metadata, dynamic registration that refuses unknown
 * client names, PKCE-checked code exchange and refresh. The browser is played by a `fetch` that
 * follows the authorization URL to the redirect, which is exactly what completes the login.
 */
import { afterAll, beforeEach, describe, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const dir = mkdtempSync(join(tmpdir(), "minitui-mcp-"));
const file = join(dir, "mcp.json");

const mcp = await import("../src/mcp/index");
const oauth = await import("../src/mcp/oauth");

interface Fake {
  base: string;
  codes: Map<string, { challenge: string; redirect: string; clientId: string }>;
  registered: string[];
  tokens: Set<string>;
  closed: string[];
  refreshed: number;
  stop: () => void;
}

function fakeServer(acceptedNames = ["Claude Code"]): Fake {
  const codes = new Map<string, { challenge: string; redirect: string; clientId: string }>();
  const registered: string[] = [];
  const tokens = new Set<string>();
  const closed: string[] = [];
  const state = { refreshed: 0 };
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${server.port}`;
      if (url.pathname === "/mcp") {
        const auth = req.headers.get("authorization") ?? "";
        if (!tokens.has(auth.replace(/^Bearer /, ""))) {
          return new Response("{}", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource/mcp", scope="mcp:connect"` } });
        }
        if (req.method === "DELETE") {
          closed.push(req.headers.get("mcp-session-id") ?? "");
          return new Response(null, { status: 204 });
        }
        const body = (await req.json()) as { id?: number; method: string };
        if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", capabilities: {}, serverInfo: { name: "fake" } } }, { headers: { "mcp-session-id": "s1" } });
        if (body.method === "tools/list") {
          return new Response(`event: message\ndata: ${JSON.stringify({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "get_code" }, { name: "get_image" }] } })}\n\n`, { headers: { "content-type": "text/event-stream" } });
        }
        return new Response(null, { status: 202 });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${base}/mcp`, authorization_servers: [`${base}/auth`] });
      if (url.pathname === "/.well-known/oauth-authorization-server/auth") {
        return Response.json({ issuer: `${base}/auth`, authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register`, token_endpoint_auth_methods_supported: ["client_secret_post"], code_challenge_methods_supported: ["S256"] });
      }
      if (url.pathname === "/register") {
        const b = (await req.json()) as { client_name: string; redirect_uris: string[] };
        if (!acceptedNames.includes(b.client_name)) return new Response("Forbidden", { status: 403 });
        registered.push(b.redirect_uris[0]!);
        return Response.json({ client_id: `client-${registered.length}`, client_secret: "sekret", token_endpoint_auth_method: "none" });
      }
      if (url.pathname === "/authorize") {
        // The "user" approves at once: redirect with a code bound to the PKCE challenge.
        const code = `code-${codes.size + 1}`;
        codes.set(code, { challenge: url.searchParams.get("code_challenge")!, redirect: url.searchParams.get("redirect_uri")!, clientId: url.searchParams.get("client_id")! });
        const back = new URL(url.searchParams.get("redirect_uri")!);
        back.searchParams.set("code", code);
        back.searchParams.set("state", url.searchParams.get("state")!);
        return Response.redirect(back.toString(), 302);
      }
      if (url.pathname === "/token") {
        const form = new URLSearchParams(await req.text());
        if (form.get("client_secret") !== "sekret") return Response.json({ error: "invalid_client" }, { status: 401 });
        if (form.get("grant_type") === "refresh_token") {
          if (form.get("refresh_token") !== "refresh-1") return Response.json({ error: "invalid_grant" }, { status: 400 });
          state.refreshed++;
          tokens.add("access-2");
          return Response.json({ access_token: "access-2", expires_in: 3600 });
        }
        const grant = codes.get(form.get("code") ?? "");
        const challenge = createHash("sha256").update(form.get("code_verifier") ?? "").digest("base64url");
        if (!grant || grant.challenge !== challenge || grant.redirect !== form.get("redirect_uri")) return Response.json({ error: "invalid_grant" }, { status: 400 });
        tokens.add("access-1");
        return Response.json({ access_token: "access-1", refresh_token: "refresh-1", expires_in: 3600, token_type: "Bearer" });
      }
      return new Response("nope", { status: 404 });
    },
  });
  return {
    base: `http://127.0.0.1:${server.port}`,
    codes,
    registered,
    tokens,
    closed,
    get refreshed() {
      return state.refreshed;
    },
    stop: () => server.stop(true),
  } as Fake;
}

const fake = fakeServer();
afterAll(() => {
  fake.stop();
  rmSync(dir, { recursive: true, force: true });
});
beforeEach(() => rmSync(file, { force: true }));

async function waitFor<T>(fn: () => T | undefined, ms = 3000): Promise<T> {
  const until = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > until) throw new Error("timed out");
    await Bun.sleep(20);
  }
}

describe("discovery", () => {
  test("a 401 leads to the authorization server through the resource metadata", async () => {
    const found = await oauth.discover(`${fake.base}/mcp`);
    expect(found.requiresAuth).toBe(true);
    expect(found.scope).toBe("mcp:connect");
    expect(found.resource).toBe(`${fake.base}/mcp`);
    expect(found.authServer?.registrationEndpoint).toBe(`${fake.base}/register`);
  });

  test("well-known URLs put the suffix before the path", () => {
    expect(oauth.wellKnown("https://api.figma.com", "oauth-authorization-server")).toBe("https://api.figma.com/.well-known/oauth-authorization-server");
    expect(oauth.wellKnown("https://x.dev/tenant/1/", "oauth-protected-resource")).toBe("https://x.dev/.well-known/oauth-protected-resource/tenant/1");
  });

  test("parses WWW-Authenticate with quoted and bare values", () => {
    expect(oauth.parseWwwAuthenticate('Bearer resource_metadata="https://a/b", scope="x y", error=invalid_token')).toEqual({ resource_metadata: "https://a/b", scope: "x y", error: "invalid_token" });
  });
});

describe("the login, completed by the browser", () => {
  test("loopback: register, authorize, redirect, exchange, probe — then the agent env has the token", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, name: "Fake Figma", clientName: "Claude Code" }, file);
    expect(mcp.listViews(file)[0]?.state).toBe("needs-login");

    const login = await mcp.startLogin({ serverId: server.id, loopback: { port: 0 }, path: file });
    expect(login.url.startsWith(`${fake.base}/authorize?`)).toBe(true);
    const params = new URL(login.url).searchParams;
    expect(params.get("code_challenge_method")).toBe("S256");
    expect(params.get("resource")).toBe(`${fake.base}/mcp`);
    expect(params.get("scope")).toBe("mcp:connect");
    expect(login.redirectUri).toMatch(/^http:\/\/localhost:\d+\/callback$/);

    // `localhost` may resolve to ::1: the listener answers there too (a wrong state is refused, not consumed).
    const port = new URL(login.redirectUri).port;
    const v6 = await fetch(`http://[::1]:${port}/callback?state=wrong&code=x`).catch(() => null);
    if (v6) expect(v6.status).toBe(400);

    const seen: string[] = [];
    mcp.subscribeLogin(login.id, (v) => seen.push(v.status));
    // The browser: follow the authorization URL to our loopback page.
    const page = await fetch(login.url);
    expect(page.status).toBe(200);
    expect(await page.text()).toContain("Connected");

    const done = await waitFor(() => (mcp.getLogin(login.id)?.status === "done" ? mcp.getLogin(login.id) : undefined));
    expect(done.toolCount).toBe(2);
    // The probe ended its MCP session (servers cap live sessions).
    expect(fake.closed).toContain("s1");
    expect(seen).toContain("exchanging");
    expect(seen.at(-1)).toBe("done");

    const view = mcp.listViews(file)[0]!;
    expect(view.state).toBe("connected");
    expect(JSON.stringify(view)).not.toContain("access-1"); // a view never carries a token

    const env = JSON.parse(mcp.mcpRunEnv(file).MINI_AGENT_MCP_SERVERS!) as Array<{ name: string; url: string; headers: Record<string, string> }>;
    expect(env).toEqual([{ name: server.id, url: `${fake.base}/mcp`, headers: { Authorization: "Bearer access-1" } }]);
    expect(statSync(file).mode & 0o777).toBe(0o600);

    // The listener is gone once the login is over.
    await expect(fetch(login.redirectUri)).rejects.toThrow();
  });

  test("the registered client is reused for the same redirect", async () => {
    const before = fake.registered.length;
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    const a = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:4317/api/mcp/oauth/callback", path: file });
    const b = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:4317/api/mcp/oauth/callback", path: file });
    expect(fake.registered.length).toBe(before + 1);
    // The second attempt superseded the first.
    expect(mcp.getLogin(a.id)?.status).toBe("error");
    mcp.cancelLogin(b.id);
  });

  test("web callback: the query string completes the login", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    const login = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:4317/api/mcp/oauth/callback", path: file });
    const r = await fetch(login.url, { redirect: "manual" });
    const back = new URL(r.headers.get("location")!);
    const done = await mcp.completeFromCallback(back.searchParams);
    expect(done?.status).toBe("done");
    expect(await mcp.completeFromCallback(new URLSearchParams("state=unknown&code=x"))).toBeUndefined();
  });

  test("paste: the address the browser ended on completes the login (browser on another machine)", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    const login = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:1/callback", path: file });
    const r = await fetch(login.url, { redirect: "manual" });
    await expect(mcp.completeFromPaste(login.id, "http://localhost:1/callback?code=c&state=other")).rejects.toThrow("another login");
    const done = await mcp.completeFromPaste(login.id, r.headers.get("location")!);
    expect(done.status).toBe("done");
  });

  test("a provider error in the redirect fails the login with its reason", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    const login = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:1/callback", path: file });
    const v = await mcp.completeFromCallback(new URLSearchParams({ state: login.id, error: "access_denied", error_description: "user said no" }));
    expect(v?.status).toBe("error");
    expect(v?.error).toContain("user said no");
  });

  test("a refused registration says why and what to do", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Some Client" }, file);
    const error = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:1/callback", path: file }).catch((e) => e);
    expect(error).toBeInstanceOf(mcp.RegistrationRefused);
    expect(String(error.message)).toContain("Some Client");
  });
});

describe("tokens", () => {
  test("an expiring token is refreshed with the same client before a probe", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    const login = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:1/callback", path: file });
    const r = await fetch(login.url, { redirect: "manual" });
    await mcp.completeFromPaste(login.id, r.headers.get("location")!);
    mcp.updateServer(server.id, (s) => ({ ...s, oauth: { ...s.oauth, tokens: { ...s.oauth!.tokens!, expiresAt: Date.now() - 1 } } }), file);
    const before = fake.refreshed;
    const probe = await mcp.probeStored(server.id, file);
    expect(probe.ok).toBe(true);
    expect(fake.refreshed).toBe(before + 1);
    const stored = JSON.parse(readFileSync(file, "utf8")).servers[0];
    expect(stored.oauth.tokens.accessToken).toBe("access-2");
    expect(stored.oauth.tokens.refreshToken).toBe("refresh-1"); // kept when not rotated
  });

  test("logout forgets tokens but keeps the client; disabled servers are not given to the agent", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    mcp.updateServer(server.id, (s) => ({ ...s, oauth: { ...s.oauth, clients: { k: { clientId: "c", authMethod: "none" } }, tokens: { accessToken: "t" } } }), file);
    expect(mcp.mcpRunEnv(file).MINI_AGENT_MCP_SERVERS).toBeDefined();
    mcp.setDisabled(server.id, true, file);
    expect(mcp.mcpRunEnv(file)).toEqual({});
    mcp.setDisabled(server.id, false, file);
    mcp.logoutServer(server.id, file);
    const s = mcp.getServer(server.id, file)!;
    expect(s.oauth?.tokens).toBeUndefined();
    expect(s.oauth?.clients?.k?.clientId).toBe("c");
    expect(mcp.mcpRunEnv(file)).toEqual({}); // an OAuth server with no login is not handed out
  });
});

describe("input handling", () => {
  test("parseCallbackInput takes a URL, a query, or a bare code", () => {
    expect(oauth.parseCallbackInput("http://localhost:3/callback?code=abc&state=s")).toEqual({ code: "abc", state: "s" });
    expect(oauth.parseCallbackInput("?code=abc&state=s")).toEqual({ code: "abc", state: "s" });
    expect(oauth.parseCallbackInput("abc-123")).toEqual({ code: "abc-123" });
    expect(oauth.parseCallbackInput("http://x/?error=access_denied")).toEqual({ error: "access_denied" });
    expect(oauth.parseCallbackInput("   ")).toEqual({});
  });

  test("addServer refuses plain http off loopback and bad presets", () => {
    expect(() => mcp.addServer({ url: "http://example.com/mcp" }, file)).toThrow("https");
    expect(() => mcp.addServer({ url: "not a url" }, file)).toThrow("URL");
    expect(() => mcp.addServer({ preset: "nope" }, file)).toThrow("preset");
    const figma = mcp.addServer({ preset: "figma" }, file);
    expect(figma.url).toBe("https://mcp.figma.com/mcp");
    expect(figma.oauth?.clientName).toBe("Claude Code");
    // Header names are validated and values with newlines dropped (no header injection).
    const h = mcp.addServer({ url: "https://h.example/mcp", headers: { Authorization: "Bearer x", "Bad Name": "v", "X-Evil": "a\r\nb" } }, file);
    expect(h.headers).toEqual({ Authorization: "Bearer x" });
    expect(mcp.addServer({ url: "https://h.example/mcp" }, file).id).not.toBe(h.id);
  });

  test("under test with no explicit path, nothing is read or written", () => {
    expect(mcp.mcpPath({ NODE_ENV: "test" })).toBeNull();
    expect(mcp.loadServers(null)).toEqual([]);
  });
});

describe("Linear preset guidance", () => {
  test("existing installs inherit native-call and read-back hints without reauthentication", () => {
    const s = mcp.addServer({ preset: "linear" }, file);
    // Simulate the record written by the release before preset hints existed.
    mcp.updateServer(s.id, (r) => ({ ...r, hints: undefined, oauth: { ...r.oauth, tokens: { accessToken: "test-token" } } }), file);
    const env = JSON.parse(mcp.mcpRunEnv(file).MINI_AGENT_MCP_SERVERS!)[0];
    expect(env.hints.save_issue).toBe(mcp.LINEAR_SAVE_ISSUE_HINT);
    expect(env.hints.save_issue).toContain("native tool-call field");
    expect(env.hints.save_issue).toContain("Read it back");
    expect(readFileSync(file, "utf8")).not.toContain("native tool-call field"); // runtime migration, not a config rewrite
  });

  test("a local hint override wins over the preset", () => {
    const s = mcp.addServer({ preset: "linear" }, file);
    mcp.updateServer(s.id, (r) => ({ ...r, hints: { save_issue: "custom" }, oauth: { ...r.oauth, tokens: { accessToken: "test-token" } } }), file);
    const env = JSON.parse(mcp.mcpRunEnv(file).MINI_AGENT_MCP_SERVERS!)[0];
    expect(env.hints.save_issue).toBe("custom");
  });
});

describe("self-hosted servers (OpenPencil)", () => {
  test("the preset reads its token from a file at run time and limits the tools the agent gets", async () => {
    const { writeFileSync } = await import("node:fs");
    const tokenFile = join(dir, "op-token");
    writeFileSync(tokenFile, "first-token\n");
    const s = mcp.addServer({ preset: "openpencil" }, file);
    expect(s.url).toBe("http://127.0.0.1:7600/mcp");
    expect(s.oauth).toBeUndefined();
    expect(s.tools).toContain("render");
    expect(s.tools).not.toContain("eval");
    // Point the stored record at the test token file.
    mcp.updateServer(s.id, (r) => ({ ...r, tokenFile }), file);
    const read = () => JSON.parse(mcp.mcpRunEnv(file).MINI_AGENT_MCP_SERVERS!)[0];
    expect(read().headers).toEqual({ Authorization: "Bearer first-token" });
    expect(read().tools).toEqual(mcp.OPENPENCIL_TOOLS);
    // The server rotated its token: the next run sees the new one, nothing copied in mcp.json.
    writeFileSync(tokenFile, "second-token");
    expect(read().headers.Authorization).toBe("Bearer second-token");
    expect(readFileSync(file, "utf8")).not.toContain("second-token");
    const view = mcp.listViews(file)[0]!;
    expect(view.state).toBe("ready");
    expect(view.tokenFile).toBe(tokenFile);
    expect(JSON.stringify(view)).not.toContain("second-token");
  });

  test("a missing token file sends no Authorization; a down server says how to start it", async () => {
    const s = mcp.addServer({ preset: "openpencil" }, file);
    mcp.updateServer(s.id, (r) => ({ ...r, tokenFile: join(dir, "nope"), url: "http://127.0.0.1:1/mcp" }), file);
    expect(JSON.parse(mcp.mcpRunEnv(file).MINI_AGENT_MCP_SERVERS!)[0].headers).toEqual({});
    const probe = await mcp.probeStored(s.id, file);
    expect(probe.ok).toBe(false);
    expect(probe.error).toContain("systemctl --user start openpencil-mcp");
  });

  test("a refused self-hosted token is not an OAuth login", async () => {
    const s = mcp.addServer({ preset: "openpencil" }, file);
    mcp.updateServer(s.id, (r) => ({ ...r, tokenFile: join(dir, "nope"), url: `${fake.base}/mcp` }), file);
    const probe = await mcp.probeStored(s.id, file);
    expect(probe.needsAuth).toBeFalsy();
    expect(probe.error).toContain("refused the token");
  });
});

describe("Google Search Console (Google's own MCP server)", () => {
  // Google's server answers initialize and tools/list without a token and refuses only calls;
  // only its protected-resource metadata says it needs OAuth.
  const google = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(req) {
      const url = new URL(req.url);
      const base = `http://127.0.0.1:${google.port}`;
      if (url.pathname === "/mcp" && req.method === "POST") {
        const body = (await req.json()) as { id?: number; method: string };
        if (body.method === "tools/call") {
          if (req.headers.get("authorization") !== "Bearer good") return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "Request is missing required authentication credential." }], isError: true } }, { status: 401 });
          return Response.json({ jsonrpc: "2.0", id: body.id, result: { content: [{ type: "text", text: "[]" }] } });
        }
        if (body.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: body.id, result: { tools: [{ name: "sites_list" }, { name: "query" }] } });
        if (body.method === "initialize") return Response.json({ jsonrpc: "2.0", id: body.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "StatelessServer" } } });
        return new Response(null, { status: 202 });
      }
      if (url.pathname === "/.well-known/oauth-protected-resource/mcp") return Response.json({ resource: `${base}/mcp`, authorization_servers: [`${base}/`], scopes_supported: ["https://www.googleapis.com/auth/webmasters", "https://www.googleapis.com/auth/webmasters.readonly"] });
      if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ issuer: base, authorization_endpoint: "https://accounts.google.com/o/oauth2/v2/auth", token_endpoint: `${base}/token`, token_endpoint_auth_methods_supported: ["client_secret_post", "client_secret_basic"] });
      return new Response("", { status: 404 });
    },
  });
  afterAll(() => google.stop(true));

  test("a server that lists tools anonymously is still found to need OAuth", async () => {
    const found = await oauth.discover(`http://127.0.0.1:${google.port}/mcp`);
    expect(found.requiresAuth).toBe(true);
    expect(found.authServer?.registrationEndpoint).toBeUndefined();
  });

  test("a server with no metadata and a 200 still needs no login", async () => {
    const found = await oauth.discover(`${fake.base}/nothing-here`).catch(() => ({ requiresAuth: false }));
    expect(found.requiresAuth).toBe(false);
  });

  test("the preset needs your client, asks only for read-only, and its login asks Google for a refresh token", async () => {
    expect(() => mcp.addServer({ preset: "google-search-console" }, file)).toThrow("client id");
    expect(() => mcp.addServer({ preset: "google-search-console", clientId: "a b" }, file)).toThrow("looks wrong");
    const s = mcp.addServer({ preset: "google-search-console", clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test" }, file);
    expect(s.url).toBe("https://searchconsole.googleapis.com/mcp");
    expect(s.oauth?.staticClient).toEqual({ clientId: "123-abc.apps.googleusercontent.com", clientSecret: "GOCSPX-test", authMethod: "client_secret_post" });
    expect(s.oauth?.scope).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(s.tools).toEqual(["sites_list", "query"]);
    expect(JSON.stringify(mcp.listViews(file))).not.toContain("GOCSPX-test");
    // An anonymous tools/list is not a working login.
    const probe = await mcp.probe(s);
    expect(probe.needsAuth).toBe(true);

    // Point it at the fake Google and start a login: offline access + consent, PKCE, the
    // read-only scope (not everything the server lists), and no registration call.
    mcp.updateServer(s.id, (r) => ({ ...r, url: `http://127.0.0.1:${google.port}/mcp` }), file);
    const login = await mcp.startLogin({ serverId: s.id, redirectUri: "https://mini.example/api/mcp/oauth/callback", path: file });
    const q = new URL(login.url).searchParams;
    expect(login.url.startsWith("https://accounts.google.com/o/oauth2/v2/auth?")).toBe(true);
    expect(q.get("client_id")).toBe("123-abc.apps.googleusercontent.com");
    expect(q.get("access_type")).toBe("offline");
    expect(q.get("prompt")).toBe("consent");
    expect(q.get("scope")).toBe("https://www.googleapis.com/auth/webmasters.readonly");
    expect(q.get("code_challenge_method")).toBe("S256");
    mcp.cancelLogin(login.id);
  });

  test("with a token, the connection is proved by a call, not by the anonymous listing", async () => {
    const s = mcp.addServer({ preset: "google-search-console", clientId: "123-abc.apps.googleusercontent.com", clientSecret: "x" }, file);
    const at = (accessToken: string) => ({ ...s, url: `http://127.0.0.1:${google.port}/mcp`, oauth: { ...s.oauth, tokens: { accessToken } } });
    const bad = await mcp.probe(at("revoked"));
    expect(bad.ok).toBe(false);
    expect(bad.needsAuth).toBe(true);
    const good = await mcp.probe(at("good"));
    expect(good.ok).toBe(true);
    expect(good.tools?.map((t) => t.name)).toEqual(["sites_list", "query"]);
  });

  test("non-Google servers do not get Google's offline parameters", async () => {
    const server = mcp.addServer({ url: `${fake.base}/mcp`, clientName: "Claude Code" }, file);
    const login = await mcp.startLogin({ serverId: server.id, redirectUri: "http://localhost:1/callback", path: file });
    expect(new URL(login.url).searchParams.get("access_type")).toBeNull();
    mcp.cancelLogin(login.id);
  });

  test("a hand-registered client never falls back to a random loopback port", async () => {
    const s = mcp.addServer({ preset: "google-search-console", clientId: "123-abc.apps.googleusercontent.com", clientSecret: "x" }, file);
    mcp.updateServer(s.id, (r) => ({ ...r, url: `http://127.0.0.1:${google.port}/mcp` }), file);
    const busy = Bun.serve({ port: 0, hostname: "127.0.0.1", fetch: () => new Response("") });
    try {
      await expect(mcp.startLogin({ serverId: s.id, loopback: { port: busy.port }, path: file })).rejects.toThrow("busy");
    } finally {
      busy.stop(true);
    }
  });
});
