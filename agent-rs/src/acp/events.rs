//! Trajectory journal records (`<traj>.jsonl`) to ACP `session/update` payloads.
//!
//! The agent writes `{"t":"delta"}` fragments while a reply streams, then the whole message as
//! `{"t":"msg"}`, then `{"t":"info"}` with the running totals. A [`Mapper`] turns that sequence
//! into agent text and thought chunks, tool calls and their results, and usage. The same mapper
//! (with `replay` set) rebuilds a finished turn for `session/load`.

use serde_json::{json, Value};
use std::path::Path;

/// Tool output sent to the client is capped: a `cat` of a large file must not become a
/// multi-megabyte notification. The trajectory keeps the full text.
const MAX_OUTPUT_CHARS: usize = 40_000;

pub struct Mapper {
    cwd: String,
    model: String,
    replay: bool,
    streamed_text: String,
    streamed_thought: String,
    open_calls: Vec<String>,
    used: i64,
    last_usage: Option<(i64, i64, String)>,
    synthetic_ids: usize,
    /// Some agent text reached the client during this turn.
    pub emitted_text: bool,
    pub exit_status: Option<String>,
    pub submission: Option<String>,
}

impl Mapper {
    pub fn new(cwd: &str, model: &str, replay: bool) -> Self {
        Mapper {
            cwd: cwd.to_string(),
            model: model.to_string(),
            replay,
            streamed_text: String::new(),
            streamed_thought: String::new(),
            open_calls: Vec::new(),
            used: 0,
            last_usage: None,
            synthetic_ids: 0,
            emitted_text: false,
            exit_status: None,
            submission: None,
        }
    }

    pub fn set_model(&mut self, model: &str) {
        self.model = model.to_string();
    }

    /// One journal line, already parsed.
    pub fn record(&mut self, rec: &Value) -> Vec<Value> {
        match rec.get("t").and_then(Value::as_str) {
            Some("delta") if !self.replay => {
                let text = rec.get("x").and_then(Value::as_str).unwrap_or("");
                if text.is_empty() {
                    return vec![];
                }
                if rec.get("k").and_then(Value::as_str) == Some("thinking") {
                    self.streamed_thought.push_str(text);
                    vec![chunk("agent_thought_chunk", text)]
                } else {
                    self.streamed_text.push_str(text);
                    self.emitted_text = true;
                    vec![chunk("agent_message_chunk", text)]
                }
            }
            Some("msg") => rec.get("m").map(|m| self.message(m)).unwrap_or_default(),
            Some("info") if !self.replay => rec.get("i").map(|i| self.info(i)).unwrap_or_default(),
            _ => vec![],
        }
    }

