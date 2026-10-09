//! Read-only tools that do not shell out (plan item 4, `docs/pi-speed-analysis.md` SS7).
//!
//! Today every read costs a shell spawn *and* a `cat` in the prompt; pi's `read` paginates and
//! states its budget in its own description (`tools/read.ts`). [`read_outcome`] is the same idea
//! in one place: the agent loop hands it a parsed `read` call, it opens the file directly (no
//! `/bin/sh`, no process, no timeout) and returns an observation in the environment's own shape,
//! so the same `observation_template` renders it as any command's result.
//!
//! Deliberately narrow:
//!
//! * **read-only.** `bash` stays the only mutating path (the analysis' quality-risk condition):
//!   there is no write/edit here, and an unknown tool is still a format error.
//! * **paginated.** `offset` (1-indexed line) and `limit` (lines), with a 2000-line / 50 KB cap
//!   (`truncateHead`'s two independent limits, whichever is hit first) and a continuation note
//!   that names the next `offset`, so the model never re-reads what it already has.
//! * **parity-safe.** The tool is offered only when mini-tui asks for the extra tools
//!   ([`crate::agents::tools_enabled`], the same `MINITUI_AGENT_TOOLS=1` gate the native agent
//!   tools use), so a plain run --- and the byte-for-byte parity suite --- sends exactly
//!   `bash` + `cu` as before. A `read` call that arrives without the gate is an unknown tool:
//!   the format error tells the model to use `bash`, which is the same recovery the Python
//!   agent already performs for any hallucinated tool name.

use crate::util::{get, Obj};
use serde_json::{json, Value};
use std::io::Read;
use std::path::{Path, PathBuf};

/// The read tool is offered to the model (and its calls routed to the direct reader) only when
/// mini-tui asks for the extra tools: the same gate as the native agent tools
/// (`MINITUI_AGENT_TOOLS=1`), so a plain run --- and the parity suite --- is unchanged.
pub fn read_enabled() -> bool {
    crate::agents::tools_enabled()
}

/// `truncate.ts`'s `DEFAULT_MAX_LINES`: the line half of the read budget.
pub const READ_MAX_LINES: usize = 2000;
/// `truncate.ts`'s `DEFAULT_MAX_BYTES` (50 KB): the byte half of the read budget.
pub const READ_MAX_BYTES: usize = 50 * 1024;
/// The largest file `read` will open at all, so a runaway path cannot allocate unbounded memory
/// before the budget has a chance to apply.
pub const READ_HARD_CAP: usize = 64 * 1024 * 1024;

pub const READ_DESCRIPTION: &str = "Read the contents of a text file directly (no shell, no process spawn). Use this instead of cat/sed -n/head/tail for reading files: it is faster and its output is bounded. Output is truncated to 2000 lines or 50KB (whichever is hit first); use offset/limit to page through a large file, and continue with offset until complete when you need the whole file. Reading never modifies anything; to change files use the edit or write tool.";

fn read_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to the file to read (relative or absolute)"},
            "offset": {"type": "number", "description": "Line number to start reading from (1-indexed)"},
            "limit": {"type": "number", "description": "Maximum number of lines to read"}
        },
        "required": ["path"]
    })
}

/// The `read` tool in the three wire shapes (chat, Responses, Anthropic Messages).
pub fn read_tool_chat() -> Value {
    json!({"type": "function", "function": {"name": "read", "description": READ_DESCRIPTION, "parameters": read_params()}})
}

pub fn read_tool_responses() -> Value {
    json!({"type": "function", "name": "read", "description": READ_DESCRIPTION, "parameters": read_params()})
}

pub fn read_tool_anthropic() -> Value {
    json!({"name": "read", "description": READ_DESCRIPTION, "input_schema": read_params()})
}

/// `splitLinesForCounting`: `split('\n')` with a trailing empty entry dropped, 0 for "".
fn count_lines(s: &str) -> usize {
    if s.is_empty() {
        return 0;
    }
    s.split('\n').count() - usize::from(s.ends_with('\n'))
}

/// Byte index where a prefix keeping `n` whole lines ends (each line's `\n` included).
fn start_of_line(content: &str, n: usize) -> usize {
    if n == 0 {
        return 0;
    }
    let mut seen = 0usize;
    for (i, b) in content.bytes().enumerate() {
        if b == b'\n' {
            seen += 1;
            if seen == n {
                return (i + 1).min(content.len());
            }
        }
    }
    content.len()
}

