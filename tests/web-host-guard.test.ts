/**
 * The DNS-rebinding guards (D2).
 *
 * Two layers are tested, and both are needed: the rules (does this Host/Origin
 * belong to us?) and the wiring (is the guard actually called, on every
 * request, before the routes?). The wiring tests exist because the rules alone
 * pass while the server is still open — the same false green that shipped a
 * modal that was not a modal (C2) and a drawer that ate keystrokes (C1).
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { hostAllowed, hostRules, parseAllowedHosts, parseAuthority, sameOrigin } from "../src/web/hostGuard";

const h = (init: Record<string, string>): Headers => new Headers(init);
const BIND = "127.0.0.1";

describe("parseAuthority", () => {
  test("splits name and port, lowercasing", () => {
    expect(parseAuthority("127.0.0.1:4317")).toEqual({ name: "127.0.0.1", port: 4317 });
    expect(parseAuthority("Mini.Example.COM")).toEqual({ name: "mini.example.com", port: null });
    expect(parseAuthority("  mini.example.com  ")).toEqual({ name: "mini.example.com", port: null });
  });
  test("keeps a bracketed IPv6 name whole and takes its port", () => {
    expect(parseAuthority("[::1]:4317")).toEqual({ name: "[::1]", port: 4317 });
    expect(parseAuthority("[::1]")).toEqual({ name: "[::1]", port: null });
  });
  test("a bare IPv6 literal has no port to split", () => {
    expect(parseAuthority("::1")).toEqual({ name: "::1", port: null });
  });
  test("refuses what it cannot parse rather than guessing", () => {
    for (const bad of ["", "   ", "mini.example.com:", "mini.example.com:abc", "mini.example.com:0", "mini.example.com:99999", "[::1", "a".repeat(300)]) {
      expect(parseAuthority(bad)).toBeNull();
    }
  });
});

describe("hostRules", () => {
  test("always serves the bind address and loopback on any port", () => {
    const rules = hostRules(BIND);
    expect(hostAllowed("127.0.0.1:4317", rules)).toBe(true);
    expect(hostAllowed("127.0.0.1:9999", rules)).toBe(true);
    expect(hostAllowed("localhost:4317", rules)).toBe(true);
    expect(hostAllowed("[::1]:4317", rules)).toBe(true);
  });
  test("an operator-declared public name is served, with or without a port", () => {
    const rules = hostRules(BIND, ["mini.menustudioai.com"]);
    expect(hostAllowed("mini.menustudioai.com", rules)).toBe(true);
    expect(hostAllowed("mini.menustudioai.com:443", rules)).toBe(true);
    expect(hostAllowed("other.example.com", rules)).toBe(false);
  });
  test("an operator name never smuggles in a prefix or a suffix", () => {
    const rules = hostRules(BIND, ["mini.example.com"]);
    for (const bad of ["evil-mini.example.com", "mini.example.com.evil.test", "xmini.example.com", "mini.example.co"]) {
      expect(hostAllowed(bad, rules)).toBe(false);
    }
  });
  test("regex metacharacters in a configured name are literal", () => {
    const rules = hostRules(BIND, ["a.b"]);
    expect(hostAllowed("a.b", rules)).toBe(true);
    expect(hostAllowed("axb", rules)).toBe(false);
  });
  test("a name with an explicit port only answers on that port", () => {
    const rules = hostRules(BIND, ["mini.example.com:8443"]);
    expect(hostAllowed("mini.example.com:8443", rules)).toBe(true);
    expect(hostAllowed("mini.example.com", rules)).toBe(false);
  });
  test("parseAllowedHosts splits, trims and ignores empties", () => {
    expect(parseAllowedHosts("a.test, b.test ,,")).toEqual(["a.test", "b.test"]);
    expect(parseAllowedHosts(undefined)).toEqual([]);
    expect(parseAllowedHosts("")).toEqual([]);
  });
});

describe("the rebinding attack is refused", () => {
  const rules = hostRules(BIND, ["mini.menustudioai.com"]);

  test("a foreign Host is refused whatever the method or the Origin", () => {
    // The measured exploit: both halves chosen by the attacker.
    expect(hostAllowed("evil.example.com", rules)).toBe(false);
    expect(hostAllowed("evil.example.com:4317", rules)).toBe(false);
    expect(sameOrigin(h({ host: "evil.example.com", origin: "http://evil.example.com" }), rules)).toBe(false);
    // The layering, stated exactly: with no Origin there is nothing cross-site
    // about the request (curl, the test suite, a server-to-server call), so
    // sameOrigin passes it -- and it is the Host gate above, which runs first
    // and runs always, that refuses it. If those two ever swap order, this is
    // the assertion that notices.
    expect(sameOrigin(h({ host: "evil.example.com" }), rules)).toBe(true);
    expect(hostAllowed("evil.example.com", rules)).toBe(false);
  });

  test("X-Forwarded-Host is never a way in", () => {
    // Measured: a plain curl with this one header got 201 on POST /api/sessions
    // and 101 on the hub socket. It is attacker-supplied: nginx derives it from
    // the original request, so nothing stops a caller from setting it itself.
    expect(sameOrigin(h({ host: "127.0.0.1:4317", origin: "https://evil.example", "x-forwarded-host": "evil.example" }), rules)).toBe(false);
    expect(hostAllowed("evil.example.com", rules)).toBe(false);
  });

  test("a missing Host is refused (a real HTTP/1.1 request always has one)", () => {
    expect(hostAllowed(null, rules)).toBe(false);
    expect(hostAllowed("", rules)).toBe(false);
  });

  test("legitimate traffic still passes", () => {
    expect(sameOrigin(h({ host: "127.0.0.1:4317" }), rules)).toBe(true); // no Origin: not a cross-site browser request
    expect(sameOrigin(h({ host: "127.0.0.1:4317", origin: "http://127.0.0.1:4317" }), rules)).toBe(true);
    expect(sameOrigin(h({ host: "127.0.0.1:4317", origin: "http://localhost:4318" }), rules)).toBe(true); // vite dev proxy
    expect(sameOrigin(h({ host: "mini.menustudioai.com", origin: "https://mini.menustudioai.com" }), rules)).toBe(true);
  });

  test("a cross-site request to the right host is still refused", () => {
    expect(sameOrigin(h({ host: "127.0.0.1:4317", origin: "https://evil.example" }), rules)).toBe(false);
    expect(sameOrigin(h({ host: "127.0.0.1:4317", origin: "not a url" }), rules)).toBe(false);
  });
});

describe("the server is actually wired to the guard", () => {
  const serve = readFileSync(join(import.meta.dir, "..", "src/web/serve.ts"), "utf8");

  test("the Host gate runs on every request, before OPTIONS and before the routes", () => {
    const gate = serve.indexOf("hostAllowed(request.headers.get(\"host\"), HOST_RULES)");
    expect(gate).toBeGreaterThan(-1);
    expect(serve.indexOf('if (request.method === "OPTIONS")')).toBeGreaterThan(gate);
    expect(serve.indexOf('path === "/sessions"')).toBeGreaterThan(gate);
    expect(serve.indexOf('path === "/hub"')).toBeGreaterThan(gate);
    // Not behind a method check: a rebound GET carries no Origin to compare.
    const before = serve.slice(0, gate);
    expect(before).not.toMatch(/method\s*!==\s*"GET"[^\n]*hostAllowed/);
  });

  test("every origin check passes the server's rules, none reads the request back", () => {
    expect(serve).not.toMatch(/sameOrigin\(request\.headers\)/);
    const checks = serve.match(/sameOrigin\(request\.headers, HOST_RULES\)/g) ?? [];
    expect(checks.length).toBeGreaterThan(10); // the CSRF gate + every read-only route + both sockets
  });

  test("the rules come from the bind address and the environment, not the request", () => {
    expect(serve).toContain('hostRules(HOST, parseAllowedHosts(process.env.MINITUI_WEB_ALLOWED_HOSTS))');
    expect(serve).not.toMatch(/hostRules\([^)]*request\./);
  });

  test("the websocket upgrades are guarded too (CSWSH is the RCE path)", () => {
    expect(serve).toContain('path === "/hub"');
    const hub = serve.slice(serve.indexOf('path === "/hub"'), serve.indexOf('path === "/hub"') + 700);
    expect(hub).toContain("sameOrigin(request.headers, HOST_RULES)");
    const sock = serve.slice(serve.indexOf("/socket$/"), serve.indexOf("/socket$/") + 700);
    expect(sock).toContain("sameOrigin(request.headers, HOST_RULES)");
  });
});
