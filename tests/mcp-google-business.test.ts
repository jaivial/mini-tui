/**
 * Google Business Profile served as an MCP server by mini-tui (src/mcp/googleBusiness.ts):
 * Google-shaped auth discovery, token check, several saved businesses, and the REST calls it
 * makes — against a fake Google, never the real one.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const gbp = await import("../src/mcp/googleBusiness");
const mcp = await import("../src/mcp/index");

const dir = mkdtempSync(join(tmpdir(), "minitui-gbp-"));
const file = join(dir, "google-business.json");
afterAll(() => rmSync(dir, { recursive: true, force: true }));

const calls: { method: string; url: string; auth: string; body?: unknown }[] = [];
const fakeGoogle = (async (input: string | URL | Request, init?: RequestInit) => {
  const url = String(input);
  const auth = new Headers(init?.headers).get("authorization") ?? "";
  if (url.startsWith("https://oauth2.googleapis.com/tokeninfo")) {
    const t = new URL(url).searchParams.get("access_token");
    if (t === "good") return Response.json({ scope: `openid ${gbp.GBP_SCOPE}`, expires_in: "3000" });
    if (t === "noscope") return Response.json({ scope: "https://www.googleapis.com/auth/webmasters.readonly", expires_in: "3000" });
    return Response.json({ error: "invalid_token" }, { status: 400 });
  }
  calls.push({ method: init?.method ?? "GET", url, auth, body: init?.body ? JSON.parse(String(init.body)) : undefined });
  if (url.includes("/locations/403")) return Response.json({ error: { status: "PERMISSION_DENIED", message: "quota 0" } }, { status: 403 });
  if (url.includes("/locations/401")) return Response.json({ error: { status: "UNAUTHENTICATED", message: "bad" } }, { status: 401 });
  if (url.startsWith("https://mybusinessaccountmanagement.googleapis.com/v1/accounts")) return Response.json({ accounts: [{ name: "accounts/111", accountName: "Jaime" }] });
  const loc = url.match(/mybusinessbusinessinformation\.googleapis\.com\/v1\/locations\/(\d+)/);
  if (loc) return Response.json({ name: `locations/${loc[1]}`, title: loc[1] === "222" ? "Alquería Villa Carmen" : "Otro Local" });
  return Response.json({ ok: true });
}) as typeof fetch;

const opts = { metadataUrl: "http://127.0.0.1:4317/.well-known/oauth-protected-resource/api/gbp/mcp", path: file, fetcher: fakeGoogle };

async function call(name: string, args: Record<string, unknown> = {}, token = "good") {
  const r = await gbp.handleGbpMcp(
    new Request("http://127.0.0.1:4317/api/gbp/mcp", { method: "POST", headers: { authorization: `Bearer ${token}`, "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name, arguments: args } }) }),
    opts,
  );
  const body = (await r.json()) as { result?: { content: { text: string }[]; isError?: boolean } };
  return { status: r.status, text: body.result?.content[0]?.text ?? "", isError: !!body.result?.isError };
}

describe("auth", () => {
  test("no token: 401 that points at Google's authorization server", async () => {
    const r = await gbp.handleGbpMcp(new Request("http://x/api/gbp/mcp", { method: "POST", body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) }), opts);
    expect(r.status).toBe(401);
    expect(r.headers.get("www-authenticate")).toContain(`resource_metadata="${opts.metadataUrl}"`);
    expect(gbp.protectedResourceMetadata().authorization_servers).toEqual(["https://accounts.google.com/"]);
    expect(gbp.protectedResourceMetadata().resource).toBeUndefined();
  });

  test("a token Google rejects, or one without business.manage, is a 401 too", async () => {
    expect((await call("businesses_list", {}, "forged")).status).toBe(401);
    expect((await call("businesses_list", {}, "noscope")).status).toBe(401);
  });

  test("initialize and tools/list with a good token", async () => {
    const init = await gbp.handleGbpMcp(new Request("http://x", { method: "POST", headers: { authorization: "Bearer good" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } }) }), opts);
    expect(((await init.json()) as { result: { protocolVersion: string } }).result.protocolVersion).toBe("2025-06-18");
    const list = await gbp.handleGbpMcp(new Request("http://x", { method: "POST", headers: { authorization: "Bearer good" }, body: JSON.stringify({ jsonrpc: "2.0", id: 2, method: "tools/list" }) }), opts);
    const names = ((await list.json()) as { result: { tools: { name: string }[] } }).result.tools.map((t) => t.name);
    expect(names).toContain("businesses_list");
    expect(names).toContain("reviews_list");
    expect(names).toContain("performance");
  });
});

describe("several businesses", () => {
  test("none saved: the tools say how to add one", async () => {
    const r = await call("reviews_list");
    expect(r.isError).toBe(true);
    expect(r.text).toContain("business_add");
  });

  test("add two, the first is the default, pick by alias, switch the default, remove", async () => {
    const a = await call("business_add", { account: "111", location: "locations/222" });
    expect(a.isError).toBe(false);
    expect(JSON.parse(a.text).saved.id).toBe("alqueria-villa-carmen");
    await call("business_add", { account: "accounts/111", location: "333", alias: "otro" });
    let saved = gbp.loadBusinesses(file);
    expect(saved.businesses.map((b) => b.id)).toEqual(["alqueria-villa-carmen", "otro"]);
    expect(saved.default).toBe("alqueria-villa-carmen");
    expect(statSync(file).mode & 0o777).toBe(0o600);

    calls.length = 0;
    await call("reviews_list");
    expect(calls[0]!.url).toContain("mybusiness.googleapis.com/v4/accounts/111/locations/222/reviews");
    expect(calls[0]!.auth).toBe("Bearer good");
    await call("reviews_list", { business: "otro" });
    expect(calls[1]!.url).toContain("/accounts/111/locations/333/reviews");

    await call("business_select", { business: "otro" });
    expect(gbp.loadBusinesses(file).default).toBe("otro");
    await call("business_remove", { business: "otro" });
    saved = gbp.loadBusinesses(file);
    expect(saved.businesses.map((b) => b.id)).toEqual(["alqueria-villa-carmen"]);
    expect(saved.default).toBe("alqueria-villa-carmen");
    expect(readFileSync(file, "utf8")).not.toContain("good");
  });

  test("ids are validated before anything reaches Google", async () => {
    const r = await call("business_add", { account: "111", location: "../../evil" });
    expect(r.isError).toBe(true);
    expect((await call("review_reply", { review: "a/../b?x", comment: "hi" })).isError).toBe(true);
  });
});

describe("Google calls", () => {
  test("performance and keywords build Google's date parameters", async () => {
    calls.length = 0;
    await call("performance", { startDate: "2026-09-01", endDate: "2026-09-30", metrics: ["CALL_CLICKS", "WEBSITE_CLICKS"] });
    const u = new URL(calls[0]!.url);
    expect(u.pathname).toBe("/v1/locations/222:fetchMultiDailyMetricsTimeSeries");
    expect(u.searchParams.getAll("dailyMetrics")).toEqual(["CALL_CLICKS", "WEBSITE_CLICKS"]);
    expect(u.searchParams.get("dailyRange.end_date.day")).toBe("30");
    expect((await call("performance", { startDate: "2026-9-1", endDate: "x" })).isError).toBe(true);
    await call("search_keywords", { startMonth: "2026-08", endMonth: "2026-09" });
    expect(calls[1]!.url).toContain("/searchkeywords/impressions/monthly?monthlyRange.start_month.year=2026");
  });

  test("writes go where Google expects them", async () => {
    calls.length = 0;
    await call("review_reply", { review: "accounts/111/locations/222/reviews/AbC_1", comment: "¡Gracias!" });
    expect(calls[0]).toMatchObject({ method: "PUT", body: { comment: "¡Gracias!" } });
    expect(calls[0]!.url).toEndWith("/v4/accounts/111/locations/222/reviews/AbC_1/reply");
    await call("location_update", { updateMask: "websiteUri", location: { websiteUri: "https://villacarmen.example" }, validateOnly: true });
    expect(calls[1]!.method).toBe("PATCH");
    expect(calls[1]!.url).toContain("locations/222?updateMask=websiteUri&validateOnly=true");
  });

  test("a 403 explains API enablement / access approval; a 401 from Google is a 401", async () => {
    await call("business_add", { account: "111", location: "403", alias: "q" }).then((r) => {
      expect(r.isError).toBe(true);
      expect(r.text).toContain("Business Profile API access is approved");
    });
    expect((await call("business_add", { account: "111", location: "401" })).status).toBe(401);
  });
});

describe("the preset", () => {
  test("installs with your OAuth client, business.manage, and no RFC 8707 resource", () => {
    const mcpFile = join(dir, "mcp.json");
    expect(() => mcp.addServer({ preset: "google-business" }, mcpFile)).toThrow("client id");
    const s = mcp.addServer({ preset: "google-business", clientId: "1-a.apps.googleusercontent.com", clientSecret: "GOCSPX-x" }, mcpFile);
    expect(s.url).toEndWith("/api/gbp/mcp");
    expect(s.oauth?.scope).toBe("https://www.googleapis.com/auth/business.manage");
    expect(s.oauth?.omitResource).toBe(true);
    expect(JSON.stringify(mcp.listViews(mcpFile))).not.toContain("GOCSPX-x");
  });
});
