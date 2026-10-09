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
            // A gateway (cli-proxy, Rosetta) fronts its own subscription login, so a 401 from it
            // is usually not the key mini sends: the upstream OAuth token is what expired. Say
            // which, or the user edits a perfectly good key and the run still fails.
            let upstream = lowered.contains("oauth") || lowered.contains("revoked") || lowered.contains("invalid_grant");
            if upstream {
                message.push_str(" This is the provider's own login, not the key mini sends: re-authenticate the subscription behind this endpoint.");
            } else {
                message.push_str(" Check the API key (`mini-extra config set KEY VALUE`).");
            }
        }
        if status == 402 {
            message.push_str(" Top up your balance — retrying will not fix this.");
        }
        return ModelError { message, status: Some(status), abort: true, kind: "ProviderAbortError".into(), connect_refused: false, retry_after: None, };
    }
    ModelError { message, status: Some(status), abort: false, kind: "ProviderError".into(), connect_refused: false, retry_after: None, }
}

/// The error for an HTTP status, plus the response's `Retry-After` headers when it sent them
/// (the retry policy honours those before any curve of ours). Pass `|_| None` when no headers
/// are available.
fn http_error_with_retry_after(status: u16, text: &str, base: &str, header: impl Fn(&str) -> Option<String>) -> ModelError {
    let detail = match serde_json::from_str::<Value>(text) {
        Ok(v) => match v.get("error") {
            Some(Value::Object(o)) => o.get("message").map(value_text).unwrap_or_else(|| value_text(&Value::Object(o.clone()))),
            Some(e) if !e.is_null() && e != &Value::Bool(false) && e.as_str() != Some("") => value_text(e),
            _ => text.to_string(),
        },
        Err(_) => text.to_string(),
    };
    let mut e = classify_status(status, &detail, base);
    if !e.abort {
        e.retry_after = retry_after_seconds(&header);
    }
    e
}

/// `retry-after-ms` then `retry-after` (seconds, or an HTTP-date), like pi's
/// `getRetryDelayMs` (packages/ai/src/utils/provider-retry.ts). None when absent or unusable.
fn retry_after_seconds(header: impl Fn(&str) -> Option<String>) -> Option<f64> {
    if let Some(ms) = header("retry-after-ms").and_then(|v| v.trim().parse::<f64>().ok()) {
        return Some((ms / 1000.0).max(0.0));
    }
    let raw = header("retry-after")?;
    let t = raw.trim();
    if t.is_empty() {
        return None;
    }
    if let Ok(secs) = t.parse::<f64>() {
        return Some(secs.max(0.0));
    }
    // HTTP-date: how far away is it? A date already past means "now".
    httpdate_seconds(t)
}

/// `Sun, 06 Nov 1994 08:49:37 GMT` -> seconds from now (0 when in the past).
fn httpdate_seconds(s: &str) -> Option<f64> {
    // strptime-style without a dependency: the formats RFC 7231 allows.
    let s = s.trim();
    let bytes = s.as_bytes();
    if bytes.len() < 24 {
        return None;
    }
    // "Sun, 06 Nov 1994 08:49:37 GMT"
    let day: u32 = s.get(5..7)?.parse().ok()?;
    let month = match s.get(8..11)? {
        "Jan" => 1, "Feb" => 2, "Mar" => 3, "Apr" => 4, "May" => 5, "Jun" => 6,
        "Jul" => 7, "Aug" => 8, "Sep" => 9, "Oct" => 10, "Nov" => 11, "Dec" => 12,
        _ => return None,
    };
    let year: i64 = s.get(12..16)?.parse().ok()?;
    let hour: u32 = s.get(17..19)?.parse().ok()?;
    let min: u32 = s.get(20..22)?.parse().ok()?;
    let sec: u32 = s.get(23..25)?.parse().ok()?;
    let days = days_from_civil(year, month, day);
    let target = days * 86400 + hour as i64 * 3600 + min as i64 * 60 + sec as i64;
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    Some((target - now).max(0) as f64)
}

