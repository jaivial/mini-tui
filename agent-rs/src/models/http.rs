//! HTTP for the direct clients: JSON POST, SSE streaming reassembly, provider error
//! classification (`models/errors.py`) and the retry policy (`utils/retry.py`).

use super::{DeltaSink, ModelError};
use crate::util::get;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Read};
use std::sync::OnceLock;
use std::time::Duration;

fn agent(timeout: f64) -> ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT
        .get_or_init(|| {
            ureq::AgentBuilder::new()
                .timeout_read(Duration::from_secs_f64(timeout.max(1.0)))
                .timeout_connect(Duration::from_secs(30))
                .build()
        })
        .clone()
}

const ABORT_STATUSES: [u16; 7] = [400, 401, 402, 403, 404, 413, 422];

/// `classify_status`: which HTTP errors are worth retrying.
pub fn classify_status(status: u16, detail: &str, base: &str) -> ModelError {
    let detail500: String = detail.chars().take(500).collect();
    let mut message = format!("HTTP {status} from {base}: {detail500}");
    let lowered = detail.to_lowercase();
    if ABORT_STATUSES.contains(&status) && !lowered.contains("rate limit") {
        if status == 401 || status == 403 {
            message.push_str(" Check the API key (`mini-extra config set KEY VALUE`).");
        }
        if status == 402 {
            message.push_str(" Top up your balance — retrying will not fix this.");
        }
        return ModelError { message, status: Some(status), abort: true, kind: "ProviderAbortError".into() };
    }
    ModelError { message, status: Some(status), abort: false, kind: "ProviderError".into() }
}

fn http_error(status: u16, text: &str, base: &str) -> ModelError {
    let detail = match serde_json::from_str::<Value>(text) {
        Ok(v) => match v.get("error") {
            Some(Value::Object(o)) => o.get("message").map(value_text).unwrap_or_else(|| value_text(&Value::Object(o.clone()))),
            Some(e) if !e.is_null() && e != &Value::Bool(false) && e.as_str() != Some("") => value_text(e),
            _ => text.to_string(),
        },
        Err(_) => text.to_string(),
    };
    classify_status(status, &detail, base)
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => crate::util::py_json(other, false),
    }
}

fn transport_error(e: &dyn std::fmt::Display, base: &str) -> ModelError {
    ModelError { message: format!("{e} ({base})"), status: None, abort: false, kind: "ProviderError".into() }
}

fn request(url: &str, headers: &[(String, String)], timeout: f64, accept: &str) -> ureq::Request {
    let mut req = agent(timeout).post(url).set("Content-Type", "application/json").set("Accept", accept).timeout(Duration::from_secs_f64(timeout.max(1.0)));
    for (k, v) in headers {
        req = req.set(k, v);
    }
    req
}

fn stopped() -> ModelError {
    ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterrupt".into() }
}

/// Run a blocking HTTP call on a worker thread so a stop signal is seen at once: std's socket
/// reads retry on EINTR, so a signal alone never ends a read that is waiting on the network.
/// Streamed fragments come back over a channel and reach `sink` on this thread.
fn interruptible<T: Send + 'static>(
    sink: &mut Option<DeltaSink>,
    work: impl FnOnce(&mut dyn FnMut(&str, &str)) -> Result<T, ModelError> + Send + 'static,
) -> Result<T, ModelError> {
    use std::sync::atomic::Ordering;
    use std::sync::mpsc;
    enum Msg<T> {
        Delta(String, String),
        Done(Result<T, ModelError>),
    }
    let (tx, rx) = mpsc::channel::<Msg<T>>();
    let delta_tx = tx.clone();
    std::thread::spawn(move || {
        let mut forward = |k: &str, t: &str| {
            let _ = delta_tx.send(Msg::Delta(k.to_string(), t.to_string()));
        };
        let result = work(&mut forward);
        let _ = tx.send(Msg::Done(result));
    });
    loop {
        if crate::agent::STOP.load(Ordering::SeqCst) {
            return Err(stopped()); // the worker is abandoned; the process is about to exit
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Delta(k, t)) => {
                if let Some(s) = sink.as_mut() {
                    s(&k, &t);
                }
            }
            Ok(Msg::Done(r)) => return r,
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => return Err(transport_error(&"worker thread ended", "")),
        }
    }
}

/// POST `body` as JSON and parse the JSON reply (interruptible by a stop signal).
pub fn post_json(base: &str, path: &str, body: &Value, headers: &[(String, String)], timeout: f64) -> Result<Value, ModelError> {
    let (base, path, body, headers) = (base.to_string(), path.to_string(), body.clone(), headers.to_vec());
    interruptible(&mut None, move |_| post_json_blocking(&base, &path, &body, &headers, timeout))
}