    pub fn message(&mut self, m: &Value) -> Vec<Value> {
        let extra = m.get("extra").cloned().unwrap_or(json!({}));
        let interrupt = extra.get("interrupt_type").and_then(Value::as_str);
        match m.get("role").and_then(Value::as_str).unwrap_or("") {
            "assistant" => {
                // The cut-off draft of an output-limited reply is retried; it is never the answer.
                if interrupt == Some("OutputLimitDraft") {
                    self.streamed_text.clear();
                    self.streamed_thought.clear();
                    return vec![];
                }
                let mut out = Vec::new();
                let thought = thinking_text(m);
                if let Some(rest) = unsent(&thought, &std::mem::take(&mut self.streamed_thought)) {
                    out.push(chunk("agent_thought_chunk", &rest));
                }
                let text = content_text(m.get("content"));
                if let Some(rest) = unsent(&text, &std::mem::take(&mut self.streamed_text)) {
                    out.push(chunk("agent_message_chunk", &rest));
                    self.emitted_text = true;
                }
                if !text.trim().is_empty() {
                    self.emitted_text = true;
                }
                for (id, name, args) in self.calls_of(m) {
                    out.push(tool_call(&id, &name, &args, &self.cwd));
                    self.open_calls.push(id);
                }
                if let Some(used) = context_used(m) {
                    self.used = used;
                }
                out
            }
            "tool" => {
                let id = m.get("tool_call_id").and_then(Value::as_str).map(str::to_string).or_else(|| self.open_calls.first().cloned());
                let Some(id) = id else { return vec![] };
                self.open_calls.retain(|c| *c != id);
                vec![tool_result(&id, m)]
            }
            "user" => {
                // Text-based models get their command output back as a user message.
                let observation = extra.get("raw_output").is_some() || extra.get("returncode").is_some();
                if observation && interrupt.is_none() && !self.open_calls.is_empty() {
                    let id = self.open_calls.remove(0);
                    return vec![tool_result(&id, m)];
                }
                if self.replay && interrupt == Some("UserNewTask") {
                    let text = content_text(m.get("content"));
                    let text = text.strip_prefix("The user added a new task:").unwrap_or(&text).trim();
                    if !text.is_empty() {
                        return vec![json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": text}})];
                    }
                }
                vec![]
            }
            "exit" => {
                self.exit_status = extra.get("exit_status").and_then(Value::as_str).map(str::to_string);
                let submission = extra.get("submission").and_then(Value::as_str).unwrap_or("").to_string();
                let mut out = Vec::new();
                // A submission that never appeared as assistant text (a judge-approved closure,
                // a `submit` tool) is still the turn's answer.
                if !self.emitted_text && !submission.trim().is_empty() {
                    out.push(chunk("agent_message_chunk", &submission));
                    self.emitted_text = true;
                }
                self.submission = Some(submission);
                out
            }
            _ => vec![],
        }
    }

    fn info(&mut self, info: &Value) -> Vec<Value> {
        let cost = info.pointer("/model_stats/instance_cost").and_then(Value::as_f64).unwrap_or(0.0);
        let Some(size) = crate::models::limits::model_limits(&self.model).map(|l| l.context_window) else { return vec![] };
        if self.used <= 0 {
            return vec![];
        }
        // Rounded so float noise in the running cost does not resend identical usage.
        let key = (self.used, size, format!("{cost:.6}"));
        if self.last_usage.as_ref() == Some(&key) {
            return vec![];
        }
        self.last_usage = Some(key);
        vec![json!({"sessionUpdate": "usage_update", "used": self.used, "size": size, "cost": {"amount": cost, "currency": "USD"}})]
    }

    /// `(id, tool name, arguments)` for every action the assistant asked for.
    fn calls_of(&mut self, m: &Value) -> Vec<(String, String, Value)> {
        let mut calls = Vec::new();
        if let Some(list) = m.get("tool_calls").and_then(Value::as_array).filter(|l| !l.is_empty()) {
            for tc in list {
                let id = tc.get("id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| self.next_id());
                let name = tc.pointer("/function/name").and_then(Value::as_str).unwrap_or("bash").to_string();
                let args = match tc.pointer("/function/arguments") {
                    Some(Value::String(s)) => serde_json::from_str(s).unwrap_or_else(|_| json!({"arguments": s})),
                    Some(v @ Value::Object(_)) => v.clone(),
                    _ => json!({}),
                };
                calls.push((id, name, args));
            }
            return calls;
        }
        for action in m.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default() {
            let id = action.get("tool_call_id").and_then(Value::as_str).map(str::to_string).unwrap_or_else(|| self.next_id());
            match action.get("tool").and_then(Value::as_str) {
                Some(tool) => calls.push((id, tool.to_string(), action.get("args").cloned().unwrap_or(json!({})))),
                None => calls.push((id, "bash".into(), json!({"command": action.get("command").cloned().unwrap_or(json!(""))}))),
            }
        }
        calls
    }

    fn next_id(&mut self) -> String {
        self.synthetic_ids += 1;
        format!("call-{}", self.synthetic_ids)
    }
}

fn chunk(kind: &str, text: &str) -> Value {
    json!({"sessionUpdate": kind, "content": {"type": "text", "text": text}})
}

/// What of `full` the client has not seen, given the fragments `streamed` so far. A final text
/// that does not extend the streamed fragments (the agent cleaned it up) is not sent again.
fn unsent(full: &str, streamed: &str) -> Option<String> {
    if full.trim().is_empty() {
        return None;
    }
    if streamed.is_empty() {
        return Some(full.to_string());
    }
    let rest = full.strip_prefix(streamed)?;
    (!rest.is_empty()).then(|| rest.to_string())
}

/// Plain text of a message's content: a string, or the text parts of a parts list.
pub fn content_text(content: Option<&Value>) -> String {
    match content {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(parts)) => parts
            .iter()
            .filter(|p| matches!(p.get("type").and_then(Value::as_str), Some("text" | "output_text" | "input_text")))
            .filter_map(|p| p.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join(""),
        _ => String::new(),
    }
}

/// Mirrors `thinkingTextOf` in src/traj/parse.ts.
fn thinking_text(m: &Value) -> String {
    for key in ["reasoning_content", "reasoning"] {
        if let Some(s) = m.get(key).and_then(Value::as_str).filter(|s| !s.trim().is_empty()) {
            return s.to_string();
        }
    }
    let mut parts = Vec::new();
    for block in m.get("content").and_then(Value::as_array).into_iter().flatten() {
        match block.get("type").and_then(Value::as_str) {
            Some("thinking") => parts.extend(block.get("thinking").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string)),
            Some("redacted_thinking") => parts.push("(redacted thinking)".to_string()),
            _ => {}
        }
    }
    for item in m.get("output").and_then(Value::as_array).into_iter().flatten() {
        if item.get("type").and_then(Value::as_str) == Some("reasoning") {
            for entry in item.get("summary").and_then(Value::as_array).into_iter().flatten() {
                parts.extend(entry.get("text").and_then(Value::as_str).filter(|s| !s.trim().is_empty()).map(str::to_string));
            }
        }
    }
    parts.join("\n\n")
}

/// Tokens in context after this reply: the prompt the provider counted plus what it generated.
fn context_used(m: &Value) -> Option<i64> {
    let prompt = crate::compaction::prompt_tokens(m)?;
    let usage = m.pointer("/extra/response/usage");
    let completion = usage
        .and_then(|u| u.get("completion_tokens").or_else(|| u.get("output_tokens")))
        .and_then(Value::as_i64)
        .unwrap_or(0);
    Some(prompt + completion)
}

fn absolute(path: &str, cwd: &str) -> String {
    if path.is_empty() || Path::new(path).is_absolute() {
        return path.to_string();
    }
    Path::new(cwd).join(path).display().to_string()
}

fn one_line(text: &str, max: usize) -> String {
    let line = text.lines().find(|l| !l.trim().is_empty()).unwrap_or("").trim();
    let cut: String = line.chars().take(max).collect();
    if cut.len() < line.len() || text.trim().lines().count() > 1 {
        format!("{cut}…")
    } else {
        cut
    }
}

/// ACP tool kind for a mini tool name.
pub fn tool_kind(name: &str) -> &'static str {
    match name {
        "bash" | "code" | "codejs" => "execute",
        "read" => "read",
        "write" | "edit" => "edit",
        "grep" | "glob" | "search" => "search",
        n if n.starts_with("mcp__cu__") => "fetch",
        "think" => "think",
        _ => "other",
    }
}