/// `truncateHead`: keep the first whole lines that fit both limits. Returns the page, which limit
/// stopped it (`None` = nothing truncated; `"first_line"` = the first line alone is over the byte
/// budget, so nothing is kept) and how many complete lines the page has.
fn truncate_head(content: &str, max_lines: usize, max_bytes: usize) -> (String, Option<&'static str>, usize) {
    let mut bytes = 0usize;
    let mut kept = 0usize;
    let mut end = 0usize;
    let mut at = 0usize;
    for line in content.split('\n') {
        if kept >= max_lines {
            return (content[..end].to_string(), Some("lines"), kept);
        }
        let sep = usize::from(at + line.len() < content.len());
        if bytes + line.len() + sep > max_bytes {
            let what = if kept == 0 { "first_line" } else { "bytes" };
            return (content[..end].to_string(), Some(what), kept);
        }
        bytes += line.len() + sep;
        kept += 1;
        at += line.len() + sep;
        end = at;
    }
    (content[..end].to_string(), None, kept)
}

fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

/// `resolveReadPathAsync`: absolute paths pass through, `~` expands, anything else resolves
/// against the run's working directory (the environment's `cwd`, not the process's).
pub fn resolve_path(path: &str, cwd: &str) -> PathBuf {
    let trimmed = path.trim();
    if let Some(rest) = trimmed.strip_prefix("~/") {
        let home = std::env::var("HOME").unwrap_or_default();
        return Path::new(&home).join(rest);
    }
    if trimmed == "~" {
        return PathBuf::from(std::env::var("HOME").unwrap_or_default());
    }
    if trimmed.starts_with('/') {
        return PathBuf::from(trimmed);
    }
    let base = if cwd.is_empty() { std::env::current_dir().unwrap_or_else(|_| PathBuf::from(".")) } else { PathBuf::from(cwd) };
    base.join(trimmed)
}

fn arg_num(args: &Value, key: &str) -> Option<i64> {
    match args.get(key) {
        Some(Value::Number(n)) => n.as_f64().map(|f| f as i64),
        Some(Value::String(s)) => s.trim().parse().ok(),
        _ => None,
    }
}

fn io_message(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "no such file or directory".into(),
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        _ => e.to_string(),
    }
}

/// One page of one file: the text the model sees plus the `extra` fields the trajectory records
/// (`path`, `offset`, `lines`, `total_lines`). `error` is set when the page is a failure the model
/// must see as one (missing file, offset past the end, ...).
pub struct ReadPage {
    pub text: String,
    pub extra: Obj,
    pub error: Option<String>,
}

fn failed(path: &str, extra: Obj, text: String) -> ReadPage {
    let error = format!("read {path}: {text}");
    ReadPage { text, extra, error: Some(error) }
}

