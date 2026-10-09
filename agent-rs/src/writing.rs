//! Native file-writing tools (`write` / `edit`) and the `code` tool that batches them.
//!
//! `docs/pi-vs-mini-benchmark.md` SS3 measured the round-1 gap: with `bash` as the only writing
//! path mini made 2.18x more model calls and generated 4.78x more output tokens than pi, because
//! every edit re-emitted the whole file inside a heredoc and every quoting/encoding slip cost a
//! repair step (`t4_refactor`: 285 s of model time repairing its own `sed`). These tools are that
//! doc's #1 ranked fix: `edit` sends only `oldText`/`newText`, `write` sends the file once, and
//! neither spends output tokens on shell quoting.
//!
//! The shape follows pi's `tools/write.ts` / `tools/edit.ts` (local checkout `~/pi-mono`):
//!
//! * `write` creates parent directories and overwrites; the observation is one line, never the
//!   content back.
//! * `edit` takes `edits: [{oldText, newText}]` (a bare `oldText`/`newText` pair is accepted, as
//!   pi's `prepareEditArguments` accepts it, and so is a JSON-string `edits`). Every `oldText`
//!   must match a unique, non-overlapping region of the **original** file; CRLF is normalised to
//!   LF for matching and restored on write; a fuzzy pass (trailing whitespace, smart quotes,
//!   Unicode dashes and spaces) rescues a near miss. The error wording is pi's own, because that
//!   wording is what teaches the model to send a tighter `oldText` instead of giving up.
//! * both carry a small unified diff under `extra.diff`, so the model --- and the human reading
//!   the trajectory --- can see what changed without re-reading the file.
//!
//! The `code` tool is mini's equivalent of pi's codemode (`https://pi.dev/docs/latest/codemode`):
//! a script that calls the other tools, so a read + edit + edit + verify sequence costs **one**
//! model call instead of four. Pi runs model-written JavaScript in a QuickJS sandbox where
//! `tools.<name>(args)` is the only door out; mini evaluates Rhai (the same sandboxed interpreter
//! `mini-agent-rs repl` uses) where `read`/`write`/`edit`/`bash` are the only doors out. Only the
//! script's output reaches the model. See [`code_outcome`].

use crate::tools::{resolve_path, READ_HARD_CAP};
use crate::util::{get, Obj};
use serde_json::{json, Value};

/// Offered whenever the read tool is (the same `MINITUI_AGENT_TOOLS=1` gate mini-tui sets), so a
/// bare `mini-agent-rs` run --- and the byte-for-byte parity suite --- still sends exactly
/// `bash` + `cu`.
pub fn write_enabled() -> bool {
    crate::agents::tools_enabled()
}

/// `tools/write.ts`'s description, with the token argument spelled out.
pub const WRITE_DESCRIPTION: &str = "Write content to a file. Creates the file (and parent directories) if it doesn't exist, overwrites if it does. Use this for new files or complete rewrites; for targeted changes to an existing file use edit, which costs far fewer tokens.";
/// `tools/edit.ts`'s description, plus the instruction that moves traffic off `sed`/heredoc.
pub const EDIT_DESCRIPTION: &str = "Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes. DEFAULT writing path for existing files: no shell quoting, and only the changed text is generated (a heredoc re-emits the whole file).";
/// The codemode-equivalent: pi's codemode description, adapted to Rhai and mini's tools.
pub const CODE_DESCRIPTION: &str = "Run a Rhai script that calls the other tools (read, write, edit, edit_many, bash) and returns only what it prints. Batch a whole read->edit->edit->verify sequence into ONE tool call instead of several round trips; filter large outputs before they reach you. The sandbox has no filesystem, network or process of its own --- tools are the only doors out. Available: read(path), read(path, offset), read(path, offset, limit), write(path, content), edit(path, old_text, new_text), edit_many(path, [[old,new],...]), bash(cmd), reads([p1,p2,...]) (parallel file reads), print(x), len(x), lines(s), grep(s, regex), join(arr, sep), replace_all(s, from, to), slice(s, start, n), num(s), fmt2(x), top(map, k). Rhai: `let x = 5;` `s.contains(\"x\")` `for i in 0..n {}` `` `text ${x}` `` interpolation; end the script with the value to return.";

fn write_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to the file to write (relative or absolute)"},
            "content": {"type": "string", "description": "Content to write to the file"}
        },
        "required": ["path", "content"]
    })
}

fn edit_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "path": {"type": "string", "description": "Path to the file to edit (relative or absolute)"},
            "edits": {
                "type": "array",
                "description": "One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
                "items": {
                    "type": "object",
                    "properties": {
                        "oldText": {"type": "string", "description": "Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call."},
                        "newText": {"type": "string", "description": "Replacement text for this targeted edit."}
                    },
                    "required": ["oldText", "newText"]
                }
            },
            "oldText": {"type": "string", "description": "Single-edit shorthand: the same as edits: [{oldText, newText}]."},
            "newText": {"type": "string", "description": "Single-edit shorthand: the same as edits: [{oldText, newText}]."}
        },
        "required": ["path"]
    })
}

fn code_params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "code": {"type": "string", "description": "Rhai script (the body of a function). Tool calls are real: calls made before a failure are not undone."}
        },
        "required": ["code"]
    })
}

