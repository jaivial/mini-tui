import { describe, expect, test } from "bun:test";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { makeCookieValue, verifyCookie, verifyHtpasswd } from "../src/web/auth";

const SECRET = Buffer.from("0123456789abcdef0123456789abcdef", "utf8");

describe("htpasswd (apr1)", () => {
  // Vector generated with `openssl passwd -apr1 -salt testsalt testpw`.
  const file = () => {
    const path = join(mkdtempSync(join(tmpdir(), "minitui-auth-")), "htpasswd");
    writeFileSync(path, "jaime:$apr1$testsalt$mOHSAYP94p3YNpbcCDQME/\n# comment\n\n");
    return path;
  };

  test("the right user and password verify", () => {
    expect(verifyHtpasswd(file(), "jaime", "testpw")).toBe(true);
  });
  test("a wrong password does not", () => {
    expect(verifyHtpasswd(file(), "jaime", "testpw ")).toBe(false);
    expect(verifyHtpasswd(file(), "jaime", "")).toBe(false);
  });
  test("an unknown user does not (and costs about the same)", () => {
    expect(verifyHtpasswd(file(), "ghost", "testpw")).toBe(false);
  });
});

describe("the session cookie", () => {
  test("a made cookie verifies back to its claims", () => {
    const value = makeCookieValue(SECRET, "abc123", Math.floor(Date.now() / 1000) + 3600);
    const claims = verifyCookie(SECRET, value);
    expect(claims?.nonce).toBe("abc123");
    expect(claims?.exp).toBeGreaterThan(Math.floor(Date.now() / 1000));
  });
  test("any tampering (payload or signature) voids it", () => {
    const value = makeCookieValue(SECRET, "abc123", Math.floor(Date.now() / 1000) + 3600);
    const [body, sig] = [value.slice(0, value.lastIndexOf(".")), value.slice(value.lastIndexOf(".") + 1)];
    expect(verifyCookie(SECRET, `${body}x.${sig}`)).toBeNull();
    expect(verifyCookie(SECRET, `${body}.${sig!.slice(0, -1)}0`)).toBeNull();
    expect(verifyCookie(Buffer.from("another-secret-another-secret!!"), value)).toBeNull();
  });
  test("an expired cookie is expired, not invalid", () => {
    const past = Math.floor(Date.now() / 1000) - 10;
    expect(verifyCookie(SECRET, makeCookieValue(SECRET, "abc123", past))).toBeNull();
  });
  test("garbage is not a cookie", () => {
    expect(verifyCookie(SECRET, "")).toBeNull();
    expect(verifyCookie(SECRET, "v1")).toBeNull();
    expect(verifyCookie(SECRET, "v1.abc.no-sig")).toBeNull();
  });
});
