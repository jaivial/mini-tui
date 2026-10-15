/**
 * Strict prop validation for generative UI (the browser half of the protocol,
 * src/web/uiComponents.ts is the server half).
 *
 * Every template owns a whitelist: only the keys below, only these types, only
 * these bounds. Everything else is stripped; a prop that fails its type or bound
 * marks the whole component invalid → the caller renders the quiet fallback
 * instead. Nothing is ever evaluated and no raw HTML is rendered — a template
 * renders only the primitives it validates here.
 */

export interface Validated<T> {
  ok: true;
  props: T;
}
export interface Invalid {
  ok: false;
  reason: string;
}
export type Result<T> = Validated<T> | Invalid;

const ok = <T>(props: T): Result<T> => ({ ok: true, props });
const bad = (reason: string): Result<never> => ({ ok: false, reason });

/** Whitelisted key copy: anything not listed here never reaches the DOM. */
function pick(props: Record<string, unknown>, keys: string[]): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const key of keys) if (key in props) out[key] = props[key];
  return out;
}

function str(v: unknown, max: number): string | null {
  return typeof v === "string" ? v.slice(0, max) : null;
}

function bounded(v: unknown, min: number, max: number): number | null {
  return typeof v === "number" && Number.isFinite(v) ? Math.min(max, Math.max(min, v)) : null;
}

function strArray(v: unknown, maxItems: number, maxLen: number): string[] | null {
  if (!Array.isArray(v)) return null;
  const out: string[] = [];
  for (const item of v.slice(0, maxItems)) {
    const s = str(item, maxLen);
    if (s === null) return null;
    out.push(s);
  }
  return out;
}

// ---- card
export interface CardProps {
  title: string;
  body?: string;
  tone: "neutral" | "info" | "ok" | "warn";
}
export function validateCard(props: Record<string, unknown>): Result<CardProps> {
  const title = str(props.title, 200);
  if (!title) return bad("card necesita title");
  const tone = ["neutral", "info", "ok", "warn"].includes(props.tone as string) ? (props.tone as CardProps["tone"]) : "neutral";
  return ok({ title, body: str(props.body, 2000) ?? undefined, tone });
}

// ---- list
export interface ListProps {
  title?: string;
  items: { title: string; detail?: string }[];
}
export function validateList(props: Record<string, unknown>): Result<ListProps> {
  const raw = props.items;
  if (!Array.isArray(raw) || !raw.length) return bad("list necesita items");
  const items: ListProps["items"] = [];
  for (const item of raw.slice(0, 50)) {
    if (typeof item === "string") {
      items.push({ title: item.slice(0, 300) });
      continue;
    }
    if (typeof item === "object" && item !== null) {
      const title = str((item as Record<string, unknown>).title, 300);
      if (!title) return bad("list item sin title");
      items.push({ title, detail: str((item as Record<string, unknown>).detail, 500) ?? undefined });
      continue;
    }
    return bad("list item inválido");
  }
  return ok({ title: str(props.title, 200) ?? undefined, items });
}

// ---- table
export interface TableProps {
  columns: string[];
  rows: string[][];
}
export function validateTable(props: Record<string, unknown>): Result<TableProps> {
  const columns = strArray(props.columns, 8, 60);
  if (!columns || !columns.length) return bad("table necesita columns");
  const raw = props.rows;
  if (!Array.isArray(raw)) return bad("table necesita rows");
  const rows: string[][] = [];
  for (const row of raw.slice(0, 60)) {
    if (!Array.isArray(row) || row.length > columns.length) return bad("table row inválida");
    const cells = strArray(row, columns.length, 300)!;
    if (!cells) return bad("table row inválida");
    while (cells.length < columns.length) cells.push("");
    rows.push(cells);
  }
  return ok({ columns, rows });
}