pub fn write_tool_chat() -> Value {
    json!({"type": "function", "function": {"name": "write", "description": WRITE_DESCRIPTION, "parameters": write_params()}})
}
pub fn write_tool_responses() -> Value {
    json!({"type": "function", "name": "write", "description": WRITE_DESCRIPTION, "parameters": write_params()})
}
pub fn write_tool_anthropic() -> Value {
    json!({"name": "write", "description": WRITE_DESCRIPTION, "input_schema": write_params()})
}

pub fn edit_tool_chat() -> Value {
    json!({"type": "function", "function": {"name": "edit", "description": EDIT_DESCRIPTION, "parameters": edit_params()}})
}
pub fn edit_tool_responses() -> Value {
    json!({"type": "function", "name": "edit", "description": EDIT_DESCRIPTION, "parameters": edit_params()})
}
pub fn edit_tool_anthropic() -> Value {
    json!({"name": "edit", "description": EDIT_DESCRIPTION, "input_schema": edit_params()})
}

pub fn code_tool_chat() -> Value {
    json!({"type": "function", "function": {"name": "code", "description": CODE_DESCRIPTION, "parameters": code_params()}})
}
pub fn code_tool_responses() -> Value {
    json!({"type": "function", "name": "code", "description": CODE_DESCRIPTION, "parameters": code_params()})
}
pub fn code_tool_anthropic() -> Value {
    json!({"name": "code", "description": CODE_DESCRIPTION, "input_schema": code_params()})
}

/// Append the writing tools (`write`, `edit`) and the batching `code` tool when they are enabled.
pub fn with_writing(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if write_enabled() {
        out.push(write_tool_chat());
        out.push(edit_tool_chat());
        out.push(code_tool_chat());
    }
    out
}
pub fn with_writing_anthropic(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if write_enabled() {
        out.push(write_tool_anthropic());
        out.push(edit_tool_anthropic());
        out.push(code_tool_anthropic());
    }
    out
}
pub fn with_writing_responses(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if write_enabled() {
        out.push(write_tool_responses());
        out.push(edit_tool_responses());
        out.push(code_tool_responses());
    }
    out
}

// ---- the observations -------------------------------------------------------------------

/// One observation in the environment's own `{output, returncode, exception_info}` shape, so the
/// `observation_template` renders a write/edit exactly like a command's result. A failure also
/// becomes `exception_info`, which is how a failed command is shown today.
fn observation(output: String, error: bool, extra: Obj) -> Value {
    let mut o = json!({
        "output": output,
        "returncode": i64::from(error),
        "exception_info": "",
    });
    if error {
        o["exception_info"] = json!(output);
        let mut e = extra;
        e.insert("exception_type".into(), json!("ToolError"));
        e.insert("exception".into(), json!(output));
        o["extra"] = Value::Object(e);
    } else if !extra.is_empty() {
        o["extra"] = Value::Object(extra);
    }
    o
}

fn io_message(e: &std::io::Error) -> String {
    match e.kind() {
        std::io::ErrorKind::NotFound => "no such file or directory".into(),
        std::io::ErrorKind::PermissionDenied => "permission denied".into(),
        _ => e.to_string(),
    }
}

/// `splitBom`: a leading UTF-8 BOM is not part of the text the model matched.
fn split_bom(raw: &str) -> (String, &str) {
    match raw.strip_prefix('\u{feff}') {
        Some(rest) => ("\u{feff}".to_string(), rest),
        None => (String::new(), raw),
    }
}

/// `detectLineEnding`: whichever ending appears first decides.
fn detect_line_ending(content: &str) -> &'static str {
    match (content.find("\r\n"), content.find('\n')) {
        (Some(c), Some(l)) if c < l => "\r\n",
        (Some(_), _) => "\r\n",
        _ => "\n",
    }
}

fn normalize_lf(s: &str) -> String {
    s.replace("\r\n", "\n").replace('\r', "\n")
}

/// `normalizeForFuzzyMatch`'s ASCII-reachable half: smart quotes, Unicode dashes/hyphens and the
/// special spaces become their ASCII equivalents, and trailing whitespace is dropped per line.
/// (A full NFKC table is not worth the dependency for the handful of cases a model hits; these
/// are the ones pi actually sees from GLM/Claude-class models.)
fn normalize_fuzzy(s: &str) -> String {
    let mapped: String = s.chars().map(|c| match c {
        '\u{2018}' | '\u{2019}' | '\u{201A}' | '\u{201B}' => '\'',
        '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{201F}' => '"',
        '\u{2010}' | '\u{2011}' | '\u{2012}' | '\u{2013}' | '\u{2014}' | '\u{2015}' | '\u{2212}' => '-',
        '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{202F}' | '\u{205F}' | '\u{3000}' => ' ',
        other => other,
    }).collect();
    let mut out = String::with_capacity(mapped.len());
    for line in mapped.split('\n') {
        out.push_str(line.trim_end_matches([' ', '\t', '\u{a0}']));
        out.push('\n');
    }
    out.pop();
    out
}

struct Edit {
    old_text: String,
    new_text: String,
}

