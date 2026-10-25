//! Work-queue tools: what the web app's dispatcher and its background workers call.
//!
//! The web app is one chat (the DISPATCHER) in front of a work queue. The dispatcher has no
//! shell: it turns each request into a well-written task (`task_create`), or sends a correction
//! to a task already in flight (`task_redirect`). Every task runs as its own background session
//! (a WORKER), which keeps its card's description current (`task_update`) and can tell the
//! dispatcher something mid-task (`task_notify`).
//!
//! The queue itself lives in the web server (`src/web/workQueue.ts`); these tools are thin
//! loopback HTTP calls to it (`MINITUI_QUEUE_URL`). The profile is chosen by the spawner:
//! `MINI_AGENT_TOOLSET=dispatcher` gives ONLY the queue tools, `MINI_AGENT_TOOLSET=worker` adds
//! the worker's two to the normal tool list and drops the subagent tools.

use serde_json::{json, Value};
use std::time::Duration;

/// The tool profile the spawner asked for ("" when none: a plain run, unchanged).
pub fn toolset() -> String {
    std::env::var("MINI_AGENT_TOOLSET").unwrap_or_default()
}

/// The dispatcher: queue tools only, no shell, no files.
pub fn dispatcher() -> bool {
    toolset() == "dispatcher"
}

/// A queue profile is active: the subagent tools (`agent_*`) are not offered.
pub fn active() -> bool {
    matches!(toolset().as_str(), "dispatcher" | "worker")
}

fn queue_url() -> Option<String> {
    std::env::var("MINITUI_QUEUE_URL").ok().filter(|v| !v.trim().is_empty()).map(|v| v.trim_end_matches('/').to_string())
}

fn task_id() -> String {
    std::env::var("MINITUI_TASK_ID").unwrap_or_default()
}

fn task_schema() -> Value {
    json!({
        "type": "object",
        "properties": {
            "title": {"type": "string", "description": "short title, at most 6 words, in the user's language"},
            "description": {"type": "string", "description": "one sentence: what this task delivers"},
            "prompt": {"type": "string", "description": "the complete, self-contained brief this part's worker receives (its ONLY input): goal, deliverables, working directory, constraints, every literal from the request copied verbatim, acceptance criteria, how to verify"},
            "cwd": {"type": "string", "description": "optional working directory (absolute or ~/...) when the request names one"},
            "allow_overlap": {"type": "boolean", "description": "For independent fan-out, set false on EVERY part: the queue then requires disjoint working directories. Omit for sequential work that may share a directory."}
        },
        "required": ["title", "description", "prompt"]
    })
}

fn dispatcher_specs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "task_create",
            "Queue background tasks. Each task runs as its own autonomous coding agent (shell, files, browser) in the background; \
             up to the configured concurrency run at once and the rest wait in the queue. ONE task: give title, description, cwd \
             and optional notes (the worker receives the human's message verbatim). SEVERAL independent tasks from one message: \
             `tasks`, each with its own self-contained prompt. If an ACTIVE task covers the same deliverable, the call is refused with that task's id: redirect it \
             instead, or repeat the call with `new_task: true` when it really is different work.",
            json!({
                "type": "object",
                "properties": {
                    "title": {"type": "string", "description": "short title, at most 6 words, in the user's language"},
                    "description": {"type": "string", "description": "one sentence: what this task delivers"},
                    "notes": {"type": "string", "description": "ONE task from the human's message: omit `prompt`; the worker gets the human's message verbatim plus these notes (at most 3 short lines: acceptance criteria, how to verify)"},
                    "cwd": {"type": "string", "description": "working directory when the request names one"},
                    "tasks": {"type": "array", "description": "several tasks at once, each {title, description, prompt, cwd?}", "items": task_schema()},
                    "new_task": {"type": "boolean", "description": "true = create even though a similar active task exists"}
                }
            }),
        ),
        (
            "task_redirect",
            "Redirect an existing task with a correction, an extra requirement or a small variation, instead of creating a \
             near-duplicate. A running task's agent reads the message before its next step; a queued task gets it added to its \
             brief; a finished task is re-opened with it and queued again.",
            json!({
                "type": "object",
                "properties": {
                    "id": {"type": "string", "description": "the task id (e.g. t12)"},
                    "message": {"type": "string", "description": "what to change or add, complete and concrete"}
                },
                "required": ["id", "message"]
            }),
        ),
        (
            "task_cancel",
            "Cancel a queued or running task (only when the human asks for it).",
            json!({
                "type": "object",
                "properties": {"id": {"type": "string", "description": "the task id"}},
                "required": ["id"]
            }),
        ),
        (
            "task_status",
            "Read the queue, or one task in detail. For a RUNNING task it returns the worker's live progress: its last \
             commands and their results, what it is writing right now, model calls and time so far. Use it whenever the \
             human asks how a task is going, what a worker is doing, or whether it is stuck.",
            json!({
                "type": "object",
                "properties": {"id": {"type": "string", "description": "optional: one task's full detail"}}
            }),
        ),
    ]
}