// ---- chart
export interface ChartProps {
  kind: "bar" | "line";
  title?: string;
  labels: string[];
  values: number[];
  unit?: string;
}
export function validateChart(props: Record<string, unknown>): Result<ChartProps> {
  const kind = props.kind === "line" ? "line" : props.kind === "bar" ? "bar" : null;
  if (!kind) return bad("chart kind debe ser bar|line");
  const labels = strArray(props.labels, 60, 40);
  if (!labels || !labels.length) return bad("chart necesita labels");
  if (!Array.isArray(props.values) || props.values.length !== labels.length) return bad("chart values debe emparejar labels");
  const values: number[] = [];
  for (const v of props.values.slice(0, 60)) {
    const n = bounded(v, -1e9, 1e9);
    if (n === null) return bad("chart value no numérico");
    values.push(n);
  }
  return ok({ kind, title: str(props.title, 200) ?? undefined, labels, values, unit: str(props.unit, 8) ?? undefined });
}

// ---- progress
export interface ProgressProps {
  label?: string;
  value: number;
  detail?: string;
}
export function validateProgress(props: Record<string, unknown>): Result<ProgressProps> {
  if (typeof props.value !== "number" || !Number.isFinite(props.value) || props.value < 0 || props.value > 100) {
    return bad("progress necesita value 0-100");
  }
  const value = props.value;
  return ok({ label: str(props.label, 200) ?? undefined, value, detail: str(props.detail, 300) ?? undefined });
}

// ---- gallery
export interface GalleryProps {
  title?: string;
  images: { src: string; alt: string }[];
}
/** Only served attachments and plain http(s) URLs: `javascript:` y compañía no pasan. */
function safeSrc(v: unknown): string | null {
  const s = str(v, 600);
  if (!s) return null;
  if (s.startsWith("/api/attachments/") || /^https?:\/\//.test(s)) return s;
  return null;
}
export function validateGallery(props: Record<string, unknown>): Result<GalleryProps> {
  const raw = props.images;
  if (!Array.isArray(raw) || !raw.length) return bad("gallery necesita images");
  const images: GalleryProps["images"] = [];
  for (const item of raw.slice(0, 24)) {
    if (typeof item === "object" && item !== null) {
      const src = safeSrc((item as Record<string, unknown>).src);
      if (!src) return bad("gallery image src no permitido");
      images.push({ src, alt: str((item as Record<string, unknown>).alt, 200) ?? "" });
      continue;
    }
    const src = safeSrc(item);
    if (!src) return bad("gallery image src no permitido");
    images.push({ src, alt: "" });
  }
  return ok({ title: str(props.title, 200) ?? undefined, images });
}

// ---- form
export interface FormField {
  name: string;
  label: string;
  type: "text" | "number" | "date" | "select" | "checkbox";
  required: boolean;
  placeholder?: string;
  options?: string[];
}
export interface FormProps {
  title?: string;
  fields: FormField[];
  submitLabel: string;
}
export function validateForm(props: Record<string, unknown>): Result<FormProps> {
  const raw = props.fields;
  if (!Array.isArray(raw) || !raw.length) return bad("form necesita fields");
  const fields: FormField[] = [];
  for (const item of raw.slice(0, 10)) {
    if (typeof item !== "object" || item === null) return bad("form field inválido");
    const f = item as Record<string, unknown>;
    const name = str(f.name, 60)?.replace(/[^a-zA-Z0-9_-]/g, "");
    if (!name) return bad("form field sin name");
    const label = str(f.label, 120) ?? name;
    const type = ["text", "number", "date", "select", "checkbox"].includes(f.type as string) ? (f.type as FormField["type"]) : "text";
    const options = type === "select" ? (strArray(f.options, 20, 100) ?? undefined) : undefined;
    if (type === "select" && (!options || !options.length)) return bad("select sin options");
    fields.push({ name, label, type, required: f.required === true, placeholder: str(f.placeholder, 120) ?? undefined, options });
  }
  return ok({ title: str(props.title, 200) ?? undefined, fields, submitLabel: str(props.submitLabel, 40) ?? "Enviar" });
}
