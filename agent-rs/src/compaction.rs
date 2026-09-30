//! Context-window bookkeeping for automatic compaction (`agents/utils/compaction.py`).

use crate::models::shapes::text_of;
use crate::util::{get, py_json, Obj};
use serde_json::{json, Value};
use std::path::PathBuf;

pub const DEFAULT_WINDOW: i64 = 200_000;
pub const DEFAULT_CHARS_PER_TOKEN: f64 = 3.5;

pub const SUMMARY_PROMPT: &str = "CONTEXT COMPACTION REQUEST — do not call any tool; reply with plain text only.

The conversation is about to exceed the context window. Write a summary that fully replaces the earlier messages: after this, you will only see the system prompt, the first task message, your summary, and the most recent messages verbatim. Anything you omit is lost for good.

Use exactly these sections:
1. Goal and user intent — every request the user made, including follow-ups and corrections, and their constraints and preferences (quote them where the wording matters).
2. Key facts discovered — environment, repositories, branches, worktrees, paths, services, URLs, IDs, PR numbers, versions, commands that work, and how things are wired together.
3. Files and code — each file read or changed, what changed and why; include short snippets when exact code matters.
4. Errors and fixes — what failed, the root cause, how it was resolved (or not).
5. Done so far — completed steps, with verification results.
6. Pending — remaining tasks, open questions, anything promised to the user.
7. Current state and next step — exactly what was being done in the latest messages, and the very next action.

Be specific and dense (no filler). Never include secrets such as tokens or passwords; record where they live instead.";

const COMPACTION_HEAD: &str = "[Context compacted: the earlier part of this conversation was summarized to fit the context window. The most recent messages follow verbatim after this one.]\n\n<summary>\n";
const COMPACTION_TAIL: &str = "The messages after this one are the latest steps, verbatim; their commands already ran and their outputs are current. Continue from the last of them: do not redo completed steps and do not ask the user to repeat themselves.";

/// Python `len(str)` of a message on the wire (content + tool calls), in code points.
pub fn message_chars(m: &Value) -> i64 {
    let mut chars = text_of(get(m, "content").unwrap_or(&Value::Null)).chars().count() as i64 + 16;
    if let Some(tc) = get(m, "tool_calls").filter(|t| t.as_array().is_some_and(|a| !a.is_empty())) {
        chars += py_json(tc, false).chars().count() as i64;
    }
    chars
}

pub fn messages_chars(ms: &[Value]) -> i64 {
    ms.iter().map(message_chars).sum()
}

fn usage(m: &Value) -> Option<&Obj> {
    m.pointer("/extra/response/usage").and_then(Value::as_object)
}

fn int_field(o: &Obj, k: &str) -> Option<i64> {
    o.get(k).filter(|v| v.is_i64() || v.is_u64()).and_then(Value::as_i64)
}

/// Tokens the provider counted for the prompt behind `m` (cached ones included).
pub fn prompt_tokens(m: &Value) -> Option<i64> {
    let u = usage(m)?;
    if let Some(p) = int_field(u, "prompt_tokens") {
        return Some(p);
    }
    let input = int_field(u, "input_tokens")?;
    let n = |k: &str| u.get(k).and_then(Value::as_i64).unwrap_or(0);
    Some(input + n("cache_read_input_tokens") + n("cache_creation_input_tokens"))
}

pub fn cache_usage(m: &Value) -> (i64, i64, i64) {
    let Some(u) = usage(m) else { return (0, 0, 0) };
    let details = u.get("prompt_tokens_details").or_else(|| u.get("input_tokens_details")).cloned().unwrap_or(json!({}));
    let n = |v: Option<&Value>| v.and_then(Value::as_i64).unwrap_or(0);
    let mut read = n(u.get("cache_read_input_tokens"));
    if read == 0 {
        read = n(details.get("cached_tokens"));
    }
    let mut write = n(u.get("cache_creation_input_tokens"));
    if write == 0 {
        write = n(details.get("cached_creation_tokens"));
    }
    (prompt_tokens(m).unwrap_or(0), read, write)
}

fn learned_file() -> PathBuf {
    crate::config::global_config_dir().join("context_windows.json")
}

fn load_learned() -> Obj {
    std::fs::read_to_string(learned_file()).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).and_then(|v| v.as_object().cloned()).unwrap_or_default()
}