fn worker_specs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "task_update",
            "Update the description on your task card (what the human sees in the task panel). One sentence on what you are \
             doing or what you found. Batch it with other tool calls, never as a turn of its own.",
            json!({
                "type": "object",
                "properties": {"description": {"type": "string", "description": "the new description, one sentence"}},
                "required": ["description"]
            }),
        ),
        (
            "task_show_browser",
            "Show the human your browser. Opens the app's browser panel on the given cu tab, live, so the human can look \
             (\"here is how the page looks\") or intervene with their own mouse and keyboard: solve a captcha, scan a QR \
             code, approve a login or a 2FA prompt. Say in `message` what you need them to do; with `wait_seconds` the \
             call returns once the human says they are done (or the time is up), so you can continue.",
            json!({
                "type": "object",
                "properties": {
                    "tab": {"type": "string", "description": "the cu tab id (from `cu tabs` / `tab open`)"},
                    "message": {"type": "string", "description": "what the human should look at or do"},
                    "wait_seconds": {"type": "number", "description": "wait up to this long for the human to finish (0 = do not wait)"}
                },
                "required": ["tab", "message"]
            }),
        ),
        (
            "task_notify",
            "Send a message to the dispatcher (the main agent the human talks to) without stopping: a blocker that needs \
             the human, or an important finding. Not for progress reports: those go in task_update.",
            json!({
                "type": "object",
                "properties": {"message": {"type": "string", "description": "the message"}},
                "required": ["message"]
            }),
        ),
    ]
}

fn specs() -> Vec<(&'static str, &'static str, Value)> {
    match toolset().as_str() {
        "dispatcher" => dispatcher_specs(),
        "worker" if !task_id().is_empty() => worker_specs(),
        _ => vec![],
    }
}

pub fn is_tool(name: &str) -> bool {
    matches!(name, "task_create" | "task_redirect" | "task_cancel" | "task_status" | "task_update" | "task_notify" | "task_show_browser")
        && specs().iter().any(|(n, _, _)| *n == name)
}

pub fn chat_tools() -> Vec<Value> {
    specs().into_iter().map(|(n, d, p)| json!({"type": "function", "function": {"name": n, "description": d, "parameters": p}})).collect()
}

pub fn responses_tools() -> Vec<Value> {
    specs().into_iter().map(|(n, d, p)| json!({"type": "function", "name": n, "description": d, "parameters": p})).collect()
}

pub fn anthropic_tools() -> Vec<Value> {
    specs().into_iter().map(|(n, d, p)| json!({"name": n, "description": d, "input_schema": p})).collect()
}

fn post(path: &str, body: &Value) -> Result<Value, String> {
    // The queue answers in milliseconds; a server that hangs must not hold the worker's turn.
    post_timeout(path, body, 10.0)
}

fn post_timeout(path: &str, body: &Value, timeout_s: f64) -> Result<Value, String> {
    let base = queue_url().ok_or("the work queue is not reachable from this run (MINITUI_QUEUE_URL is not set)")?;
    let url = format!("{base}{path}");
    let token = std::env::var("MINITUI_QUEUE_TOKEN").unwrap_or_default();
    let resp = ureq::post(&url)
        .set("Content-Type", "application/json")
        .set("x-queue-token", &token)
        .timeout(Duration::from_secs_f64(timeout_s.max(1.0)))
        .send_string(&body.to_string());
    let text = match resp {
        Ok(r) => r.into_string().map_err(|e| e.to_string())?,
        Err(ureq::Error::Status(code, r)) => {
            let text = r.into_string().unwrap_or_default();
            let msg = serde_json::from_str::<Value>(&text).ok().and_then(|v| v.get("error").and_then(Value::as_str).map(String::from)).unwrap_or(text);
            return Err(format!("HTTP {code}: {msg}"));
        }
        Err(e) => return Err(e.to_string()),
    };
    serde_json::from_str(&text).map_err(|_| format!("invalid reply from the queue: {}", text.chars().take(200).collect::<String>()))
}

fn ok(text: String) -> Value {
    json!({"output": text, "returncode": 0, "exception_info": ""})
}

fn fail(text: String) -> Value {
    json!({"output": text, "returncode": 1, "exception_info": ""})
}

