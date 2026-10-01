import changelog from "../../../../CHANGELOG.md?raw";
import { render } from "$lib/docs";

/** The repository's own CHANGELOG.md, rendered at build time: one source of truth, never stale. */
export const load = () => {
  const releases = changelog.split(/^## /m).slice(1).slice(0, 8);
  const items = releases.map((block) => {
    const [head, ...rest] = block.split("\n");
    const m = /^(\d+\.\d+\.\d+)\s+[—-]\s+(\d{4}-\d{2}-\d{2})/.exec(head ?? "");
    return { version: m?.[1] ?? head ?? "", date: m?.[2] ?? "", html: render(rest.join("\n")).html };
  });
  return { items };
};
