/**
 * The docker image must NOT be a sandbox: agent sessions inside the container
 * run `gh` and `ssh` exactly like the terminal outside it.
 *
 * Two baked pieces make that true and both are easy to regress in a rebuild:
 *
 *  1. `gh` at `/usr/bin/gh` — the bind-mounted ~/.gitconfig wires git's
 *     credential helper to `!/usr/bin/gh auth git-credential`, an absolute
 *     path. If gh lands elsewhere (or disappears), `git push`/`gh pr create`
 *     fail inside the container with "could not read Username" while the same
 *     command works outside — the classic sandbox symptom.
 *  2. `openssh-client` — the ssh config, keys and known_hosts of the host ride
 *     the /home bind at identical paths (~/.ssh), so the only missing piece is
 *     the client binary itself. Without it, `ssh kraken` (or any Host alias of
 *     ~/.ssh/config) is "command not found" inside the container.
 *
 * This test pins both against the shipped Dockerfile so a future tool-list
 * cleanup cannot silently turn the container back into a sandbox.
 */
import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const dockerfile = readFileSync(join(import.meta.dir, "..", "Dockerfile"), "utf8");
const compose = readFileSync(join(import.meta.dir, "..", "docker-compose.yml"), "utf8");
const runtimeStage = dockerfile.slice(dockerfile.indexOf("Stage 2"));

describe("Dockerfile runtime stage: host parity for gh and ssh", () => {
  test("gh is baked, from the official cli/cli tarball, pinned", () => {
    expect(runtimeStage).toContain("ARG GH_VERSION=");
    expect(runtimeStage).toMatch(
      /https:\/\/github\.com\/cli\/cli\/releases\/download\/v\$\{GH_VERSION\}\/gh_\$\{GH_VERSION\}_linux_/,
    );
  });

  test("gh lands at /usr/bin/gh — the exact path the mounted gitconfig calls", () => {
    // ~/.gitconfig (home bind): credential.https://github.com.helper=!/usr/bin/gh auth git-credential
    expect(runtimeStage).toMatch(/install -m755 .*\/bin\/gh" \/usr\/bin\/gh/);
  });

  test("openssh-client is installed so ~/.ssh of the host is usable", () => {
    // ssh config, keys and known_hosts arrive via /home/jaime:/home/jaime;
    // the binary is the only thing the image must contribute.
    expect(runtimeStage).toMatch(/\bopenssh-client\b/);
  });

  test("the compose contract keeps the home bind that carries ~/.ssh and ~/.config/gh", () => {
    // Without this mount the baked tools have no credentials to work with.
    expect(compose).toContain("/home/jaime:/home/jaime");
    expect(compose).toContain("NOT a sandbox");
  });
});