/// Days since the Unix epoch from a civil date (Howard Hinnant's `days_from_civil`).
fn days_from_civil(y: i64, m: u32, d: u32) -> i64 {
    let y = if m <= 2 { y - 1 } else { y };
    let era = if y >= 0 { y } else { y - 399 } / 400;
    let yoe = y - era * 400;
    let mp = (m as i64 + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d as i64 - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    era * 146097 + doe - 719468
}

fn value_text(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        other => crate::util::py_json(other, false),
    }
}

fn transport_error(e: &dyn std::fmt::Display, base: &str) -> ModelError {
    let text = e.to_string();
    let refused = is_connect_refused(&text);
    let mut message = format!("{text} ({base})");
    if refused {
        message.push_str(&refused_hint(base));
    }
    ModelError { message, status: None, abort: false, kind: "ProviderError".into(), connect_refused: refused, retry_after: None }
}

/// What a refused connect means for a gateway mini talks to, and what to check first.
fn refused_hint(base: &str) -> String {
    let local = ["127.0.0.1", "localhost", "[::1]"].iter().any(|h| base.contains(h));
    let name = if base.contains(":8317") {
        "cli-proxy (cliproxy/)"
    } else if base.contains(":9120") {
        "rosetta"
    } else {
        "the gateway"
    };
    if local {
        // The port is the actionable bit: it is what `ss -ltn` and the service unit use.
        let host = base.split("://").nth(1).unwrap_or(base);
        let port = host.split('/').next().unwrap_or("").rsplit(':').next().unwrap_or("");
        format!(" -- {name} is not listening on port {port}: start it, or point CLIPROXY_API_BASE where it runs (`ss -ltn | grep {port}`). mini re-probes a few times a second apart before giving up")
    } else {
        format!(" -- the host at {} is unreachable: check the network, the VPN and that {name} is up there", base.trim_end_matches('/'))
    }
}

/// Does this transport error mean "nothing is listening on that address"? `ureq` wraps
/// `std::io::Error`, whose `Display` ends with the OS message, so a refused TCP connect
/// reads "Connect error: Connection refused (os error 111)". Matched on text rather than
/// by unwrapping the source chain because `ureq::Error::Transport` does not expose it.
fn is_connect_refused(text: &str) -> bool {
    let lowered = text.to_lowercase();
    if lowered.contains("connect error") {
        return lowered.contains("refused") || lowered.contains("unreachable");
    }
    lowered.contains("connection refused") || lowered.contains("os error 111") || lowered.contains("os error 146")
}

fn request(url: &str, headers: &[(String, String)], timeout: f64, accept: &str) -> ureq::Request {
    let mut req = agent(timeout).post(url).set("Content-Type", "application/json").set("Accept", accept).timeout(Duration::from_secs_f64(timeout.max(1.0)));
    for (k, v) in headers {
        req = req.set(k, v);
    }
    req
}

thread_local! {
    /// Set by a caller (orchestrate's hedged workers) on the thread that runs a model call: when
    /// the flag turns true the call returns at once and its stream is dropped, which closes the
    /// connection. Measured on Zai (speed10): with 10 streams open an 11th request gets 429;
    /// closing 6 of them frees 6 slots at once.
    pub static CANCEL: std::cell::RefCell<Option<std::sync::Arc<std::sync::atomic::AtomicBool>>> = const { std::cell::RefCell::new(None) };
    /// Set by a caller to see a call's progress: milliseconds since `epoch()` of the last
    /// streamed fragment (text or reasoning).
    pub static PROGRESS: std::cell::RefCell<Option<std::sync::Arc<std::sync::atomic::AtomicU64>>> = const { std::cell::RefCell::new(None) };
}

/// The process-wide time origin of `PROGRESS` stamps.
pub fn epoch_ms() -> u64 {
    static EPOCH: OnceLock<std::time::Instant> = OnceLock::new();
    EPOCH.get_or_init(std::time::Instant::now).elapsed().as_millis() as u64
}

fn cancelled() -> ModelError {
    ModelError { message: "cancelled".into(), status: None, abort: true, kind: "Cancelled".into(), connect_refused: false, retry_after: None, }
}