/// The `tool_call` update announcing one action.
pub fn tool_call(id: &str, name: &str, args: &Value, cwd: &str) -> Value {
    let s = |k: &str| args.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let path = absolute(&s("path"), cwd);
    let mut raw = args.as_object().cloned().unwrap_or_default();
    let title = match name {
        "bash" => {
            let cmd = s("command");
            if cmd.trim().is_empty() { "bash".to_string() } else { one_line(&cmd, 160) }
        }
        "read" => format!("Read {}", s("path")),
        "write" => {
            raw.insert("filePath".into(), json!(path));
            raw.insert("newString".into(), json!(s("content")));
            format!("Write {}", s("path"))
        }
        "edit" => {
            raw.insert("filePath".into(), json!(path));
            let edits = args.get("edits").and_then(Value::as_array).cloned().unwrap_or_default();
            let pair = |e: &Value, a: &str, b: &str| e.get(a).or_else(|| e.get(b)).and_then(Value::as_str).map(str::to_string);
            let single = match edits.as_slice() {
                [only] => Some(only.clone()),
                [] => Some(args.clone()),
                _ => None,
            };
            if let Some(e) = single {
                if let (Some(old), Some(new)) = (pair(&e, "oldText", "old_string"), pair(&e, "newText", "new_string")) {
                    raw.insert("oldString".into(), json!(old));
                    raw.insert("newString".into(), json!(new));
                }
            }
            format!("Edit {}", s("path"))
        }
        n if n.starts_with("mcp__") => {
            let mut parts = n.trim_start_matches("mcp__").splitn(2, "__");
            let server = parts.next().unwrap_or("");
            match parts.next() {
                Some(tool) => format!("{server}: {tool}"),
                None => server.to_string(),
            }
        }
        n => n.to_string(),
    };
    let mut update = json!({
        "sessionUpdate": "tool_call",
        "toolCallId": id,
        "name": name,
        "title": title,
        "kind": tool_kind(name),
        "status": "in_progress",
        "rawInput": Value::Object(raw),
    });
    if !path.is_empty() {
        update["locations"] = json!([{"path": path}]);
    }
    update
}