/// `prepareEditArguments`: a JSON-string `edits`, an `edits` array of pairs, or a bare
/// `oldText`/`newText` pair all become the one `edits` list.
fn prepare_edit_args(args: &Value) -> Result<Vec<Edit>, String> {
    let invalid = || "Edit tool input is invalid. edits must contain at least one replacement.".to_string();
    let mut edits: Vec<Edit> = Vec::new();
    let list: Vec<Value> = match args.get("edits") {
        None | Some(Value::Null) => Vec::new(),
        Some(Value::Array(a)) => a.clone(),
        Some(Value::String(s)) => match serde_json::from_str::<Value>(s) {
            Ok(Value::Array(a)) => a,
            Ok(other @ Value::Object(_)) => vec![other],
            _ => return Err(invalid()),
        },
        Some(other @ Value::Object(_)) => vec![other.clone()],
        Some(_) => return Err(invalid()),
    };
    for e in &list {
        if let (Some(old), Some(new)) = (get(e, "oldText").and_then(Value::as_str), get(e, "newText").and_then(Value::as_str)) {
            edits.push(Edit { old_text: old.to_string(), new_text: new.to_string() });
        }
    }
    if let (Some(old), Some(new)) = (get(args, "oldText").and_then(Value::as_str), get(args, "newText").and_then(Value::as_str)) {
        edits.push(Edit { old_text: old.to_string(), new_text: new.to_string() });
    }
    if edits.is_empty() {
        return Err(invalid());
    }
    Ok(edits)
}

/// One hunk of a line diff: `-`/`+`/` ` lines with their new-file line numbers, the shape
/// `generateDiffString` renders for pi's edit result.
fn diff_lines(old: &str, new: &str, context: usize) -> String {
    let a: Vec<&str> = old.split('\n').collect();
    let b: Vec<&str> = new.split('\n').collect();
    let mut p = 0;
    while p < a.len() && p < b.len() && a[p] == b[p] {
        p += 1;
    }
    let mut s = 0;
    while s < a.len() - p && s < b.len() - p && a[a.len() - 1 - s] == b[b.len() - 1 - s] {
        s += 1;
    }
    let x: Vec<&str> = a[p..a.len() - s].to_vec();
    let y: Vec<&str> = b[p..b.len() - s].to_vec();
    if x.is_empty() && y.is_empty() {
        return String::new();
    }
    // Longest common subsequence over the changed middle; the equal runs become context.
    let n = x.len();
    let m = y.len();
    let mut lcs = vec![vec![0usize; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            lcs[i][j] = if x[i] == y[j] { lcs[i + 1][j + 1] + 1 } else { lcs[i + 1][j].max(lcs[i][j + 1]) };
        }
    }
    let mut ops: Vec<(char, &str)> = Vec::new();
    let (mut i, mut j) = (0usize, 0usize);
    while i < n && j < m {
        if x[i] == y[j] {
            ops.push((' ', x[i]));
            i += 1;
            j += 1;
        } else if lcs[i + 1][j] >= lcs[i][j + 1] {
            ops.push(('-', x[i]));
            i += 1;
        } else {
            ops.push(('+', y[j]));
            j += 1;
        }
    }
    while i < n {
        ops.push(('-', x[i]));
        i += 1;
    }
    while j < m {
        ops.push(('+', y[j]));
        j += 1;
    }
    // Group into hunks: runs of changes separated by more than 2*context equal lines split.
    let mut out = String::new();
    let mut old_ln = p + 1;
    let mut new_ln = p + 1;
    let mut k = 0;
    while k < ops.len() {
        if ops[k].0 == ' ' {
            old_ln += 1;
            new_ln += 1;
            k += 1;
            continue;
        }
        let start = k.saturating_sub(context);
        let mut end = k + 1;
        let mut run = 0usize;
        let mut idx = k;
        while idx < ops.len() {
            if ops[idx].0 == ' ' {
                run += 1;
                if run > context * 2 {
                    break;
                }
            } else {
                run = 0;
                end = idx + 1;
            }
            idx += 1;
        }
        let stop = (end + context).min(ops.len());
        let mut o = old_ln;
        let mut nw = new_ln;
        for e in &ops[..start] {
            if e.0 != '+' {
                o += 1;
            }
            if e.0 != '-' {
                nw += 1;
            }
        }
        out.push_str(&format!("@@ -{} +{} @@\n", o, nw));
        for e in &ops[start..stop] {
            match e.0 {
                '-' => {
                    out.push('-');
                    old_ln += 1;
                }
                '+' => {
                    out.push('+');
                    new_ln += 1;
                }
                _ => {
                    out.push(' ');
                    old_ln += 1;
                    new_ln += 1;
                }
            }
            out.push_str(e.1);
            out.push('\n');
        }
        k = stop;
    }
    out
}

/// The unified patch the observation's `extra.diff` carries (`generateUnifiedPatch`, 4 context
/// lines, file headers only).
fn unified_diff(path: &str, old: &str, new: &str) -> String {
    let body = diff_lines(old, new, 4);
    if body.is_empty() {
        return String::new();
    }
    format!("--- {path}\n+++ {path}\n{body}")
}

struct Matched {
    edit_index: usize,
    index: usize,
    len: usize,
    new_text: String,
}