fn stopped() -> ModelError {
    ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterrupt".into(), connect_refused: false, retry_after: None, }
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
    let cancel = CANCEL.with(|c| c.borrow().clone());
    let progress = PROGRESS.with(|p| p.borrow().clone());
    if cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
        return Err(cancelled());
    }
    let worker_cancel = cancel.clone();
    std::thread::spawn(move || {
        CANCEL.with(|c| *c.borrow_mut() = worker_cancel);
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
        if cancel.as_ref().is_some_and(|c| c.load(Ordering::SeqCst)) {
            return Err(cancelled()); // the worker sees the same flag and drops its stream
        }
        match rx.recv_timeout(Duration::from_millis(50)) {
            Ok(Msg::Delta(k, t)) => {
                if let Some(p) = &progress {
                    p.store(epoch_ms(), Ordering::SeqCst);
                }
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
                kind: "ProviderError".into(), connect_refused: false, retry_after: None,
            })
        }
        Err(ureq::Error::Status(code, resp)) => {
            let captured = retry_headers(&resp);
            let text = resp.into_string().unwrap_or_default();
            Err(http_error_with_retry_after(code, &text, base, |h| captured.get(h).cloned()))
        }
        Err(e) => Err(transport_error(&e, base)),
    }
}

/// The two headers the retry policy reads, copied off a response before its body is consumed
/// (ureq's `into_string` takes the response, headers included).
fn retry_headers(resp: &ureq::Response) -> std::collections::HashMap<String, String> {
    let mut m = std::collections::HashMap::new();
    for h in ["retry-after-ms", "retry-after"] {
        if let Some(v) = resp.header(h) {
            m.insert(h.to_string(), v.to_string());
        }
    }
    m
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
            let captured = retry_headers(&resp);
            let text = resp.into_string().unwrap_or_default();
            return Err(http_error_with_retry_after(code, &text, base, |h| captured.get(h).cloned()));
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
    let cancel = CANCEL.with(|c| c.borrow().clone());
    for line in BufReader::new(reader).split(b'\n') {
        if cancel.as_ref().is_some_and(|c| c.load(std::sync::atomic::Ordering::SeqCst)) {
            // Returning drops the reader: ureq closes the connection, the provider frees the slot.
            return Err(std::io::Error::new(std::io::ErrorKind::Interrupted, "cancelled"));
        }
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
///
/// A refused TCP connect is the one non-abort error that retrying cannot fix by itself: the
/// gateway is down, not slow. It is also the one that comes back fastest, so it gets its own
/// policy (see `refused_wait`); any other error keeps the shared exponential schedule.
pub fn with_retry<T>(mut call: impl FnMut() -> Result<T, ModelError>) -> Result<T, ModelError> {
    let attempts: u32 = std::env::var("MSWEA_MODEL_RETRY_STOP_AFTER_ATTEMPT").ok().and_then(|s| s.parse().ok()).unwrap_or(10).max(1);
    let min_wait: f64 = std::env::var("MINI_AGENT_RETRY_MIN_WAIT").ok().and_then(|s| s.parse().ok()).unwrap_or(4.0);
    // A ceiling for one-shot callers (shard/hybrid set it): Zai's limit is on requests in flight,
    // so a slot frees within seconds, and the exponential curve's 8-17 s waits were the wall time
    // of whole waves (measured, speed8 t08: 37-39 s tails behind 8.9/11.6/17.6 s retries).
    let max_wait: f64 = std::env::var("MINI_AGENT_RETRY_MAX_WAIT").ok().and_then(|s| s.parse().ok()).unwrap_or(f64::INFINITY);
    let mut attempt = 0;
    loop {
        attempt += 1;
        match call() {
            Ok(v) => return Ok(v),
            Err(e) if e.abort || attempt >= attempts => return Err(e),
            Err(e) => {
                let wait = retry_delay(attempt, min_wait, max_wait, &e);
                eprintln!("WARNING: Retrying in {wait:.1} seconds as it raised {}: {}.", e.kind, e.message);
                if !crate::agent::interruptible_sleep(Duration::from_secs_f64(wait)) {
                    return Err(ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterrupt".into(), connect_refused: false, retry_after: None, });
                }
            }
        }
    }
}

/// The wait before the next attempt, in the order that matters:
///
/// 1. **What the server said** (`retry-after-ms` / `retry-after`, capped at
///    [`SERVER_HINT_CAP`]). A 429 that answers "retry in 300 ms" must not cost 4 s of invented
///    wait: measured, 73 retries spent 392 s waiting on the tenacity floor while the providers
///    involved do send the header. pi does the same first (provider-retry.ts `getRetryDelayMs`).
/// 2. **A refused connect** keeps its own cheap re-probe schedule ([`refused_wait`]).
/// 3. **A rate limit** (429 or a provider's rate-limit wording) gets pi's fast shape
///    ([`rate_limit_wait`]): the measured corpus waited 4 s on the first retry for a 429 that
///    carries no header, which is 8x what the same answer costs in pi.
/// 4. Otherwise the tenacity-shaped exponential curve, jittered x0.5-1.5 so calls that hit a
///    429 together do not retry together (measured, speed7: 32 parallel calls retried in
///    lockstep and re-hit the concurrency limit every time).
///
/// `MINI_AGENT_RETRY_MIN_WAIT` stays what it was: a floor for the *curve*, i.e. for a slow
/// provider with no hint. It no longer delays a server that just told us the exact wait.
fn retry_delay(attempt: u32, min_wait: f64, max_wait: f64, e: &ModelError) -> f64 {
    if let Some(hint) = e.retry_after {
        return hint.min(SERVER_HINT_CAP).max(0.0);
    }
    if e.connect_refused {
        return refused_wait(attempt, min_wait);
    }
    if is_rate_limited(e) {
        // pi's shape for a throttle: `min(0.5 x 2^i, 8) s`. A 429 means "not now", not "gone":
        // the first retry is half a second, and the curve still reaches 8 s by attempt 5.
        return rate_limit_wait(attempt).min(max_wait) * rand::Rng::gen_range(&mut rand::thread_rng(), 0.75..1.25);
    }
    retry_wait(attempt, min_wait).min(max_wait) * rand::Rng::gen_range(&mut rand::thread_rng(), 0.5..1.5)
}

/// A throttle answer: HTTP 429, or a 4xx the provider worded as a rate limit (some gateways
/// use 400 for it, and `classify_status` keeps those retryable on purpose).
fn is_rate_limited(e: &ModelError) -> bool {
    if e.status == Some(429) {
        return true;
    }
    let m = e.message.to_lowercase();
    if m.contains("rate limit") || m.contains("too many requests") {
        return true;
    }
    // "quota" alone is often a permanent billing error; only a status-carrying answer counts.
    m.contains("quota") && e.status.is_some()
}

/// pi's throttle backoff (`provider-retry.ts`): 0.5, 1, 2, 4, then 8 s.
fn rate_limit_wait(attempt: u32) -> f64 {
    (0.5f64 * 2f64.powi(attempt as i32 - 1)).min(8.0)
}

/// Never sleep longer than this on a server's own hint: a provider that asks for more is
/// misconfigured or under sustained load, and a fresh call would re-learn the wait anyway
/// (pi throws above its 60 s `maxRetryDelayMs`; sleeping the full hint is enough here).
const SERVER_HINT_CAP: f64 = 60.0;

/// How long to wait between attempts when nothing is listening. The connect is refused
/// instantly, so these are the only cheap retries there are, and the shared curve is the
/// wrong shape for it: `MINI_AGENT_RETRY_MIN_WAIT` is a floor for a *slow* provider, while a
/// gateway that is coming back answers within seconds. So the first refusal is re-probed at
/// once (the common case: the service was mid-restart) and the rest are capped at
/// [`REFUSED_CAP`], which keeps the schedule inside a restart-sized window instead of the
/// 4 minutes the shared curve would spend before saying anything.
const REFUSED_CAP: f64 = 2.0;

fn refused_wait(attempt: u32, min_wait: f64) -> f64 {
    if attempt == 1 {
        0.0
    } else {
        retry_wait(attempt, min_wait).min(REFUSED_CAP)
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
    fn a_refused_connect_is_recognised() {
        // The exact text ureq produces for the gateway-down case.
        assert!(is_connect_refused("http://127.0.0.1:8317/v1/chat/completions: Connection Failed: Connect error: Connection refused (os error 111)"));
        assert!(is_connect_refused("Network Error: Connect error: Connection refused (os error 111)"));
        assert!(is_connect_refused("Connect error: connection refused"));
        assert!(is_connect_refused("Connection refused (os error 111)"));
        // Not a refusal: timeouts, resets, DNS failures, a mid-stream drop.
        assert!(!is_connect_refused("Network Error: timed out reading response"));
        assert!(!is_connect_refused("Connection reset by peer (os error 104)"));
        assert!(!is_connect_refused("dns error: failed to lookup address information"));
        assert!(!is_connect_refused("connection closed before message completed"));
        assert!(!is_connect_refused(""));
    }

    #[test]
    fn refused_connects_reprobe_at_once_then_stay_short() {
        let waits: Vec<f64> = (1..=6).map(|a| refused_wait(a, 4.0)).collect();
        assert_eq!(waits, vec![0.0, 2.0, 2.0, 2.0, 2.0, 2.0]);
        // Never the shared curve's long tail: a refused connect is cheap to re-probe.
        assert!(refused_wait(5, 4.0) < retry_wait(5, 4.0));
        // Ten attempts, the default, stays inside a restart-sized window (~18 s), where the
        // shared curve would have spent 4 minutes before reporting anything.
        let total: f64 = (1..10).map(|a| refused_wait(a, 4.0)).sum();
        assert!(total < 20.0, "{total}");
        let shared: f64 = (1..10).map(|a| retry_wait(a, 4.0)).sum();
        assert!(shared > 200.0, "{shared}");
    }

    #[test]
    fn a_gateway_that_comes_back_is_caught_as_fast_as_before() {
        // The gateway restarts and is listening again after `up_at` seconds: when does the
        // retry loop notice? The capped schedule must not be slower than the shared one.
        let notice = |wait: fn(u32, f64) -> f64, up_at: f64| {
            let mut t = 0.0;
            for attempt in 1..=10u32 {
                if t >= up_at {
                    return t;
                }
                t += wait(attempt, 4.0);
            }
            t
        };
        for up_at in [0.05, 1.0, 3.0, 5.0] {
            let capped = notice(|a, m| refused_wait(a, m), up_at);
            let shared = notice(retry_wait, up_at);
            assert!(capped <= shared + 0.001, "up_at={up_at} capped={capped} shared={shared}");
        }
    }

    #[test]
    fn the_refused_hint_names_the_gateway() {
        let hint = refused_hint("http://127.0.0.1:8317/v1");
        assert!(hint.contains("cli-proxy (cliproxy/)"), "{hint}");
        assert!(hint.contains("port 8317"), "{hint}");
        assert!(hint.contains("CLIPROXY_API_BASE"), "{hint}");
        assert!(hint.contains("ss -ltn"), "{hint}");
        assert!(!hint.contains("8317/v1"), "{hint}");
        assert!(refused_hint("http://127.0.0.1:9120/v1").contains("rosetta"));
        assert!(refused_hint("http://localhost:8317/v1").contains("cli-proxy"));
        let remote = refused_hint("https://token-plan-sgp.xiaomimimo.com/v1");
        assert!(remote.contains("unreachable"), "{remote}");
        assert!(!remote.contains("CLIPROXY_API_BASE"), "{remote}");
    }

    #[test]
    fn classifies() {
        assert!(classify_status(401, "bad key", "b").abort);
        assert!(!classify_status(429, "slow down", "b").abort);
        assert!(!classify_status(400, "Rate limit reached", "b").abort);
        assert!(!classify_status(503, "down", "b").abort);
    }
}