fn post_json_blocking(base: &str, path: &str, body: &Value, headers: &[(String, String)], timeout: f64) -> Result<Value, ModelError> {
    let url = format!("{}{}", base.trim_end_matches('/'), path);
    let payload = serde_json::to_string(body).unwrap();
    match request(&url, headers, timeout, "application/json").send_string(&payload) {
        Ok(resp) => {
            let text = resp.into_string().map_err(|e| transport_error(&e, base))?;
            serde_json::from_str(&text).map_err(|_| ModelError {
                message: format!("invalid JSON from {base}: {}", text.chars().take(300).collect::<String>()),
                status: None,
                abort: false,
                kind: "ProviderError".into(),
            })
        }
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            Err(http_error(code, &text, base))
        }
        Err(e) => Err(transport_error(&e, base)),
    }
}

/// POST with `stream: true` and rebuild the chat-completions body from the SSE chunks
/// (interruptible by a stop signal; fragments reach `sink` as they arrive).
pub fn post_chat_stream(base: &str, body: &Value, headers: &[(String, String)], timeout: f64, sink: &mut Option<DeltaSink>) -> Result<Value, ModelError> {
    let (base, body, headers) = (base.to_string(), body.clone(), headers.to_vec());
    interruptible(sink, move |forward| {
        let mut forward: Option<DeltaSink> = Some(forward);
        post_chat_stream_blocking(&base, &body, &headers, timeout, &mut forward)
    })
}

fn post_chat_stream_blocking(base: &str, body: &Value, headers: &[(String, String)], timeout: f64, sink: &mut Option<DeltaSink>) -> Result<Value, ModelError> {
    let url = format!("{}/chat/completions", base.trim_end_matches('/'));
    let mut body = body.clone();
    body["stream"] = json!(true);
    let payload = serde_json::to_string(&body).unwrap();
    let resp = match request(&url, headers, timeout, "text/event-stream").send_string(&payload) {
        Ok(r) => r,
        Err(ureq::Error::Status(code, resp)) => {
            let text = resp.into_string().unwrap_or_default();
            return Err(http_error(code, &text, base));
        }
        Err(e) => return Err(transport_error(&e, base)),
    };
    let content_type = resp.header("Content-Type").unwrap_or("").to_lowercase();
    if !content_type.contains("text/event-stream") {
        let text = resp.into_string().map_err(|e| transport_error(&e, base))?;
        return serde_json::from_str(&text).map_err(|e| transport_error(&e, base));
    }
    read_chat_sse(resp.into_reader(), sink).map_err(|e| transport_error(&e, base))
}

/// Reassemble an OpenAI-compatible SSE body: content, reasoning, tool calls, usage.
pub fn read_chat_sse(reader: impl Read, sink: &mut Option<DeltaSink>) -> std::io::Result<Value> {
    let mut content = String::new();
    let mut reasoning = String::new();
    let mut calls: std::collections::BTreeMap<i64, Value> = Default::default();
    let mut role = String::new();
    let mut finish: Option<Value> = None;
    let mut usage: Option<Value> = None;
    for line in BufReader::new(reader).split(b'\n') {
        let line = line?;
        let line = String::from_utf8_lossy(&line);
        let line = line.trim();
        if line.is_empty() || line.starts_with(':') || !line.starts_with("data:") {
            continue;
        }
        let data = line[5..].trim();
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        let Ok(chunk) = serde_json::from_str::<Value>(data) else { continue };
        if let Some(u) = chunk.get("usage").filter(|u| u.is_object()) {
            usage = Some(u.clone());
        }
        for choice in chunk.get("choices").and_then(Value::as_array).cloned().unwrap_or_default() {
            if !choice.is_object() {
                continue;
            }
            if let Some(f) = choice.get("finish_reason").filter(|f| !f.is_null() && f.as_str() != Some("")) {
                finish = Some(f.clone());
            }
            let Some(delta) = choice.get("delta").filter(|d| d.is_object()) else { continue };
            if let Some(r) = delta.get("role").and_then(Value::as_str).filter(|r| !r.is_empty()) {
                role = r.to_string();
            }
            if let Some(piece) = delta.get("content").and_then(Value::as_str).filter(|p| !p.is_empty()) {
                content.push_str(piece);
                if let Some(s) = sink.as_mut() {
                    s("text", piece);
                }
            }
            let rpiece = delta.get("reasoning_content").and_then(Value::as_str).filter(|p| !p.is_empty()).or_else(|| delta.get("reasoning").and_then(Value::as_str));
            if let Some(piece) = rpiece.filter(|p| !p.is_empty()) {
                reasoning.push_str(piece);
                if let Some(s) = sink.as_mut() {
                    s("thinking", piece);
                }
            }
            for call in delta.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default() {
                if !call.is_object() {
                    continue;
                }
                let index = call.get("index").and_then(Value::as_i64).unwrap_or(0);
                let slot = calls.entry(index).or_insert_with(|| json!({"id": "", "type": "function", "function": {"name": "", "arguments": ""}}));
                if let Some(id) = call.get("id").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                    slot["id"] = json!(id);
                }
                if let Some(f) = call.get("function").filter(|f| f.is_object()) {
                    if let Some(n) = f.get("name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
                        slot["function"]["name"] = json!(n);
                    }
                    if let Some(a) = f.get("arguments").and_then(Value::as_str) {
                        let prev = slot["function"]["arguments"].as_str().unwrap_or("").to_string();
                        slot["function"]["arguments"] = json!(prev + a);
                    }
                }
            }
        }
    }
    let mut message = json!({"role": if role.is_empty() { "assistant".to_string() } else { role }, "content": content});
    if !reasoning.is_empty() {
        message["reasoning_content"] = json!(reasoning);
    }
    if !calls.is_empty() {
        message["tool_calls"] = Value::Array(calls.into_values().collect());
    }
    let mut result = json!({"choices": [{"index": 0, "message": message, "finish_reason": finish.unwrap_or(json!("stop"))}]});
    if let Some(u) = usage {
        result["usage"] = u;
    }
    Ok(result)
}

