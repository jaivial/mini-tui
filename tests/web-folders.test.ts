/**
 * The folder picker's listing, for this machine and for a remote host. The remote script is real shell,
 * so it is run through `bash -s` here exactly as ssh would run it, against awkward names.
 */
import { afterAll, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FOLDER_LIMIT, FolderError, expandLocal, listLocal, parseRemoteListing, remoteListScript } from "../src/web/folders";

const root = mkdtempSync(join(tmpdir(), "minitui-folders-"));
afterAll(() => {
  try {
    chmodSync(join(root, "locked"), 0o755);
  } catch {}
  rmSync(root, { recursive: true, force: true });
});
mkdirSync(join(root, "api", ".git"), { recursive: true });
mkdirSync(join(root, "web"));
mkdirSync(join(root, ".cache"));
mkdirSync(join(root, "with space"));
mkdirSync(join(root, "it's quoted"));
mkdirSync(join(root, "$(touch pwned)"));
mkdirSync(join(root, "Proj10"));
mkdirSync(join(root, "Proj9"));
writeFileSync(join(root, "README.md"), "a file, not a folder");
symlinkSync(join(root, "web"), join(root, "web-link"));
symlinkSync(join(root, "nowhere"), join(root, "dangling"));
mkdirSync(join(root, "locked"));
chmodSync(join(root, "locked"), 0o000);

const runRemote = (path: string, home = root) =>
  Bun.spawnSync({ cmd: ["bash", "-s"], stdin: Buffer.from(remoteListScript(path)), env: { ...process.env, HOME: home } }).stdout.toString();

const names = (l: { entries: { name: string }[] }) => l.entries.map((e) => e.name);
const WANT = ["api", "it's quoted", "Proj9", "Proj10", "web", "web-link", "with space", "$(touch pwned)", "locked"];

describe("local listing", () => {
  test("only folders (links to folders too), visible first, numbers in order, git marked", () => {
    const l = listLocal(root);
    expect(names(l).sort()).toEqual([...WANT, ".cache"].sort());
    expect(names(l).at(-1)).toBe(".cache"); // hidden ones last
    expect(names(l).indexOf("Proj9")).toBeLessThan(names(l).indexOf("Proj10"));
    expect(l.entries.find((e) => e.name === "api")!.git).toBe(true);
    expect(l.entries.find((e) => e.name === "web")!.git).toBe(false);
    expect(l.parent).toBe(join(root, ".."));
  });
  test("~, relative and .. paths resolve to the real folder", () => {
    expect(expandLocal("", root)).toBe(root);
    expect(expandLocal("~/api", root)).toBe(join(root, "api"));
    expect(expandLocal("api", root)).toBe(join(root, "api"));
    expect(listLocal("api/..", root).path).toBe(listLocal(root).path);
    expect(listLocal(join(root, "web-link")).path).toBe(listLocal(join(root, "web")).path); // symlink resolved
  });
  test("the root has no parent", () => {
    expect(listLocal("/").parent).toBeNull();
  });
  test("a missing path, a file and a folder you cannot open are errors with a status", () => {
    const err = (p: string) => { try { listLocal(p); return null; } catch (e) { return e as FolderError; } };
    expect(err(join(root, "nope"))?.status).toBe(404);
    expect(err(join(root, "README.md"))?.status).toBe(400);
    if (process.getuid?.() !== 0) expect(err(join(root, "locked"))?.status).toBe(403);
  });
  test("a huge folder is capped and says so", () => {
    const big = join(root, "big");
    mkdirSync(big);
    for (let i = 0; i < FOLDER_LIMIT + 5; i++) mkdirSync(join(big, `d${i}`));
    const l = listLocal(big);
    expect(l.entries.length).toBe(FOLDER_LIMIT);
    expect(l.truncated).toBe(true);
    rmSync(big, { recursive: true });
  });
});

