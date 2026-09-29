/** Model switcher logic: grouping, search, custom ids and keyboard stepping. */
import { describe, expect, test } from "bun:test";
import { buildGroups, isValidModelId, matches, providerOf, shortName, step, toOption } from "../web/src/lib/models";

const CATALOGUE = [
  { id: "cliproxy/claude-opus-5-5", name: "n", description: "cli-proxy · Claude Opus 5.5" },
  { id: "cliproxy/claude-sonnet-5-5", name: "n", description: "cli-proxy · Claude Sonnet 5.5" },
  { id: "deepseek/deepseek-flash", name: "n", description: "DeepSeek flash (fast)" },
  { id: "rosetta/zai-glm/glm-5.3-flash", name: "n", description: "Rosetta · GLM 5.3 flash" },
];

describe("ids", () => {
  test("provider is the first segment, the name is the rest", () => {
    expect(providerOf("cliproxy/claude-opus-5-5")).toBe("cliproxy");
    expect(shortName("rosetta/zai-glm/glm-5.3-flash")).toBe("zai-glm/glm-5.3-flash");
    expect(providerOf("bare")).toBe("other");
    expect(shortName("bare")).toBe("bare");
  });
  test("only plain model-id tokens are valid", () => {
    for (const ok of ["openai/gpt-6-astra", "xiaomi/mimo-v2.6-pro", "a", "org/m:tag@1"]) expect(isValidModelId(ok)).toBe(true);
    for (const bad of ["", "two words", "a;rm -rf /", "$(x)", "a\nb", "x".repeat(200), "/lead"]) expect(isValidModelId(bad)).toBe(false);
  });
});

describe("search", () => {
  const opt = toOption(CATALOGUE[1]!);
  test("tokens match in any order, across id and description", () => {
    expect(matches(opt, "sonnet 5")).toBe(true);
    expect(matches(opt, "5 sonnet")).toBe(true);
    expect(matches(opt, "cli-proxy")).toBe(true);
    expect(matches(opt, "opus")).toBe(false);
    expect(matches(opt, "  ")).toBe(true);
  });
});

describe("buildGroups", () => {
  test("groups by provider, in catalogue order", () => {
    const { groups, flat } = buildGroups(CATALOGUE, "");
    expect(groups.map((g) => g.provider)).toEqual(["cliproxy", "deepseek", "rosetta"]);
    expect(groups[0]!.options).toHaveLength(2);
    expect(flat).toHaveLength(4);
  });
  test("filters, and drops empty groups", () => {
    const { groups } = buildGroups(CATALOGUE, "flash");
    expect(groups.map((g) => g.provider)).toEqual(["deepseek", "rosetta"]);
  });
  test("a typed id that matches nothing offers itself as the last option", () => {
    const { flat } = buildGroups(CATALOGUE, "acme/new-model-1");
    expect(flat.at(-1)).toMatchObject({ id: "acme/new-model-1", custom: true });
  });
  test("a bare search word that found models is not also offered as a custom id", () => {
    expect(buildGroups(CATALOGUE, "flash").flat.some((o) => o.custom)).toBe(false);
  });
  test("a bare word that matched nothing is offered, since it may be a real id", () => {
    expect(buildGroups(CATALOGUE, "gpt-9").flat).toEqual([expect.objectContaining({ id: "gpt-9", custom: true })]);
  });
  test("an exact catalogue id does not add a duplicate custom row", () => {
    const { flat } = buildGroups(CATALOGUE, "deepseek/deepseek-flash");
    expect(flat.filter((o) => o.id === "deepseek/deepseek-flash")).toHaveLength(1);
    expect(flat.some((o) => o.custom)).toBe(false);
  });
  test("an invalid typed id is never offered", () => {
    expect(buildGroups(CATALOGUE, "not a model; rm").flat).toHaveLength(0);
  });
  test("the current model is pinned even when the catalogue does not know it", () => {
    const { flat } = buildGroups(CATALOGUE, "", "legacy/old-model");
    expect(flat[0]).toMatchObject({ id: "legacy/old-model", custom: true });
  });
  test("an empty catalogue still yields a usable picker for a typed id", () => {
    const { flat } = buildGroups([], "x/y");
    expect(flat).toEqual([expect.objectContaining({ id: "x/y" })]);
  });
});

describe("step", () => {
  test("wraps at both ends", () => {
    expect(step(0, -1, 3)).toBe(2);
    expect(step(2, 1, 3)).toBe(0);
    expect(step(1, 1, 3)).toBe(2);
  });
  test("from nothing selected, down goes first and up goes last", () => {
    expect(step(-1, 1, 3)).toBe(0);
    expect(step(-1, -1, 3)).toBe(2);
  });
  test("an empty list has no position", () => {
    expect(step(0, 1, 0)).toBe(-1);
  });
});