fn not_found_error(path: &str, i: usize, total: usize) -> String {
    if total == 1 {
        format!("Could not find the exact text in {path}. The old text must match exactly including all whitespace and newlines.")
    } else {
        format!("Could not find edits[{i}] in {path}. The oldText must match exactly including all whitespace and newlines.")
    }
}
fn duplicate_error(path: &str, i: usize, total: usize, occurrences: usize) -> String {
    if total == 1 {
        format!("Found {occurrences} occurrences of the text in {path}. The text must be unique. Please provide more context to make it unique.")
    } else {
        format!("Found {occurrences} occurrences of edits[{i}] in {path}. Each oldText must be unique. Please provide more context to make it unique.")
    }
}
fn empty_old_text_error(path: &str, i: usize, total: usize) -> String {
    if total == 1 {
        format!("oldText must not be empty in {path}.")
    } else {
        format!("edits[{i}].oldText must not be empty in {path}.")
    }
}
fn no_change_error(path: &str, total: usize) -> String {
    if total == 1 {
        format!("No changes made to {path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.")
    } else {
        format!("No changes made to {path}. The replacements produced identical content.")
    }
}

/// `applyEditsToNormalizedContent`: match every edit against the same original, require
/// uniqueness, reject overlaps, then apply in reverse order so the offsets stay stable. When any
/// edit needs the fuzzy pass the whole match runs in fuzzy space (pi's behaviour), which is why
/// the caller normalises line endings first and restores them after.
fn apply_edits(content: &str, edits: &[Edit], path: &str) -> Result<String, String> {
    let normalized: Vec<(String, String)> = edits.iter().map(|e| (normalize_lf(&e.old_text), normalize_lf(&e.new_text))).collect();
    for (i, e) in normalized.iter().enumerate() {
        if e.0.is_empty() {
            return Err(empty_old_text_error(path, i, normalized.len()));
        }
    }
    let fuzzy_content = normalize_fuzzy(content);
    let fuzzy_edits: Vec<(String, String)> = normalized.iter().map(|(o, n)| (normalize_fuzzy(o), normalize_fuzzy(n))).collect();
    let used_fuzzy = normalized.iter().enumerate().any(|(i, e)| !content.contains(&e.0) && fuzzy_content.contains(&fuzzy_edits[i].0));
    let base = if used_fuzzy { fuzzy_content } else { content.to_string() };
    let mut matched: Vec<Matched> = Vec::new();
    for i in 0..normalized.len() {
        let (needle, replacement) = if used_fuzzy { (&fuzzy_edits[i].0, &fuzzy_edits[i].1) } else { (&normalized[i].0, &normalized[i].1) };
        let Some(index) = base.find(needle) else {
            return Err(not_found_error(path, i, normalized.len()));
        };
        let occurrences = base.matches(needle).count();
        if occurrences > 1 {
            return Err(duplicate_error(path, i, normalized.len(), occurrences));
        }
        matched.push(Matched { edit_index: i, index, len: needle.len(), new_text: replacement.clone() });
    }
    matched.sort_by_key(|m| m.index);
    for w in matched.windows(2) {
        if w[0].index + w[0].len > w[1].index {
            return Err(format!("edits[{}] and edits[{}] overlap in {}. Merge them into one edit or target disjoint regions.", w[0].edit_index, w[1].edit_index, path));
        }
    }
    let mut result = base;
    for m in matched.iter().rev() {
        result.replace_range(m.index..m.index + m.len, &m.new_text);
    }
    Ok(result)
}

fn count_lines(s: &str) -> usize {
    if s.is_empty() {
        return 0;
    }
    s.split('\n').count() - usize::from(s.ends_with('\n'))
}

/// The `write` tool's observation.
pub fn write_outcome(args: &Value, cwd: &str) -> Value {
    let Some(path) = get(args, "path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
        return observation("write: missing required argument 'path'".into(), true, Obj::new());
    };
    let Some(content) = get(args, "content").and_then(Value::as_str) else {
        return observation(format!("write: missing required argument 'content' for '{path}'"), true, Obj::new());
    };
    if content.len() > WRITE_HARD_CAP {
        return observation(format!("write: '{path}' is {} and over the {} write cap; split it or use bash", format_size(content.len()), format_size(WRITE_HARD_CAP)), true, Obj::new());
    }
    let abs = resolve_path(path, cwd);
    if let Some(parent) = abs.parent() {
        if !parent.as_os_str().is_empty() {
            if let Err(e) = std::fs::create_dir_all(parent) {
                return observation(format!("Could not write to {path}: cannot create parent directory {}: {}.", parent.display(), io_message(&e)), true, Obj::new());
            }
        }
    }
    let existed = abs.is_file();
    let prior = if existed { std::fs::read(&abs).ok().map(|b| String::from_utf8_lossy(&b).into_owned()) } else { None };
    if let Err(e) = std::fs::write(&abs, content) {
        return observation(format!("Could not write to {path}: {}.", io_message(&e)), true, Obj::new());
    }
    let lines = count_lines(content);
    let mut extra = Obj::new();
    extra.insert("tool".into(), json!("write"));
    extra.insert("path".into(), json!(path));
    extra.insert("lines".into(), json!(lines));
    extra.insert("bytes".into(), json!(content.len()));
    extra.insert("created".into(), json!(!existed));
    if let Some(p) = prior {
        let d = unified_diff(path, &p, content);
        if !d.is_empty() {
            extra.insert("diff".into(), json!(d));
        }
    }
    let what = if existed { "overwrote" } else { "created" };
    observation(format!("Successfully wrote to {path} ({what}, {} lines, {} bytes)", lines, content.len()), false, extra)
}