const KNOWN: &[(&str, i64)] = &[
    (r"claude-(opus|sonnet|fable)-(4-[6-9]|5)", 1_000_000),
    (r"claude|anthropic", 200_000),
    (r"gpt-5|codex", 400_000),
    (r"gpt-4\.1", 1_000_000),
    (r"mimo", 1_000_000),
    (r"gemini", 1_000_000),
    (r"deepseek", 128_000),
];

/// Learned from an overflow error > configured > the OpenCode Go table > known ids.
pub fn context_window_for(model_name: &str, configured: i64) -> i64 {
    let lowered = model_name.to_lowercase();
    if let Some(w) = load_learned().get(&lowered).and_then(Value::as_i64).filter(|w| *w > 0) {
        return w;
    }
    if configured > 0 {
        return configured;
    }
    if let Some(info) = crate::models::catalog::go_info(model_name) {
        return info.context_window;
    }
    for (pattern, window) in KNOWN {
        if regex::Regex::new(pattern).unwrap().is_match(&lowered) {
            return *window;
        }
    }
    DEFAULT_WINDOW
}

pub fn is_context_overflow(kind: &str, message: &str) -> bool {
    let re = regex::Regex::new(r"(?i)prompt is too long|context.?length|context.?window|maximum context|too many (input )?tokens|input is too long|exceeds? the (model'?s? )?(maximum|context)|reduce the length|request too large").unwrap();
    re.is_match(&format!("{kind}: {message}"))
}

pub fn learn_window(model_name: &str, message: &str) -> Option<i64> {
    let patterns = [r"(\d[\d,]*) tokens? > (\d[\d,]*)", r"(?i)maximum context length is (\d[\d,]*)", r"(?i)context (?:window|length) (?:of|is) (\d[\d,]*)"];
    for p in patterns {
        if let Some(c) = regex::Regex::new(p).unwrap().captures(message) {
            let last = c.iter().skip(1).flatten().last()?.as_str().replace(',', "");
            let limit: i64 = last.parse().ok()?;
            if limit < 1000 {
                continue;
            }
            let mut learned = load_learned();
            learned.insert(model_name.to_lowercase(), json!(limit));
            let mut keys: Vec<_> = learned.into_iter().collect();
            keys.sort_by(|a, b| a.0.cmp(&b.0));
            let sorted: Obj = keys.into_iter().collect();
            let _ = std::fs::write(learned_file(), serde_json::to_string_pretty(&Value::Object(sorted)).unwrap_or_default());
            return Some(limit);
        }
    }
    None
}

fn role(m: &Value) -> &str {
    get(m, "role").and_then(Value::as_str).unwrap_or("")
}

/// Leading system messages plus the first task message (unless it alone is huge).
pub fn head_length(ms: &[Value], max_chars: i64) -> usize {
    let mut n = 0;
    while n < ms.len() && role(&ms[n]) == "system" {
        n += 1;
    }
    if n < ms.len() && role(&ms[n]) == "user" && message_chars(&ms[n]) <= max_chars {
        n += 1;
    }
    n
}

/// Where the verbatim tail begins (never on a tool result).
pub fn tail_start(ms: &[Value], lower: usize, keep_chars: i64) -> usize {
    let mut start = ms.len();
    let mut total = 0;
    while start > lower && total + message_chars(&ms[start - 1]) <= keep_chars {
        start -= 1;
        total += message_chars(&ms[start]);
    }
    while start < ms.len() && role(&ms[start]) == "tool" {
        start += 1;
    }
    if start >= ms.len() {
        start = ms.len().saturating_sub(1);
        while start > lower && role(&ms[start]) == "tool" {
            start -= 1;
        }
    }
    start.max(lower)
}

fn elide(m: &Value, max_chars: usize) -> Value {
    let Some(text) = get(m, "content").and_then(Value::as_str) else { return m.clone() };
    let len = text.chars().count();
    if len <= max_chars {
        return m.clone();
    }
    let half = max_chars / 2;
    let head: String = text.chars().take(half).collect();
    let tail: String = text.chars().skip(len - half).collect();
    let mut out = m.clone();
    out["content"] = json!(format!("{head}\n[... {} characters elided by context compaction ...]\n{tail}", len - max_chars));
    out
}