/// Execute one queue tool call. The server's reply carries a ready-made `text` for the model.
pub fn outcome(name: &str, args: &Value) -> Value {
    let id = |a: &Value| a.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let main = std::env::var("MINITUI_SESSION_ID").unwrap_or_default();
    let result = match name {
        "task_create" => post("/tasks", &json!({"spec": args, "origin": main})),
        "task_redirect" => post(&format!("/tasks/{}/redirect", id(args)), &json!({"message": args.get("message").cloned().unwrap_or(Value::Null)})),
        "task_cancel" => post(&format!("/tasks/{}/cancel", id(args)), &json!({})),
        "task_status" => post("/status", &json!({"id": id(args)})),
        "task_update" => post(&format!("/tasks/{}/update", task_id()), &json!({"description": args.get("description").cloned().unwrap_or(Value::Null)})),
        "task_notify" => post(&format!("/tasks/{}/notify", task_id()), &json!({"message": args.get("message").cloned().unwrap_or(Value::Null)})),
        "task_show_browser" => {
            let wait = args.get("wait_seconds").and_then(Value::as_f64).unwrap_or(0.0).clamp(0.0, 1800.0);
            post_timeout(&format!("/tasks/{}/browser", task_id()), &json!({"tab": args.get("tab").cloned().unwrap_or(Value::Null), "message": args.get("message").cloned().unwrap_or(Value::Null), "wait_seconds": wait}), wait + 15.0)
        }
        _ => Err(format!("unknown queue tool {name}")),
    };
    match result {
        Ok(v) => {
            let text = v.get("text").and_then(Value::as_str).map(String::from).unwrap_or_else(|| v.to_string());
            if v.get("ok").and_then(Value::as_bool) == Some(false) { fail(text) } else { ok(text) }
        }
        Err(e) => fail(format!("{name} failed: {e}")),
    }
}

/// The dispatcher's closing text when every action of its step queued, redirected or cancelled
/// work and all of them succeeded: the assistant's own words plus the queue's confirmations.
/// `None` for anything else (a status read, a failure, a non-dispatcher run): the model goes on.
pub fn dispatcher_closing_text(message: &Value, outputs: &[Value]) -> Option<String> {
    if !dispatcher() {
        return None;
    }
    let actions = message.pointer("/extra/actions").and_then(Value::as_array)?;
    if actions.is_empty() || actions.len() != outputs.len() {
        return None;
    }
    let terminal = actions.iter().all(|a| matches!(a.get("tool").and_then(Value::as_str), Some("task_create" | "task_redirect" | "task_cancel")));
    let succeeded = outputs.iter().all(|o| o.get("returncode").and_then(Value::as_i64) == Some(0));
    if !terminal || !succeeded {
        return None;
    }
    // The visible text only: thinking blocks never reach the human.
    let said = match message.get("content") {
        Some(Value::String(t)) => t.trim().to_string(),
        Some(Value::Array(blocks)) => blocks
            .iter()
            .filter(|b| b.get("type").and_then(Value::as_str) == Some("text"))
            .filter_map(|b| b.get("text").and_then(Value::as_str))
            .collect::<Vec<_>>()
            .join("\n")
            .trim()
            .to_string(),
        _ => String::new(),
    };
    let confirmations: Vec<String> = outputs.iter().filter_map(|o| o.get("output").and_then(Value::as_str)).map(|t| t.trim().to_string()).filter(|t| !t.is_empty()).collect();
    let mut text = String::new();
    if !said.is_empty() {
        text.push_str(&said);
        text.push_str("\n\n");
    }
    text.push_str(&confirmations.join("\n"));
    Some(text)
}

/// Tests that set the process environment run one at a time.
#[cfg(test)]
pub static TEST_ENV: std::sync::Mutex<()> = std::sync::Mutex::new(());

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_dead_or_hung_queue_is_an_observation_not_a_stall() {
        let _g = TEST_ENV.lock().unwrap();
        std::env::set_var("MINI_AGENT_TOOLSET", "worker");
        std::env::set_var("MINITUI_TASK_ID", "t1");
        // Nothing listens: refused at once.
        std::env::set_var("MINITUI_QUEUE_URL", "http://127.0.0.1:1");
        let out = outcome("task_update", &json!({"description": "x"}));
        assert_eq!(out["returncode"], 1);
        // Accepts and never answers: bounded by the timeout.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            let _held: Vec<_> = listener.incoming().take(1).collect();
            std::thread::sleep(Duration::from_secs(30));
        });
        std::env::set_var("MINITUI_QUEUE_URL", format!("http://127.0.0.1:{port}"));
        let t0 = std::time::Instant::now();
        let out = outcome("task_notify", &json!({"message": "x"}));
        assert_eq!(out["returncode"], 1);
        assert!(t0.elapsed() < Duration::from_secs(15), "took {:?}", t0.elapsed());
        // No env at all: a clear message, not a panic.
        std::env::remove_var("MINITUI_QUEUE_URL");
        assert!(outcome("task_update", &json!({"description": "x"}))["output"].as_str().unwrap().contains("MINITUI_QUEUE_URL"));
        for k in ["MINI_AGENT_TOOLSET", "MINITUI_TASK_ID"] {
            std::env::remove_var(k);
        }
    }

    #[test]
    fn profiles_offer_their_own_tools_only() {
        let _g = TEST_ENV.lock().unwrap();
        std::env::set_var("MINI_AGENT_TOOLSET", "dispatcher");
        assert!(is_tool("task_create") && !is_tool("task_update"));
        assert_eq!(chat_tools().len(), 4);
        std::env::set_var("MINI_AGENT_TOOLSET", "worker");
        std::env::set_var("MINITUI_TASK_ID", "t1");
        assert!(is_tool("task_update") && !is_tool("task_create"));
        std::env::remove_var("MINI_AGENT_TOOLSET");
        assert!(chat_tools().is_empty() && !is_tool("task_update"));
        std::env::remove_var("MINITUI_TASK_ID");
    }
}
