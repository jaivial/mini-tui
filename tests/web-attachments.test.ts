import { describe, expect, test, beforeAll, afterAll } from "bun:test";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ATTACH_MAX_BYTES, AttachError, attachmentAgentBlock, attachmentLinksLine, getAttachment, inlineWorkspaceImages, listAttachments, registerFile, safeName, saveAttachment } from "../src/web/attachments";
import { collapseSkillPrompt } from "../src/skills";

const DIR = mkdtempSync(join(tmpdir(), "mini-attach-"));

beforeAll(() => {
  process.env.MINITUI_ATTACHMENTS_DIR = DIR;
});

describe("attachment store", () => {
  test("saves an allowed file and reads it back by id", () => {
    const att = saveAttachment("foto equipo.png", new Uint8Array([137, 80, 78, 71, 1, 2, 3]));
    expect(att.name).toBe("foto equipo.png");
    expect(att.mime).toBe("image/png");
    expect(att.size).toBe(7);
    expect(att.url).toBe(`/api/attachments/${att.id}`);
    expect(att.path.startsWith(DIR)).toBe(true);
    const back = getAttachment(att.id);
    expect(back?.path).toBe(att.path);
    expect(listAttachments().some((a) => a.id === att.id)).toBe(true);
  });

  test("refuses a disallowed type and an empty file", () => {
    expect(() => saveAttachment("evil.svg", new Uint8Array([1]))).toThrow(AttachError);
    expect(() => saveAttachment("no-ext", new Uint8Array([1]))).toThrow(AttachError);
    expect(() => saveAttachment("vacio.txt", new Uint8Array([]))).toThrow(AttachError);
  });

  test("refuses an oversized file with 413", () => {
    try {
      saveAttachment("big.png", new Uint8Array(ATTACH_MAX_BYTES + 1));
      expect.unreachable();
    } catch (error) {
      expect((error as AttachError).status).toBe(413);
    }
  });

  test("an id that is not one of ours never resolves", () => {
    expect(getAttachment("../../etc/passwd")).toBeNull();
    expect(getAttachment("zzzzzzzzzzzzzzzz")).toBeNull();
  });

  test("safeName strips paths and control characters", () => {
    expect(safeName("../../etc/passwd")).toBe("passwd");
    expect(safeName("a\u0000b.png")).toBe("ab.png");
    expect(safeName("")).toBe("file");
  });

  test("registerFile copies an existing image once and refuses the rest", () => {
    const img = join(DIR, "made.png");
    writeFileSync(img, new Uint8Array([1, 2, 3, 4]));
    const first = registerFile(img);
    expect(first?.mime).toBe("image/png");
    expect(first?.path).not.toBe(img); // copied into the store
    const again = registerFile(img);
    expect(again?.id).toBe(first?.id);
    expect(registerFile(join(DIR, "missing.png"))).toBeNull();
    expect(registerFile(join(DIR, "notes.txt"))).toBeNull();
  });
});

describe("attachment prompt blocks", () => {
  const atts = [
    { id: "abcdabcdabcdabcd", name: "chart.png", mime: "image/png", size: 1234, path: "/tmp/x/chart.png", url: "/api/attachments/abcdabcdabcdabcd" },
  ];

  test("collapseSkillPrompt strips a trailing attachments block", () => {
    const task = `<skills>\n<skill name="a" path="/x/SKILL.md">\nbody\n</skill>\n</skills>\n\nFollow the skills above where the request references them ($name):\n${"haz algo"}\n\n${attachmentAgentBlock(atts)}`;
    expect(collapseSkillPrompt(task)).toBe("haz algo");
  });

  test("collapseSkillPrompt leaves plain prompts (with or without the block) intact", () => {
    expect(collapseSkillPrompt(("hola\n\n" + attachmentAgentBlock(atts)).trim())).toBe("hola");
    expect(collapseSkillPrompt("texto <attachments> sin cerrar se queda")).toBe("texto <attachments> sin cerrar se queda");
  });

  test("the transcript line: images inline, other files as download links", () => {
    const file = { id: "bbbbbbbbbbbbbbbb", name: "notas.txt", mime: "text/plain", size: 12, path: "/tmp/x/notas.txt", url: "/api/attachments/bbbbbbbbbbbbbbbb" };
    expect(attachmentLinksLine(atts)).toBe("![chart.png](/api/attachments/abcdabcdabcdabcd)");
    expect(attachmentLinksLine([file])).toBe("[notas.txt](/api/attachments/bbbbbbbbbbbbbbbb)");
  });

  test("inlineWorkspaceImages rewrites real workspace images, nothing else", () => {
    const img = join(DIR, "made-inline.png");
    writeFileSync(img, new Uint8Array([9, 9, 9]));
    // markdown image
    expect(inlineWorkspaceImages(`mira ![g](file://${encodeURI(img)}) y ya`, DIR)).toMatch(/^mira !\[g\]\(\/api\/attachments\/[0-9a-f]{16}\) y ya$/);
    // bare absolute path outside code spans
    const bare = inlineWorkspaceImages(`el gráfico: ${img}.`, DIR);
    expect(bare).toMatch(/^el gráfico: !\[made-inline\.png\]\(\/api\/attachments\/[0-9a-f]{16}\)\.$/);
    // inside backticks it is an example, not a file: untouched
    const quoted = "usa `" + img + "` aquí";
    expect(inlineWorkspaceImages(quoted, DIR)).toBe(quoted);
    // missing file: untouched
    expect(inlineWorkspaceImages("![g](/no/existe.png)", DIR)).toBe("![g](/no/existe.png)");
  });
});

afterAll(() => {
  rmSync(DIR, { recursive: true, force: true });
});