describe("remote listing (the real script, through bash -s)", () => {
  test("lists the same folders as the local listing, awkward names intact", () => {
    const l = parseRemoteListing(runRemote(root));
    expect(names(l).sort()).toEqual([...WANT, ".cache"].sort());
    expect(l.entries.find((e) => e.name === "api")!.git).toBe(true);
    expect(l.home).toBe(root);
  });
  test("a name that looks like a command substitution is data, never run", () => {
    parseRemoteListing(runRemote(root));
    parseRemoteListing(runRemote(join(root, "$(touch pwned)")));
    expect(Bun.spawnSync({ cmd: ["ls", root] }).stdout.toString()).not.toContain("pwned\n");
    expect(Bun.file(join(root, "pwned")).size).toBe(0);
  });
  test("a path with quotes is passed through quoted", () => {
    expect(parseRemoteListing(runRemote(join(root, "it's quoted"))).path).toBe(join(root, "it's quoted"));
  });
  test("~ and relative paths use the remote $HOME", () => {
    expect(parseRemoteListing(runRemote("~")).path).toBe(listLocal(root).path);
    expect(parseRemoteListing(runRemote("~/api")).path).toBe(join(listLocal(root).path, "api"));
    expect(parseRemoteListing(runRemote("web")).path).toBe(join(listLocal(root).path, "web"));
  });
  test("missing, not-a-folder and no-permission come back as the same errors as local", () => {
    const err = (p: string) => { try { parseRemoteListing(runRemote(p)); return null; } catch (e) { return e as FolderError; } };
    expect(err(join(root, "nope"))?.status).toBe(404);
    expect(err(join(root, "README.md"))?.status).toBe(400);
    if (process.getuid?.() !== 0) expect(err(join(root, "locked"))?.status).toBe(403);
  });
  test("output that is not a listing (a login banner, garbage) is refused, not half-parsed", () => {
    expect(() => parseRemoteListing("Welcome to Ubuntu!\n")).toThrow(/not with a folder listing/);
    const l = parseRemoteListing("motd line\nPATH\t/srv\nHOME\t/home/x\n1\tapp\n0\t../escape\n0\ta/b\n");
    expect(names(l)).toEqual(["app"]);
    expect(l.entries[0]!.path).toBe("/srv/app");
    expect(l.parent).toBe("/");
    expect(parseRemoteListing("PATH\t/\nHOME\t/root\n0\tetc\n").entries[0]!.path).toBe("/etc");
  });
});

describe("picker labels", async () => {
  const { tildify, folderLabel, crumbs, recentFolders } = await import("../web/src/lib/folderPath");
  test("paths under home read with ~, others stay absolute", () => {
    expect(tildify("/home/me/work/api", "/home/me")).toBe("~/work/api");
    expect(tildify("/home/me", "/home/me")).toBe("~");
    expect(tildify("/home/meow", "/home/me")).toBe("/home/meow"); // not a prefix match on the name
    expect(tildify("/srv/app", "/home/me")).toBe("/srv/app");
  });
  test("a button shows the folder's own name", () => {
    expect(folderLabel("/home/me/work/api", "/home/me")).toBe("api");
    expect(folderLabel("/home/me", "/home/me")).toBe("~");
    expect(folderLabel("/", "/home/me")).toBe("/");
    expect(folderLabel("")).toBe("Default folder");
  });
  test("crumbs walk from ~ (or /) down to the folder", () => {
    expect(crumbs("/home/me/work/api", "/home/me")).toEqual([{ label: "~", path: "/home/me" }, { label: "work", path: "/home/me/work" }, { label: "api", path: "/home/me/work/api" }]);
    expect(crumbs("/srv/app", "/home/me")).toEqual([{ label: "/", path: "/" }, { label: "srv", path: "/srv" }, { label: "app", path: "/srv/app" }]);
    expect(crumbs("/", "/home/me")).toEqual([{ label: "/", path: "/" }]);
  });
  test("recent folders: newest first, no repeats, capped", () => {
    const h = (cwd: string) => ({ cwd } as any);
    expect(recentFolders([h("/a"), h("/b"), h("/a"), h(""), h("/c")], 2)).toEqual(["/a", "/b"]);
  });
});

describe("where a chat starts", async () => {
  const { buildRemoteScript } = await import("../src/web/ssh");
  test("a remote chat cds into the picked folder, quoted, and falls back to home only if it is gone", () => {
    const script = buildRemoteScript("hi", "/srv/odd name/it's");
    expect(script).toContain(`cd '/srv/odd name/it'\\''s' 2>/dev/null || cd "$HOME"`);
  });
  test("the remote script really starts in the folder (run through bash, as ssh would)", () => {
    const dir = mkdtempSync(join(tmpdir(), "minitui-remote-cwd-"));
    mkdirSync(join(dir, "odd name"));
    const script = buildRemoteScript("hi", join(dir, "odd name")).replace(/exec mini-tui /, 'echo "STARTED_IN=$(pwd -P)"; exit 0; : ');
    const out = Bun.spawnSync({ cmd: ["bash", "-s"], stdin: Buffer.from(script) }).stdout.toString();
    expect(out.trim()).toBe(`STARTED_IN=${listLocal(join(dir, "odd name")).path}`);
    rmSync(dir, { recursive: true, force: true });
  });
});