/// Fit into `budget_chars`: elide the oldest long contents, then drop the oldest middle turns.
pub fn shrink(ms: &[Value], protect_head: usize, budget_chars: i64) -> Vec<Value> {
    let mut out = ms.to_vec();
    for cap in [8000usize, 2000, 400] {
        for i in protect_head..out.len() {
            if messages_chars(&out) <= budget_chars {
                return out;
            }
            out[i] = elide(&out[i], cap);
        }
    }
    while messages_chars(&out) > budget_chars && out.len() > protect_head + 2 {
        out.remove(protect_head);
        while out.len() > protect_head + 1 && role(&out[protect_head]) == "tool" {
            out.remove(protect_head);
        }
    }
    out
}

pub fn user_requests(ms: &[Value]) -> Vec<String> {
    let mut out = Vec::new();
    for m in ms {
        let extra = m.get("extra").cloned().unwrap_or(json!({}));
        if let Some(c) = extra.get("compaction") {
            for r in c.get("user_messages").and_then(Value::as_array).cloned().unwrap_or_default() {
                if let Some(s) = r.as_str() {
                    out.push(s.to_string());
                }
            }
        } else if role(m) == "user" && matches!(extra.get("interrupt_type").and_then(Value::as_str), Some("UserNewTask") | Some("UserInterruption")) {
            let text = text_of(m.get("content").unwrap_or(&Value::Null));
            out.push(text.strip_prefix("The user added a new task: ").map(String::from).unwrap_or(text));
        }
    }
    out
}

pub fn cap_requests(requests: &[String]) -> Vec<String> {
    let (per, total) = (3000usize, 30000usize);
    let clipped: Vec<String> = requests.iter().map(|r| if r.chars().count() <= per { r.clone() } else { format!("{} [...]", r.chars().take(per).collect::<String>()) }).collect();
    let mut kept = Vec::new();
    let mut size = 0;
    for r in clipped.iter().skip(1).rev() {
        let n = r.chars().count();
        if size + n > total {
            break;
        }
        kept.push(r.clone());
        size += n;
    }
    let mut out: Vec<String> = clipped.into_iter().take(1).collect();
    out.extend(kept.into_iter().rev());
    out
}

pub fn render_compaction(summary: &str, requests: &[String]) -> String {
    let mut block = String::new();
    if !requests.is_empty() {
        let lines: Vec<String> = requests.iter().map(|r| format!("- {}", r.trim())).collect();
        block = format!("\nUser messages from the summarized part, verbatim (oldest first):\n{}\n", lines.join("\n"));
    }
    format!("{COMPACTION_HEAD}{}\n</summary>\n{block}\n{COMPACTION_TAIL}", summary.trim())
}

pub fn fallback_summary(ms: &[Value]) -> String {
    let mut notes: Vec<String> = Vec::new();
    for m in ms.iter().rev() {
        if role(m) != "assistant" {
            continue;
        }
        let text = text_of(m.get("content").unwrap_or(&Value::Null));
        let text = text.trim();
        if text.is_empty() {
            continue;
        }
        notes.push(text.chars().take(1500).collect());
        if notes.iter().map(|n| n.chars().count()).sum::<usize>() > 12000 {
            break;
        }
    }
    notes.reverse();
    format!("(Automatic summary unavailable; latest assistant notes, oldest first.)\n\n{}", notes.join("\n\n"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn render_like_python() {
        let r = render_compaction(" sum ", &["first".into(), "second ".into()]);
        assert!(r.starts_with("[Context compacted: the earlier part"));
        assert!(r.contains("<summary>\nsum\n</summary>\n\nUser messages from the summarized part, verbatim (oldest first):\n- first\n- second\n\nThe messages after"));
    }

    #[test]
    fn tail_never_starts_on_tool() {
        let ms = vec![
            json!({"role": "system", "content": "s"}),
            json!({"role": "user", "content": "t"}),
            json!({"role": "assistant", "content": "a"}),
            json!({"role": "tool", "content": "x".repeat(10)}),
            json!({"role": "tool", "content": "y"}),
        ];
        let t = tail_start(&ms, 2, 30);
        assert_ne!(role(&ms[t.min(ms.len() - 1)]), "tool");
    }

    #[test]
    fn windows() {
        assert_eq!(context_window_for("cliproxy/claude-sonnet-4-5", 0), 200_000);
        assert_eq!(context_window_for("claude-opus-5-5", 0), 1_000_000);
        assert_eq!(context_window_for("x", 1234), 1234);
        assert!(is_context_overflow("ProviderError", "HTTP 400: prompt is too long: 250000 tokens > 200000"));
    }
}
