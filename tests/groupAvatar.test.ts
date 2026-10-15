import { describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { basename } from "node:path";
import { avatarFileFor } from "../src/channels/groupAvatar";
import { avatarSrc } from "../web/src/lib/avatar";
import { setGroupPicture } from "../src/channels/groupPicture";

describe("group avatars", () => {
  test("every session maps to an existing square avatar asset", () => {
    for (const id of ["wa-jaimetest-0f1e2d3c", "", "x", "привет-🤖-12345678"]) {
      const file = avatarFileFor(id);
      expect(file).toBeDefined();
      expect(existsSync(file!)).toBe(true);
    }
  });

  test("server and web mappings agree (same id → same face)", () => {
    for (const id of ["wa-a-aaaaaaaa", "wa-b-bbbbbbbb", "sess-3", "sess-4", "sess-5"]) {
      const web = basename(avatarSrc(id)).replace(/\.svg$/, "");
      expect(avatarFileFor(id)).toContain(`${web}.jpg`);
    }
  });

  test("setGroupPicture uploads multipart with the groupJid", async () => {
    const calls: { url: string; init: RequestInit }[] = [];
    const original = globalThis.fetch;
    globalThis.fetch = (async (url: any, init: any) => {
      calls.push({ url: String(url), init });
      return new Response("{}" as any, { status: 200 } as any);
    }) as typeof fetch;
    try {
      const result = await setGroupPicture("http://evo.test/", "inst-1", "tok-3", "1202@g.us", avatarFileFor("wa-jaimetest-0f1e2d3c")!);
      expect(result.ok).toBe(true);
      expect(calls.length).toBe(1);
      expect(calls[0]!.url).toBe("http://evo.test/group/updateGroupPicture/inst-1?groupJid=1202%40g.us");
      const body = calls[0]!.init.body as FormData;
      expect(body).toBeInstanceOf(FormData);
      expect(body.get("groupJid")).toBe("1202@g.us");
      const file = body.get("file") as File;
      expect(file.type).toBe("image/jpeg");
    } finally {
      globalThis.fetch = original;
    }
  });
});