/// The `edit` tool's observation.
pub fn edit_outcome(args: &Value, cwd: &str) -> Value {
    let Some(path) = get(args, "path").and_then(Value::as_str).map(str::trim).filter(|p| !p.is_empty()) else {
        return observation("edit: missing required argument 'path'".into(), true, Obj::new());
    };
    let edits = match prepare_edit_args(args) {
        Ok(e) => e,
        Err(e) => return observation(e, true, Obj::new()),
    };
    let abs = resolve_path(path, cwd);
    let raw = match std::fs::read(&abs) {
        Ok(b) => b,
        Err(e) => return observation(format!("Could not edit file: {path}. Error code: {}.", io_message(&e)), true, Obj::new()),
    };
    if raw.len() > READ_HARD_CAP {
        return observation(format!("Could not edit file: {path} is over the {} edit cap; use bash to split it first", format_size(READ_HARD_CAP)), true, Obj::new());
    }
    let raw_text = String::from_utf8_lossy(&raw).into_owned();
    let (bom, text) = split_bom(&raw_text);
    let ending = detect_line_ending(text);
    let normalized = normalize_lf(text);
    let new_normalized = match apply_edits(&normalized, &edits, path) {
        Ok(n) => n,
        Err(e) => return observation(e, true, Obj::new()),
    };
    if new_normalized == normalized {
        return observation(no_change_error(path, edits.len()), true, Obj::new());
    }
    let final_content = if ending == "\r\n" {
        format!("{bom}{}", new_normalized.replace('\n', "\r\n"))
    } else {
        format!("{bom}{new_normalized}")
    };
    if let Err(e) = std::fs::write(&abs, &final_content) {
        return observation(format!("Could not write to {path}: {}.", io_message(&e)), true, Obj::new());
    }
    let diff = unified_diff(path, &normalized, &new_normalized);
    let mut extra = Obj::new();
    extra.insert("tool".into(), json!("edit"));
    extra.insert("path".into(), json!(path));
    extra.insert("edits".into(), json!(edits.len()));
    if !diff.is_empty() {
        extra.insert("diff".into(), json!(diff));
    }
    observation(format!("Successfully replaced {} block(s) in {}.", edits.len(), path), false, extra)
}

fn format_size(n: usize) -> String {
    if n >= 1024 * 1024 {
        format!("{:.1}MB", n as f64 / (1024.0 * 1024.0))
    } else if n >= 1024 {
        format!("{:.1}KB", n as f64 / 1024.0)
    } else {
        format!("{n}B")
    }
}

/// The largest file `write` will take in one call, so a runaway generation cannot allocate an
/// unbounded buffer (and the model is pushed to `edit` for big files).
pub const WRITE_HARD_CAP: usize = 8 * 1024 * 1024;

// ---- the code tool (mini's codemode) ----------------------------------------------------

/// What a `code` script needs from its host: the working directory the path-less tools resolve
/// against, and the environment's own command runner, so a script's `bash` calls are journaled,
/// timed and killed exactly like commands the model issued directly.
pub struct CodeCtx {
    pub cwd: String,
    pub bash: Box<dyn FnMut(&str) -> Value + Send>,
}

/// The `code` tool's observation: `Script completed`/`Script failed`, the wall time, the printed
/// output, the return value, and the tool-call count --- pi's codemode result shape.
pub fn code_outcome(args: &Value, ctx: &mut CodeCtx) -> Value {
    let Some(code) = get(args, "code").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) else {
        return observation("code: missing required argument 'code'".into(), true, Obj::new());
    };
    let started = std::time::Instant::now();
    let printed: std::sync::Arc<std::sync::Mutex<String>> = std::sync::Arc::new(std::sync::Mutex::new(String::new()));
    let calls = std::sync::Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let mut bash_fn = std::mem::replace(&mut ctx.bash, Box::new(|_| Value::Null));
    let bash_shared = std::sync::Arc::new(std::sync::Mutex::new(std::mem::replace(&mut bash_fn, Box::new(|_| Value::Null))));
    let result = {
        let mut engine = rhai::Engine::new();
        engine.set_module_resolver(rhai::module_resolvers::DummyModuleResolver::new());
        engine.disable_symbol("eval");
        engine.set_max_operations(std::env::var("MINI_CODE_MAX_OPS").ok().and_then(|v| v.parse().ok()).unwrap_or(20_000_000));
        engine.set_max_string_size(WRITE_HARD_CAP * 2);
        engine.set_max_array_size(1 << 20);
        engine.set_max_map_size(1 << 20);
        engine.set_max_call_levels(64);
        engine.set_max_expr_depths(128, 64);
        let secs: u64 = std::env::var("MINI_CODE_TIMEOUT").ok().and_then(|v| v.parse().ok()).unwrap_or(300);
        let deadline = started + std::time::Duration::from_secs(secs);
        engine.on_progress(move |_| {
            if std::time::Instant::now() > deadline {
                Some(format!("code tool wall-clock limit ({secs}s)").into())
            } else {
                None
            }
        });
        {
            let p = printed.clone();
            engine.on_print(move |s: &str| {
                let mut b = p.lock().unwrap();
                if b.len() < CODE_OUTPUT_MAX {
                    b.push_str(s);
                    b.push('\n');
                }
            });
        }
        register_code_host_fns(&mut engine, &ctx.cwd, &calls, &printed, &bash_shared);
        let mut scope = rhai::Scope::new();
        if let Err(e) = engine.eval_with_scope::<rhai::Dynamic>(&mut scope, code_prelude()) {
            eprintln!("WARNING: code tool prelude failed: {e}");
        }
        engine.eval_with_scope::<rhai::Dynamic>(&mut scope, code).map_err(|e| e.to_string())
    };
    ctx.bash = std::mem::replace(&mut *bash_shared.lock().unwrap(), Box::new(|_| Value::Null));
    let n_calls = calls.load(std::sync::atomic::Ordering::SeqCst);
    let mut extra = Obj::new();
    extra.insert("tool".into(), json!("code"));
    extra.insert("calls".into(), json!(n_calls));
    extra.insert("wall_ms".into(), json!(started.elapsed().as_millis() as u64));
    let body = printed.lock().unwrap().clone();
    if !body.trim().is_empty() {
        extra.insert("printed_bytes".into(), json!(body.len()));
    }
    match result {
        Ok(value) => {
            let mut text = format!("Script completed in {:.2}s, {} tool call{}\n", started.elapsed().as_secs_f64(), n_calls, if n_calls == 1 { "" } else { "s" });
            if !body.trim().is_empty() {
                text.push_str(&body);
                if !text.ends_with('\n') {
                    text.push('\n');
                }
            }
            let ret = value.to_string();
            if !ret.is_empty() && ret != "()" {
                text.push_str(&format!("=> {ret}\n"));
            }
            observation(text, false, extra)
        }
        Err(e) => {
            let mut text = format!("Script failed after {:.2}s, {} tool call{}\n", started.elapsed().as_secs_f64(), n_calls, if n_calls == 1 { "" } else { "s" });
            if !body.trim().is_empty() {
                text.push_str(&body);
                if !text.ends_with('\n') {
                    text.push('\n');
                }
            }
            text.push_str(&format!("Script error: {e}\n"));
            text.push_str("Tool calls already made are real: they are not undone. Re-read what you changed before retrying.\n");
            observation(text, true, extra)
        }
    }
}