pub fn read_file(path: &str, offset: Option<i64>, limit: Option<i64>, cwd: &str) -> ReadPage {
    let shown = path.trim().to_string();
    let mut extra = Obj::new();
    extra.insert("path".into(), json!(shown));
    let abs = resolve_path(path, cwd);
    let meta = match std::fs::metadata(&abs) {
        Ok(m) => m,
        Err(e) => return failed(&shown, extra, format!("cannot read '{shown}': {}", io_message(&e))),
    };
    if meta.is_dir() {
        return failed(&shown, extra, format!("'{shown}' is a directory (use bash ls to list it)"));
    }
    let size = meta.len() as usize;
    if size > READ_HARD_CAP {
        return failed(&shown, extra, format!("'{shown}' is {} and over the {} read cap; use bash to split it first", format_size(size), format_size(READ_HARD_CAP)));
    }
    let mut raw = Vec::with_capacity(size.min(2 * READ_MAX_BYTES));
    if let Err(e) = std::fs::File::open(&abs).and_then(|mut f| f.read_to_end(&mut raw)) {
        return failed(&shown, extra, format!("cannot read '{shown}': {}", io_message(&e)));
    }
    // Lossy on purpose: a binary file degrades to replacement characters instead of failing the
    // page. The budget counts the decoded text, which is what the model is charged for.
    let text = String::from_utf8_lossy(&raw).into_owned();
    let all_lines = count_lines(&text);
    let start_line = match offset {
        Some(o) if o > 1 => (o - 1) as usize,
        _ => 0,
    };
    extra.insert("offset".into(), json!(start_line + 1));
    if all_lines == 0 {
        extra.insert("lines".into(), json!(0));
        extra.insert("total_lines".into(), json!(0));
        return ReadPage { text: String::new(), extra, error: None };
    }
    if start_line >= all_lines {
        return failed(&shown, extra, format!("offset {} is beyond the end of file '{shown}' ({all_lines} lines total)", start_line + 1));
    }
    let selected = &text[start_of_line(&text, start_line)..];
    let selected_lines = count_lines(selected);
    // A user limit is honoured first (pi's order); the truncation budget applies to what it left.
    let (page, stopped_by, output_lines) = match limit.filter(|l| *l > 0).map(|l| l as usize) {
        Some(l) => {
            let keep = l.min(selected_lines);
            let page = selected[..start_of_line(selected, keep)].to_string();
            if keep < selected_lines {
                (page, Some("limit"), keep)
            } else {
                let (p, what, n) = truncate_head(&page, READ_MAX_LINES, READ_MAX_BYTES);
                (p, what.or(Some("full")), n)
            }
        }
        None => truncate_head(selected, READ_MAX_LINES, READ_MAX_BYTES),
    };
    extra.insert("lines".into(), json!(output_lines));
    extra.insert("total_lines".into(), json!(all_lines));
    let first = start_line + 1;
    let last = first + output_lines.saturating_sub(1);
    let note = match stopped_by {
        Some("first_line") => Some(format!(
            "\n\n[Line {first} alone is over the {} limit. Use bash: sed -n '{first}p' {shown} | head -c {}]",
            format_size(READ_MAX_BYTES),
            READ_MAX_BYTES
        )),
        Some("limit") => Some(format!("\n\n[Showing lines {first}-{last} of {all_lines} (limit hit). Use offset={} to continue.]", last + 1)),
        Some("lines") => Some(format!("\n\n[Showing lines {first}-{last} of {all_lines}. Use offset={} to continue.]", last + 1)),
        Some("bytes") => Some(format!(
            "\n\n[Showing lines {first}-{last} of {all_lines} ({} limit). Use offset={} to continue.]",
            format_size(READ_MAX_BYTES),
            last + 1
        )),
        _ => (start_line + output_lines < all_lines).then(|| {
            format!("\n\n[{} more lines in file. Use offset={} to continue.]", all_lines - start_line - output_lines, last + 1)
        }),
    };
    let mut out = page;
    if let Some(n) = note {
        out.push_str(&n);
    }
    ReadPage { text: out, extra, error: None }
}

/// The observation for one parsed `read` call: `{output, returncode, exception_info}` in the
/// environment's shape, with the read's own fields (`path`, `offset`, ...) under `extra` so they
/// land in the tool message's `extra` next to the usual observation bookkeeping.
pub fn read_outcome(args: &Value, cwd: &str) -> Value {
    let Some(path) = get(args, "path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
        return json!({
            "output": "read: missing required argument 'path'",
            "returncode": 2,
            "exception_info": "Missing 'path' argument in read tool call.",
        });
    };
    let page = read_file(path, arg_num(args, "offset"), arg_num(args, "limit"), cwd);
    let mut out = json!({
        "output": page.text,
        "returncode": if page.error.is_some() { 1 } else { 0 },
        "exception_info": "",
    });
    if let Some(e) = &page.error {
        out["exception_info"] = json!(e);
        out["extra"] = json!({"exception_type": "ReadError", "exception": e});
    }
    if !page.extra.is_empty() {
        let entry = out.as_object_mut().unwrap().entry("extra").or_insert_with(|| json!({}));
        if let Some(o) = entry.as_object_mut() {
            for (k, v) in page.extra {
                o.insert(k, v);
            }
        }
    }
    out
}

// ---- the tool list ----------------------------------------------------------------------

/// Append the `read` tool to a protocol's tool list when it is enabled. Offered beside `bash`
/// (and `cu`), never instead of it: `bash` stays the only mutating path.
pub fn with_read(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if read_enabled() {
        out.push(read_tool_chat());
    }
    out
}

pub fn with_read_anthropic(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if read_enabled() {
        out.push(read_tool_anthropic());
    }
    out
}

pub fn with_read_responses(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if read_enabled() {
        out.push(read_tool_responses());
    }
    out
}
