/**
 * `/mcp` in the terminal: the login link is shown with copy/open keys, a background listener
 * waits for the browser, and the panel moves to "connected" by itself when the browser lands.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { act } from "react";
import { testRender } from "@opentui/react/test-utils";

import { App } from "../src/ui/App";
import * as mcp from "../src/mcp/index";

process.env.MINITUI_CONNECTIONS_PATH = "/dev/null/mini-tui-no-connections.json";
process.env.MINITUI_LAST_MODEL_PATH = "/dev/null/mini-tui-no-last-model.json";

const dir = mkdtempSync(join(tmpdir(), "minitui-tui-mcp-"));
const file = join(dir, "mcp.json");

// A minimal OAuth-protected MCP server whose /authorize approves at once.
const fake = Bun.serve({
  port: 0,
  hostname: "127.0.0.1",
  async fetch(req) {
    const url = new URL(req.url);
    const base = `http://127.0.0.1:${fake.port}`;
    if (url.pathname === "/mcp") {
      if (req.headers.get("authorization") !== "Bearer ok") return new Response("", { status: 401, headers: { "www-authenticate": `Bearer resource_metadata="${base}/.well-known/oauth-protected-resource"` } });
      const b = (await req.json()) as { id?: number; method: string };
      if (b.method === "initialize") return Response.json({ jsonrpc: "2.0", id: b.id, result: { protocolVersion: "2025-06-18", serverInfo: { name: "f" } } });
      if (b.method === "tools/list") return Response.json({ jsonrpc: "2.0", id: b.id, result: { tools: [{ name: "a" }, { name: "b" }, { name: "c" }] } });
      return new Response(null, { status: 202 });
    }
    if (url.pathname === "/.well-known/oauth-protected-resource") return Response.json({ resource: `${base}/mcp`, authorization_servers: [base] });
    if (url.pathname === "/.well-known/oauth-authorization-server") return Response.json({ authorization_endpoint: `${base}/authorize`, token_endpoint: `${base}/token`, registration_endpoint: `${base}/register` });
    if (url.pathname === "/register") return Response.json({ client_id: "cid" });
    if (url.pathname === "/authorize") {
      const back = new URL(url.searchParams.get("redirect_uri")!);
      back.searchParams.set("code", "the-code");
      back.searchParams.set("state", url.searchParams.get("state")!);
      return Response.redirect(back.toString(), 302);
    }
    if (url.pathname === "/token") return Response.json({ access_token: "ok", expires_in: 3600 });
    return new Response("", { status: 404 });
  },
});
afterAll(() => {
  fake.stop(true);
  rmSync(dir, { recursive: true, force: true });
});

async function frameUntil(setup: Awaited<ReturnType<typeof testRender>>, text: string, ms = 4000): Promise<string> {
  const until = Date.now() + ms;
  for (;;) {
    await act(async () => {
      await Bun.sleep(25);
    });
    await setup.renderOnce();
    const frame = setup.captureCharFrame();
    if (frame.includes(text)) return frame;
    if (Date.now() > until) throw new Error(`"${text}" never appeared:\n${frame}`);
  }
}

async function press(setup: Awaited<ReturnType<typeof testRender>>, fn: () => void | Promise<void>) {
  await act(async () => {
    await fn();
  });
  await setup.renderOnce();
}

describe("/mcp in the terminal", () => {
  test("install → login link with copy/open → the browser completes it → connected, detected by itself", async () => {
    const copied: string[] = [];
    const opened: string[] = [];
    const setup = await testRender(
      <App
        cwd="."
        events={[]}
        info={{ cost: 0, apiCalls: 0 }}
        persistSettings={false}
        mcpPath={file}
        onCopy={(t) => copied.push(t)}
        onOpenUrl={(u) => (opened.push(u), "test-browser")}
        onQuit={() => {}}
      />,
      { width: 120, height: 40 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("/mcp");
    await Bun.sleep(20);
    await press(setup, () => setup.mockInput.pressEnter()); // palette fill
    await press(setup, () => setup.mockInput.pressEnter()); // run
    let frame = await frameUntil(setup, "mcp servers");
    expect(frame).toContain("no MCP servers installed yet");
    expect(frame).toContain("+ add a server");

    await press(setup, () => setup.mockInput.pressKey("a"));
    frame = await frameUntil(setup, "custom URL");
    expect(frame).toContain("Figma");

    // custom URL: type "custom" to filter to the custom row, then enter the fake server's URL
    await setup.mockInput.typeText("zzzz");
    await press(setup, () => setup.mockInput.pressEnter());
    await frameUntil(setup, "MCP server URL");
    await press(setup, () => setup.mockInput.pasteBracketedText(`http://127.0.0.1:${fake.port}/mcp`));
    await press(setup, () => setup.mockInput.pressEnter());

    // The probe answers 401 → the login starts in the background and the link is shown.
    frame = await frameUntil(setup, "waiting for the browser");
    expect(frame).toContain("[c] copy link");
    expect(frame).toContain("[o] open in browser");
    expect(frame).toContain(`127.0.0.1:${fake.port}/authorize`);

    await press(setup, () => setup.mockInput.pressKey("c"));
    frame = await frameUntil(setup, "copied ✓");
    expect(copied[0]).toContain("/authorize?");

    await press(setup, () => setup.mockInput.pressKey("o"));
    await frameUntil(setup, "opened (test-browser)");
    expect(opened[0]).toBe(copied[0]);

    // The "browser": follow the link to our loopback listener. Nothing is pressed afterwards.
    const page = await fetch(opened[0]!);
    expect(await page.text()).toContain("Connected");
    frame = await frameUntil(setup, "connected");
    expect(frame).toContain("3 tools available");

    await press(setup, () => setup.mockInput.pressEnter());
    frame = await frameUntil(setup, "● connected");
    expect(mcp.listViews(file)[0]?.state).toBe("connected");
    setup.renderer.destroy();
  });

  test("Google Search Console asks for your OAuth client before installing, with the secret masked", async () => {
    const setup = await testRender(
      <App cwd="." events={[]} info={{ cost: 0, apiCalls: 0 }} persistSettings={false} mcpPath={join(dir, "gsc.json")} onQuit={() => {}} />,
      { width: 140, height: 40 },
    );
    await setup.renderOnce();
    await setup.mockInput.typeText("/mcp");
    await Bun.sleep(20);
    await press(setup, () => setup.mockInput.pressEnter());
    await press(setup, () => setup.mockInput.pressEnter());
    await frameUntil(setup, "mcp servers");
    await press(setup, () => setup.mockInput.pressKey("a"));
    await setup.mockInput.typeText("search console");
    await frameUntil(setup, "Google Search Console");
    await press(setup, () => setup.mockInput.pressEnter());
    let frame = await frameUntil(setup, "your OAuth client");
    expect(frame).toContain("http://localhost:33418/callback");
    await press(setup, () => setup.mockInput.pasteBracketedText("123-abc.apps.googleusercontent.com"));
    await press(setup, () => setup.mockInput.pressEnter()); // → secret
    await press(setup, () => setup.mockInput.pasteBracketedText("GOCSPX-secret"));
    frame = await frameUntil(setup, "•••••••••••••");
    expect(frame).toContain("123-abc.apps.googleusercontent.com");
    expect(frame).not.toContain("GOCSPX-secret");
    // Escape goes back without installing anything.
    await press(setup, () => setup.mockInput.pressEscape());
    await frameUntil(setup, "custom URL");
    expect(mcp.listViews(join(dir, "gsc.json"))).toEqual([]);
    setup.renderer.destroy();
  });
});