/// What a `print`-ing script may send back to the model, so a script cannot quietly inflate the
/// context it was supposed to keep small.
const CODE_OUTPUT_MAX: usize = 60 * 1024;

/// The host functions a `code` script gets. They are registered as plain globals (the script
/// calls `read("f.py")`); `tools.read(...)` works too through the prelude's `tools` map, which is
/// the spelling pi's codemode uses and the one a model that has read both docs will reach for.
fn register_code_host_fns(
    engine: &mut rhai::Engine,
    cwd: &str,
    calls: &std::sync::Arc<std::sync::atomic::AtomicUsize>,
    printed: &std::sync::Arc<std::sync::Mutex<String>>,
    bash_fn: &std::sync::Arc<std::sync::Mutex<Box<dyn FnMut(&str) -> Value + Send>>>,
) {
    fn read_text(path: &str, off: Option<i64>, lim: Option<i64>, cwd: &str) -> String {
        let page = crate::tools::read_file(path, off, lim, cwd);
        match page.error {
            Some(e) => format!("read error: {e}"),
            None => page.text,
        }
    }
    {
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("read", move |p: &str| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            read_text(p, None, None, &cwd)
        });
    }
    {
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("read", move |p: &str, o: rhai::Dynamic| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let off = as_line(o);
            read_text(p, off, None, &cwd)
        });
    }
    {
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("read", move |p: &str, o: rhai::Dynamic, l: rhai::Dynamic| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            read_text(p, as_line(o), as_line(l), &cwd)
        });
    }
    {
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("write", move |p: &str, c: &str| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let out = write_outcome(&json!({"path": p, "content": c}), &cwd);
            outcome_text(&out)
        });
    }
    {
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("edit", move |p: &str, o: &str, n: &str| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let out = edit_outcome(&json!({"path": p, "oldText": o, "newText": n}), &cwd);
            outcome_text(&out)
        });
    }
    {
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("edit_many", move |p: &str, pairs: rhai::Array| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let mut edits = Vec::new();
            for pair in &pairs {
                if let Some(a) = pair.clone().try_cast::<rhai::Array>() {
                    if a.len() == 2 {
                        edits.push(json!({"oldText": a[0].to_string(), "newText": a[1].to_string()}));
                    }
                }
            }
            let out = edit_outcome(&json!({"path": p, "edits": edits}), &cwd);
            outcome_text(&out)
        });
    }
    {
        let calls = calls.clone();
        let bash_fn = bash_fn.clone();
        engine.register_fn("bash", move |cmd: &str| -> String {
            calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            let out = (bash_fn.lock().unwrap())(cmd);
            outcome_text_and_rc(&out)
        });
    }
    {
        // Parallel file reads: the one shape that is genuinely safe to overlap (no environment
        // state, no process), and the shape a script needs when it greps several files at once.
        let calls = calls.clone();
        let cwd = cwd.to_string();
        engine.register_fn("reads", move |paths: rhai::Array| -> rhai::Array {
            let paths: Vec<String> = paths.iter().map(|p| p.to_string()).collect();
            calls.fetch_add(paths.len(), std::sync::atomic::Ordering::SeqCst);
            let results: Vec<std::sync::Arc<std::sync::Mutex<String>>> = paths.iter().map(|_| std::sync::Arc::new(std::sync::Mutex::new(String::new()))).collect();
            std::thread::scope(|s| {
                for (p, r) in paths.iter().zip(results.iter()) {
                    let r = r.clone();
                    let p = p.clone();
                    let cwd = cwd.clone();
                    s.spawn(move || {
                        *r.lock().unwrap() = read_text(&p, None, None, &cwd);
                    });
                }
            });
            results.into_iter().map(|r| rhai::Dynamic::from(r.lock().unwrap().clone())).collect()
        });
    }
    // The string helpers the REPL cell already has, so a script can grep/slice without a shell.
    engine.register_fn("lines", |s: &str| -> rhai::Array { s.lines().map(|l| rhai::Dynamic::from(l.to_string())).collect() });
    engine.register_fn("len", |s: &str| s.chars().count() as i64);
    engine.register_fn("len", |a: rhai::Array| a.len() as i64);
    engine.register_fn("len", |m: rhai::Map| m.len() as i64);
    engine.register_fn("join", |a: rhai::Array, sep: &str| -> String { a.iter().map(|x| x.to_string()).collect::<Vec<_>>().join(sep) });
    engine.register_fn("replace_all", |s: &str, from: &str, to: &str| -> String { s.replace(from, to) });
    engine.register_fn("num", |s: &str| -> f64 { s.trim().parse().unwrap_or(0.0) });
    engine.register_fn("fmt2", |x: f64| format!("{x:.2}"));
    engine.register_fn("trimmed", |s: &str| s.trim().to_string());
    engine.register_fn("slice", |s: &str, start: i64, n: i64| -> String { s.chars().skip(start.max(0) as usize).take(n.max(0) as usize).collect() });
    engine.register_fn("slice", |a: rhai::Array, start: i64, n: i64| -> rhai::Array { a.into_iter().skip(start.max(0) as usize).take(n.max(0) as usize).collect() });
    engine.register_fn("grep", |s: &str, re: &str| -> Result<rhai::Array, Box<rhai::EvalAltResult>> {
        let re = regex::Regex::new(re).map_err(|e| format!("bad regex: {e}"))?;
        Ok(s.lines().filter(|l| re.is_match(l)).map(|l| rhai::Dynamic::from(l.to_string())).collect())
    });
    engine.register_fn("top", |m: rhai::Map, k: i64| -> rhai::Array {
        let mut v: Vec<(String, i64)> = m.iter().map(|(k, v)| (k.to_string(), v.clone().try_cast::<i64>().unwrap_or(0))).collect();
        v.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
        v.truncate(k.max(0) as usize);
        v.into_iter().map(|(k, c)| rhai::Dynamic::from(vec![rhai::Dynamic::from(k), rhai::Dynamic::from(c)])).collect()
    });
    let _ = printed;
}

