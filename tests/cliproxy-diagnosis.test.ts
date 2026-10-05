import { describe, expect, test } from "bun:test";

import { diagnoseCliproxy, stageRank } from "../src/cliproxyDiagnosis";

const REFUSED =
  "ProviderError: http://127.0.0.1:8317/v1/chat/completions: Connection Failed: Connect error: Connection refused (os error 111) (http://127.0.0.1:8317/v1)";

describe("diagnoseCliproxy", () => {
  test("a refused connect is the gateway being down", () => {
    const d = diagnoseCliproxy(REFUSED);
    expect(d.stage).toBe("gateway");
    expect(d.fix).toContain("systemctl --user start cli-proxy-api");
  });

  test("a wrong key is credentials, not the gateway", () => {
    const d = diagnoseCliproxy("ProviderAbortError: HTTP 401 from http://127.0.0.1:8317/v1: Invalid API key");
    expect(d.stage).toBe("credentials");
    expect(d.fix).toContain("CLIPROXY_API_KEY");
  });

  test("a revoked upstream login is auth, and is not blamed on the key", () => {
    const d = diagnoseCliproxy(
      "ProviderAbortError: HTTP 401 from http://127.0.0.1:8317/v1: OAuth access token has been revoked.",
    );
    expect(d.stage).toBe("auth");
    expect(d.fix).toContain("OAuth login");
    expect(d.fix).not.toContain("CLIPROXY_API_KEY");
  });

  test("the gateway's cooldown jargon reads as auth too", () => {
    const d = diagnoseCliproxy(
      "ProviderError: HTTP 503 from http://127.0.0.1:8317/v1: auth_unavailable: no auth available (providers=claude, model=claude-sonnet-5-5)",
    );
    expect(d.stage).toBe("auth");
    expect(d.fix).toContain("cooling down");
  });

  test("an unadvertised id is the model mapping", () => {
    const d = diagnoseCliproxy("ProviderAbortError: HTTP 404 from http://127.0.0.1:8317/v1: model nope not found");
    expect(d.stage).toBe("model");
    expect(d.fix).toContain("/models");
  });

  test("an unrelated crash is left alone", () => {
    expect(diagnoseCliproxy("Traceback (most recent call last): FileNotFoundError: /tmp/x")).toEqual({ fix: "", stage: "" });
    expect(diagnoseCliproxy("")).toEqual({ fix: "", stage: "" });
    // not cli-proxy: another provider's 401 keeps its own hint
    expect(diagnoseCliproxy("HTTP 401 from https://api.deepseek.com/v1: invalid key").stage).toBe("");
  });

  test("stages rank by how early they break a run", () => {
    expect(stageRank("gateway")).toBeLessThan(stageRank("credentials"));
    expect(stageRank("credentials")).toBeLessThan(stageRank("auth"));
    expect(stageRank("auth")).toBeLessThan(stageRank("model"));
    expect(stageRank("")).toBeGreaterThan(stageRank("model"));
  });
});
