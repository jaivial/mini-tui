import { describe, expect, test } from "bun:test";

import { ghIdentity, gitConfigIdentity, gitIdentityEnv } from "../src/gitIdentity";

const JAI = { name: "Jaime", email: "1+jai@users.noreply.github.com" };

describe("git identity for agent runs", () => {
  test("gh user with a public name and no public email gets the noreply address", () => {
    const run = () => JSON.stringify({ login: "jai", name: "Jaime", id: 1, email: null });
    expect(ghIdentity(run)).toEqual(JAI);
  });

  test("gh user without a name falls back to the login", () => {
    const run = () => JSON.stringify({ login: "jai", name: null, id: 1, email: "j@x.io" });
    expect(ghIdentity(run)).toEqual({ name: "jai", email: "j@x.io" });
  });

  test("gh missing / logged out / garbage yields null", () => {
    expect(ghIdentity(() => "")).toBeNull();
    expect(ghIdentity(() => "not json")).toBeNull();
    expect(ghIdentity(() => JSON.stringify({ message: "Bad credentials" }))).toBeNull();
  });

  test("git config fallback needs both name and email", () => {
    expect(gitConfigIdentity((c) => (c.includes("user.name") ? "jai" : "j@x.io"))).toEqual({ name: "jai", email: "j@x.io" });
    expect(gitConfigIdentity((c) => (c.includes("user.name") ? "jai" : ""))).toBeNull();
  });

  test("exports author and committer", () => {
    expect(gitIdentityEnv({}, () => JAI)).toEqual({
      GIT_AUTHOR_NAME: JAI.name,
      GIT_AUTHOR_EMAIL: JAI.email,
      GIT_COMMITTER_NAME: JAI.name,
      GIT_COMMITTER_EMAIL: JAI.email,
    });
  });

  test("respects explicit env, opt-out and unknown identity", () => {
    expect(gitIdentityEnv({ GIT_AUTHOR_NAME: "me" }, () => JAI).GIT_AUTHOR_NAME).toBeUndefined();
    expect(gitIdentityEnv({ MINITUI_GIT_IDENTITY: "0" }, () => JAI)).toEqual({});
    expect(gitIdentityEnv({}, () => null)).toEqual({});
  });
});