/// `tools.<name>(...)`: pi's codemode spelling. Built as a Rhai map of closures so the script can
/// call either `read(path)` or `tools.read(path)`; the map is a constant the script's own scope
/// sees because the host functions are all global.
fn code_prelude() -> &'static str {
    r#"
let tools = #{
    read: |p| read(p),
    read_off: |p, o| read(p, o),
    read_page: |p, o, l| read(p, o, l),
    write: |p, c| write(p, c),
    edit: |p, o, n| edit(p, o, n),
    edit_many: |p, pairs| edit_many(p, pairs),
    bash: |c| bash(c),
    reads: |ps| reads(ps),
};
"#
}

fn as_line(v: rhai::Dynamic) -> Option<i64> {
    v.clone().try_cast::<i64>().or_else(|| v.try_cast::<String>().and_then(|s| s.trim().parse().ok()))
}

fn outcome_text_and_rc(out: &Value) -> String {
    let text = out.get("output").and_then(Value::as_str).unwrap_or_default().to_string();
    let rc = out.get("returncode").and_then(Value::as_i64).unwrap_or(0);
    if rc == 0 { text } else { format!("{text}\n[exit {rc}]") }
}

fn outcome_text(out: &Value) -> String {
    out.get("output").and_then(Value::as_str).unwrap_or_default().to_string()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tmp(name: &str) -> std::path::PathBuf {
        let d = std::env::temp_dir().join(format!("writing-test-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&d);
        std::fs::create_dir_all(&d).unwrap();
        d
    }

    #[test]
    fn write_creates_and_reports_one_line() {
        let d = tmp("write");
        let out = write_outcome(&json!({"path": "a/b.py", "content": "x = 1\ny = 2\n"}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(0));
        assert_eq!(out["output"], json!("Successfully wrote to a/b.py (created, 2 lines, 12 bytes)"));
        assert_eq!(std::fs::read_to_string(d.join("a/b.py")).unwrap(), "x = 1\ny = 2\n");
        // overwrite reports the diff
        let out = write_outcome(&json!({"path": "a/b.py", "content": "x = 2\ny = 2\n"}), d.to_str().unwrap());
        assert!(out["output"].as_str().unwrap().contains("overwrote"));
        assert!(out["extra"]["diff"].as_str().unwrap().contains("-x = 1"));
        assert!(out["extra"]["diff"].as_str().unwrap().contains("+x = 2"));
    }

    #[test]
    fn edit_replaces_unique_text() {
        let d = tmp("edit");
        std::fs::write(d.join("f.py"), "def f():\n    return 1\n").unwrap();
        let out = edit_outcome(&json!({"path": "f.py", "edits": [{"oldText": "return 1", "newText": "return 2"}]}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(0), "{}", out);
        assert_eq!(std::fs::read_to_string(d.join("f.py")).unwrap(), "def f():\n    return 2\n");
        assert!(out["extra"]["diff"].as_str().unwrap().contains("return 2"));
    }

    #[test]
    fn edit_accepts_shorthand_pair() {
        let d = tmp("edit-shorthand");
        std::fs::write(d.join("f.js"), "a > 10;\n").unwrap();
        let out = edit_outcome(&json!({"path": "f.js", "oldText": "a > 10;", "newText": "a >= 10;"}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(0), "{}", out);
        assert_eq!(std::fs::read_to_string(d.join("f.js")).unwrap(), "a >= 10;\n");
    }

    #[test]
    fn edit_several_disjoint_edits_in_one_call() {
        let d = tmp("edit-many");
        std::fs::write(d.join("f.py"), "one\ntwo\nthree\nfour\n").unwrap();
        let out = edit_outcome(&json!({"path": "f.py", "edits": [
            {"oldText": "one", "newText": "ONE"},
            {"oldText": "three", "newText": "THREE"}
        ]}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(0), "{}", out);
        assert_eq!(std::fs::read_to_string(d.join("f.py")).unwrap(), "ONE\ntwo\nTHREE\nfour\n");
        assert_eq!(out["extra"]["edits"], json!(2));
    }

    #[test]
    fn edit_rejects_ambiguous_and_missing_text() {
        let d = tmp("edit-err");
        std::fs::write(d.join("f.py"), "x\nx\n").unwrap();
        let out = edit_outcome(&json!({"path": "f.py", "edits": [{"oldText": "x", "newText": "y"}]}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(1));
        assert!(out["output"].as_str().unwrap().contains("2 occurrences"));
        let out = edit_outcome(&json!({"path": "f.py", "edits": [{"oldText": "nope", "newText": "y"}]}), d.to_str().unwrap());
        assert!(out["output"].as_str().unwrap().contains("Could not find the exact text"));
        let out = edit_outcome(&json!({"path": "missing.py", "edits": [{"oldText": "a", "newText": "b"}]}), d.to_str().unwrap());
        assert!(out["output"].as_str().unwrap().contains("Could not edit file"));
    }

    #[test]
    fn edit_preserves_crlf_and_bom() {
        let d = tmp("crlf");
        std::fs::write(d.join("f.txt"), "\u{feff}a\r\nb\r\n").unwrap();
        let out = edit_outcome(&json!({"path": "f.txt", "oldText": "b", "newText": "c"}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(0), "{}", out);
        assert_eq!(std::fs::read(d.join("f.txt")).unwrap(), b"\xef\xbb\xbfa\r\nc\r\n".to_vec());
    }

    #[test]
    fn edit_fuzzy_rescues_a_near_miss() {
        let d = tmp("fuzzy");
        // a trailing space the model did not send, and a Unicode dash it normalised away
        std::fs::write(d.join("f.py"), "value = a\u{2013}b \n").unwrap();
        let out = edit_outcome(&json!({"path": "f.py", "oldText": "value = a-b", "newText": "value = a_b"}), d.to_str().unwrap());
        assert_eq!(out["returncode"], json!(0), "{}", out);
        let got = std::fs::read_to_string(d.join("f.py")).unwrap();
        assert!(got.contains("a_b"), "got {got:?}");
    }

    #[test]
    fn code_batches_read_write_edit_and_bash() {
        let d = tmp("code");
        std::fs::write(d.join("in.txt"), "1\n2\n3\n").unwrap();
        let cwd = d.display().to_string();
        let mut ctx = CodeCtx {
            cwd: cwd.clone(),
            bash: Box::new(move |cmd: &str| {
                // A stub environment: it only needs to answer with the observation shape.
                let out = std::process::Command::new("/bin/sh").arg("-c").arg(cmd).current_dir(&cwd).output().unwrap();
                json!({"output": String::from_utf8_lossy(&out.stdout).to_string(), "returncode": out.status.code().unwrap_or(-1)})
            }),
        };
        let script = r#"
            // read + count without dragging the file into the model's context
            let n = lines(read("in.txt")).len();
            write("out.txt", `counted ${n}` + "\n");
            edit("in.txt", "3", "30");
            print(`counted ${n}`);
            let b = bash("cat out.txt in.txt");
            print(b);
        "#;
        let out = code_outcome(&json!({"code": script}), &mut ctx);
        assert_eq!(out["returncode"], json!(0), "{}", out["output"]);
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("Script completed"), "{text}");
        // the script's own bash output is what it returned
        assert!(text.contains("counted 3"), "{text}");
        assert!(text.contains("counted 3"), "{text}");
        assert!(text.contains("1\n2\n30"), "{text}");
        assert_eq!(out["extra"]["calls"], json!(4));
        assert_eq!(std::fs::read_to_string(d.join("out.txt")).unwrap(), "counted 3\n");
    }

    #[test]
    fn code_failure_keeps_partial_output() {
        let d = tmp("code-fail");
        std::fs::write(d.join("f.txt"), "hello\n").unwrap();
        let mut ctx = CodeCtx { cwd: d.display().to_string(), bash: Box::new(|_| json!({"output": "", "returncode": 0})) };
        let script = "print(\"before\"); let y = no_such_function_at_all(1); y";
        let out = code_outcome(&json!({"code": script}), &mut ctx);
        assert_eq!(out["returncode"], json!(1));
        let text = out["output"].as_str().unwrap();
        assert!(text.contains("Script failed"), "{text}");
        assert!(text.contains("before"), "{text}");
        assert!(text.contains("Script error:"), "{text}");
    }
}