/// Retry transient errors: `MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT` attempts (default 10),
/// exponential wait between 4 and 60 seconds; abort errors are raised at once.
pub fn with_retry<T>(mut call: impl FnMut() -> Result<T, ModelError>) -> Result<T, ModelError> {
    let attempts: u32 = std::env::var("MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT").ok().and_then(|s| s.parse().ok()).unwrap_or(10).max(1);
    let min_wait: f64 = std::env::var("MINI_AGENT_RETRY_MIN_WAIT").ok().and_then(|s| s.parse().ok()).unwrap_or(4.0);
    let mut attempt = 0;
    loop {
        attempt += 1;
        match call() {
            Ok(v) => return Ok(v),
            Err(e) if e.abort || attempt >= attempts => return Err(e),
            Err(e) => {
                let wait = retry_wait(attempt, min_wait);
                eprintln!("WARNING: Retrying in {wait:.1} seconds as it raised {}: {}.", e.kind, e.message);
                if !crate::agent::interruptible_sleep(Duration::from_secs_f64(wait)) {
                    return Err(ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterrupt".into() });
                }
            }
        }
    }
}

/// tenacity's `wait_exponential(multiplier=1, min=4, max=60)`: 2**(attempt-1) clamped,
/// so 4, 4, 4, 8, 16, 32, 60 seconds.
fn retry_wait(attempt: u32, min_wait: f64) -> f64 {
    (2f64.powi(attempt as i32 - 1)).clamp(min_wait.min(60.0), 60.0)
}

pub fn usage_of(response: &Value) -> Value {
    get(response, "usage").cloned().unwrap_or(Value::Null)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sse_reassembly() {
        let body = concat!(
            "data: {\"choices\":[{\"delta\":{\"role\":\"assistant\",\"content\":\"Hel\"}}]}\n\n",
            ": keep-alive\n",
            "data: {\"choices\":[{\"delta\":{\"content\":\"lo\",\"reasoning_content\":\"hmm\"}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"id\":\"c1\",\"function\":{\"name\":\"bash\",\"arguments\":\"{\\\"comm\"}}]}}]}\n",
            "data: {\"choices\":[{\"delta\":{\"tool_calls\":[{\"index\":0,\"function\":{\"arguments\":\"and\\\": \\\"ls\\\"}\"}}]},\"finish_reason\":\"tool_calls\"}]}\n",
            "data: {\"usage\":{\"prompt_tokens\":10,\"completion_tokens\":2},\"choices\":[]}\n",
            "data: [DONE]\n",
        );
        let mut seen = Vec::new();
        let mut f = |k: &str, t: &str| seen.push(format!("{k}:{t}"));
        let mut sink: Option<DeltaSink> = Some(&mut f);
        let v = read_chat_sse(body.as_bytes(), &mut sink).unwrap();
        assert_eq!(v["choices"][0]["message"]["content"], "Hello");
        assert_eq!(v["choices"][0]["message"]["reasoning_content"], "hmm");
        assert_eq!(v["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"], "{\"command\": \"ls\"}");
        assert_eq!(v["choices"][0]["finish_reason"], "tool_calls");
        assert_eq!(v["usage"]["prompt_tokens"], 10);
        drop(sink);
        assert_eq!(seen, vec!["text:Hel", "text:lo", "thinking:hmm"]);
    }

    #[test]
    fn retry_waits_like_tenacity() {
        let waits: Vec<f64> = (1..=7).map(|a| retry_wait(a, 4.0)).collect();
        assert_eq!(waits, vec![4.0, 4.0, 4.0, 8.0, 16.0, 32.0, 60.0]);
    }

    #[test]
    fn classifies() {
        assert!(classify_status(401, "bad key", "b").abort);
        assert!(!classify_status(429, "slow down", "b").abort);
        assert!(!classify_status(400, "Rate limit reached", "b").abort);
        assert!(!classify_status(503, "down", "b").abort);
    }
}