/// The `tool_call_update` closing one action with its observation message.
pub fn tool_result(id: &str, m: &Value) -> Value {
    let extra = m.get("extra").cloned().unwrap_or(json!({}));
    let content = m.get("content");
    let parsed: Option<Value> = match content {
        Some(Value::String(s)) => serde_json::from_str::<Value>(s).ok().filter(Value::is_object),
        Some(v @ Value::Object(_)) => Some(v.clone()),
        _ => None,
    };
    let field = |k: &str| extra.get(k).cloned().or_else(|| parsed.as_ref().and_then(|p| p.get(k).cloned()));
    let output = match extra.get("raw_output").and_then(Value::as_str) {
        Some(s) => s.to_string(),
        None => match parsed.as_ref().and_then(|p| p.get("output")) {
            Some(Value::String(s)) => s.clone(),
            Some(other) => other.to_string(),
            None => content_text(content),
        },
    };
    let returncode = field("returncode").and_then(|v| v.as_i64());
    let exception = field("exception_info").and_then(|v| v.as_str().map(str::to_string)).filter(|s| !s.trim().is_empty());
    let failed = exception.is_some() || returncode.is_some_and(|c| c != 0);
    let mut text = output;
    if let Some(e) = &exception {
        if !text.contains(e.as_str()) {
            text = if text.is_empty() { e.clone() } else { format!("{text}\n{e}") };
        }
    }
    let text = bound(&text);
    let mut raw = json!({"output": text});
    if let Some(code) = returncode {
        raw["returncode"] = json!(code);
    }
    if let Some(e) = exception {
        raw["message"] = json!(bound(&e));
    }
    json!({
        "sessionUpdate": "tool_call_update",
        "toolCallId": id,
        "status": if failed { "failed" } else { "completed" },
        "content": [{"type": "content", "content": {"type": "text", "text": text}}],
        "rawOutput": raw,
    })
}

