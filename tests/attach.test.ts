import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { escapeAttachPath, humanSize, localAttachmentText, parseAttachArgs, stageFile } from "../src/attach";

const root = mkdtempSync(join(tmpdir(), "minitui-attach-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
const PNG = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3, 4]);

describe("/attach arguments", () => {
  test("whitespace separates paths; quotes and escaped spaces keep one together", () => {
    expect(parseAttachArgs("a.png  b.md")).toEqual(["a.png", "b.md"]);
    expect(parseAttachArgs(`"my file.png" 'other one.md' plain\\ name.txt`)).toEqual(["my file.png", "other one.md", "plain name.txt"]);
    expect(parseAttachArgs("")).toEqual([]);
    expect(parseAttachArgs(escapeAttachPath("/tmp/a b/c'd.png"))).toEqual(["/tmp/a b/c'd.png"]);
  });
});

describe("staging a file", () => {
  test("the server's rules: type allowlist, non-empty, content matches the extension", () => {
    mkdirSync(join(root, "shots"), { recursive: true });
    writeFileSync(join(root, "shots", "screen.png"), PNG);
    writeFileSync(join(root, "notes.md"), "# notes\n");
    writeFileSync(join(root, "tool.exe"), "MZ");
    writeFileSync(join(root, "fake.png"), "<html>not a png</html>");
    writeFileSync(join(root, "empty.txt"), "");
    expect(stageFile("shots/screen.png", root)).toEqual({ path: join(root, "shots", "screen.png"), name: "screen.png", mime: "image/png", size: PNG.length });
    expect(stageFile(join(root, "notes.md"), "/elsewhere").mime).toBe("text/markdown");
    expect(stageFile("~/notes.md", "/elsewhere", root).path).toBe(join(root, "notes.md"));
    expect(() => stageFile("tool.exe", root)).toThrow(/tool\.exe: this type is not accepted \(accepted: \.png .*\.zip\)/);
    expect(() => stageFile("fake.png", root)).toThrow("fake.png: the content is not a valid .png");
    expect(() => stageFile("empty.txt", root)).toThrow("empty.txt: the file is empty");
    expect(() => stageFile("missing.png", root)).toThrow("missing.png: no such file");
    expect(() => stageFile("shots", root)).toThrow("shots: is a folder");
  });

  test("over the size limit is refused before any upload", () => {
    const big = join(root, "big.txt");
    writeFileSync(big, Buffer.alloc(15 * 1024 * 1024 + 1, 0x61));
    expect(() => stageFile(big, root)).toThrow("big.txt: 15.0 MB is over the 15 MB limit");
  });

  test("a local agent gets the files by path", () => {
    const text = localAttachmentText([{ path: "/w/a.png", name: "a.png", mime: "image/png", size: 2048 }]);
    expect(text).toBe("Attached files (on this machine; read them from these paths):\n- /w/a.png (image/png, 2 KB)");
    expect(humanSize(1536 * 1024)).toBe("1.5 MB");
  });
});
