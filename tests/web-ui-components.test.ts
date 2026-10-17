import { describe, expect, test } from "bun:test";
import { UI_TEMPLATES, extractUiComponents } from "../src/web/uiComponents";
import {
  validateCard,
  validateChart,
  validateForm,
  validateGallery,
  validateList,
  validateProgress,
  validateTable,
} from "../web/src/lib/ui/validate";

describe("ui-component extraction (server)", () => {
  test("one fence → spec, and the text comes out clean", () => {
    const text = 'Antes.\n```ui-component\n{"template":"card","props":{"title":"Hola"}}\n```\nDespués.';
    const { text: clean, specs } = extractUiComponents(text);
    expect(specs).toEqual([{ template: "card", props: { title: "Hola" } }]);
    expect(clean).toBe("Antes.\n\nDespués.");
  });

  test("broken JSON and unknown templates degrade to __fallback__, never throw", () => {
    const { specs } = extractUiComponents('```ui-component\n{roto\n```\n```ui-component\n{"template":"calendar","props":{}}\n```');
    expect(specs[0]!.template).toBe("__fallback__");
    expect((specs[0]!.props as { reason: string }).reason).toBe("json");
    expect(specs[1]!.template).toBe("__fallback__");
    expect((specs[1]!.props as { reason: string }).reason).toBe("template");
    expect((specs[1]!.props as { requested: string }).requested).toBe("calendar");
  });

  test("props must be an object; text without fences is untouched", () => {
    expect(extractUiComponents('```ui-component\n{"template":"card","props":[1]}\n```').specs[0]!.template).toBe("__fallback__");
    const plain = "mirá estos ```ticks``` normales";
    expect(extractUiComponents(plain)).toEqual({ text: plain, specs: [] });
  });

  test("the template set is closed", () => {
    expect([...UI_TEMPLATES].sort()).toEqual(["card", "chart", "form", "gallery", "list", "progress", "table"]);
  });
});

describe("browser-side prop validation", () => {
  test("card: whitelist and required title", () => {
    expect(validateCard({ title: "T", body: "B", evil: "<script>" })).toEqual({ ok: true, props: { title: "T", body: "B", tone: "neutral" } });
    expect(validateCard({}).ok).toBe(false);
  });

  test("chart: values must pair labels and be numbers", () => {
    expect(validateChart({ kind: "bar", labels: ["a", "b"], values: [1, 2] }).ok).toBe(true);
    expect(validateChart({ kind: "bar", labels: ["a", "b"], values: [1] }).ok).toBe(false);
    expect(validateChart({ kind: "pie", labels: ["a"], values: [1] }).ok).toBe(false);
    expect(validateChart({ kind: "line", labels: ["a"], values: ["x"] }).ok).toBe(false);
  });

  test("gallery: only attachment and http(s) sources pass", () => {
    expect(validateGallery({ images: ["/api/attachments/abcdabcdabcdabcd"] }).ok).toBe(true);
    expect(validateGallery({ images: ["https://x.y/i.png"] }).ok).toBe(true);
    expect(validateGallery({ images: ["javascript:alert(1)"] }).ok).toBe(false);
    expect(validateGallery({ images: ["data:text/html;base64,x"] }).ok).toBe(false);
  });

  test("form: fields bounded, select needs options", () => {
    const r = validateForm({ fields: [{ name: "ciudad", label: "Ciudad", type: "select", options: ["A", "B"], required: true }] });
    expect(r.ok).toBe(true);
    expect(validateForm({ fields: [{ name: "s", label: "S", type: "select" }] }).ok).toBe(false);
    expect(validateForm({ fields: [] }).ok).toBe(false);
  });

  test("list/table/progress bounds", () => {
    expect(validateList({ items: ["a", { title: "b", detail: "d" }] }).ok).toBe(true);
    expect(validateList({ items: [] }).ok).toBe(false);
    // A row longer than the header is CUT, not fatal: see "una fila mala no tira la tabla" below.
    const over = validateTable({ columns: ["a"], rows: [["1"], ["2", "extra"]] });
    expect(over.ok).toBe(true);
    expect(over.ok && over.props.rows).toEqual([["1"], ["2"]]);
    expect(over.ok && over.props.skipped).toBe(0);
    expect(validateTable({ columns: ["a", "b"], rows: [["1"]] }).ok).toBe(true);
    expect(validateProgress({ value: 150 }).ok).toBe(false);
    expect(validateProgress({ value: 42, label: "L" })).toEqual({ ok: true, props: { label: "L", value: 42, detail: undefined } });
  });
});