fn bound(text: &str) -> String {
    if text.chars().count() <= MAX_OUTPUT_CHARS {
        return text.to_string();
    }
    let head: String = text.chars().take(MAX_OUTPUT_CHARS).collect();
    format!("{head}\n… [output truncated]")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn kinds(updates: &[Value]) -> Vec<String> {
        updates.iter().map(|u| u["sessionUpdate"].as_str().unwrap().to_string()).collect()
    }

    #[test]
    fn bash_call_and_result_become_tool_call_and_update() {
        let mut m = Mapper::new("/repo", "openai/gpt-mock", false);
        let assistant = json!({"role": "assistant", "content": null,
            "tool_calls": [{"id": "call_1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\": \"ls -la\"}"}}],
            "extra": {"actions": [{"command": "ls -la", "tool_call_id": "call_1"}]}});
        let out = m.record(&json!({"t": "msg", "m": assistant}));
        assert_eq!(kinds(&out), vec!["tool_call"]);
        assert_eq!(out[0]["toolCallId"], json!("call_1"));
        assert_eq!(out[0]["kind"], json!("execute"));
        assert_eq!(out[0]["title"], json!("ls -la"));
        assert_eq!(out[0]["status"], json!("in_progress"));
        assert_eq!(out[0]["rawInput"], json!({"command": "ls -la"}));

        let tool = json!({"content": "{\"returncode\": 0, \"output\": \"a\\n\"}", "extra": {"raw_output": "a\n", "returncode": 0}, "tool_call_id": "call_1", "role": "tool"});
        let out = m.record(&json!({"t": "msg", "m": tool}));
        assert_eq!(out, vec![json!({"sessionUpdate": "tool_call_update", "toolCallId": "call_1", "status": "completed",
            "content": [{"type": "content", "content": {"type": "text", "text": "a\n"}}], "rawOutput": {"output": "a\n", "returncode": 0}})]);
    }

    #[test]
    fn failing_command_is_a_failed_tool_call() {
        let tool = json!({"role": "tool", "tool_call_id": "c", "content": "{\"returncode\": 2, \"output\": \"boom\"}"});
        let out = tool_result("c", &tool);
        assert_eq!(out["status"], json!("failed"));
        assert_eq!(out["rawOutput"], json!({"output": "boom", "returncode": 2}));
        let exc = json!({"role": "tool", "tool_call_id": "c", "content": "x", "extra": {"raw_output": "", "exception_info": "timed out"}});
        assert_eq!(tool_result("c", &exc)["status"], json!("failed"));
        assert_eq!(tool_result("c", &exc)["content"][0]["content"]["text"], json!("timed out"));
    }

    #[test]
    fn streamed_deltas_are_not_repeated_by_the_final_message() {
        let mut m = Mapper::new("/repo", "m", false);
        let a = m.record(&json!({"t": "delta", "k": "thinking", "x": "plan "}));
        let b = m.record(&json!({"t": "delta", "k": "text", "x": "Hel"}));
        assert_eq!(kinds(&a), vec!["agent_thought_chunk"]);
        assert_eq!(b[0]["content"]["text"], json!("Hel"));
        let out = m.record(&json!({"t": "msg", "m": {"role": "assistant", "content": "Hello", "reasoning_content": "plan it"}}));
        assert_eq!(kinds(&out), vec!["agent_thought_chunk", "agent_message_chunk"]);
        assert_eq!(out[0]["content"]["text"], json!("it"));
        assert_eq!(out[1]["content"]["text"], json!("lo"));
        // Fragments reset with each message: the next reply is sent whole.
        let out = m.record(&json!({"t": "msg", "m": {"role": "assistant", "content": "Bye"}}));
        assert_eq!(out[0]["content"]["text"], json!("Bye"));
    }

    #[test]
    fn exit_records_status_and_sends_unseen_submission() {
        let mut m = Mapper::new("/repo", "m", false);
        let out = m.record(&json!({"t": "msg", "m": {"role": "exit", "content": "", "extra": {"exit_status": "Submitted", "submission": "Done."}}}));
        assert_eq!(out[0]["content"]["text"], json!("Done."));
        assert_eq!(m.exit_status.as_deref(), Some("Submitted"));
        let mut m = Mapper::new("/repo", "m", false);
        m.record(&json!({"t": "msg", "m": {"role": "assistant", "content": "Done."}}));
        let out = m.record(&json!({"t": "msg", "m": {"role": "exit", "content": "", "extra": {"exit_status": "Submitted", "submission": "Done."}}}));
        assert!(out.is_empty());
    }

    #[test]
    fn user_messages_only_replay_follow_ups() {
        let follow = json!({"role": "user", "content": "The user added a new task: and the tests", "extra": {"interrupt_type": "UserNewTask"}});
        let compaction = json!({"role": "user", "content": "summary", "extra": {"interrupt_type": "Compaction"}});
        let mut live = Mapper::new("/r", "m", false);
        assert!(live.message(&follow).is_empty());
        let mut replay = Mapper::new("/r", "m", true);
        let out = replay.message(&follow);
        assert_eq!(out, vec![json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": "and the tests"}})]);
        assert!(replay.message(&compaction).is_empty());
        assert!(replay.record(&json!({"t": "delta", "k": "text", "x": "partial"})).is_empty());
    }

    #[test]
    fn native_tools_map_to_kinds_titles_and_edit_details() {
        let edit = tool_call("e1", "edit", &json!({"path": "src/a.rs", "edits": [{"oldText": "1", "newText": "2"}]}), "/repo");
        assert_eq!(edit["kind"], json!("edit"));
        assert_eq!(edit["title"], json!("Edit src/a.rs"));
        assert_eq!(edit["rawInput"]["filePath"], json!("/repo/src/a.rs"));
        assert_eq!(edit["rawInput"]["oldString"], json!("1"));
        assert_eq!(edit["rawInput"]["newString"], json!("2"));
        assert_eq!(edit["locations"], json!([{"path": "/repo/src/a.rs"}]));
        let read = tool_call("r1", "read", &json!({"path": "/etc/hosts"}), "/repo");
        assert_eq!((read["kind"].as_str(), read["title"].as_str()), (Some("read"), Some("Read /etc/hosts")));
        let mcp = tool_call("m1", "mcp__github__search_issues", &json!({"q": "x"}), "/repo");
        assert_eq!((mcp["kind"].as_str(), mcp["title"].as_str()), (Some("other"), Some("github: search_issues")));
        assert!(mcp.get("locations").is_none());
        let multi = tool_call("b1", "bash", &json!({"command": "cd x\nmake"}), "/repo");
        assert_eq!(multi["title"], json!("cd x…"));
    }

    #[test]
    fn text_based_actions_close_with_the_next_observation() {
        let mut m = Mapper::new("/r", "m", false);
        let out = m.message(&json!({"role": "assistant", "content": "THOUGHT: look\n```bash\nls\n```", "extra": {"actions": [{"command": "ls"}]}}));
        assert_eq!(kinds(&out), vec!["agent_message_chunk", "tool_call"]);
        let id = out[1]["toolCallId"].as_str().unwrap().to_string();
        let out = m.message(&json!({"role": "user", "content": "<returncode>0</returncode>", "extra": {"raw_output": "a", "returncode": 0}}));
        assert_eq!(out[0]["toolCallId"], json!(id));
    }

    #[test]
    fn usage_needs_a_known_window_and_changes() {
        let mut m = Mapper::new("/r", "openai/gpt-4o-mini", false);
        m.message(&json!({"role": "assistant", "content": "x", "extra": {"response": {"usage": {"prompt_tokens": 1000, "completion_tokens": 20}}}}));
        let info = json!({"t": "info", "i": {"model_stats": {"instance_cost": 0.25, "api_calls": 1}}});
        let out = m.record(&info);
        assert_eq!(out, vec![json!({"sessionUpdate": "usage_update", "used": 1020, "size": 128000, "cost": {"amount": 0.25, "currency": "USD"}})]);
        assert!(m.record(&info).is_empty());
        let mut unknown = Mapper::new("/r", "ollama/some-local-model", false);
        unknown.message(&json!({"role": "assistant", "content": "x", "extra": {"response": {"usage": {"prompt_tokens": 5}}}}));
        assert!(unknown.record(&info).is_empty());
    }
}
