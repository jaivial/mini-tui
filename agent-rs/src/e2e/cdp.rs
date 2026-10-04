//! A minimal, blocking Chrome DevTools Protocol client over a local websocket.
//!
//! It answers the two events the e2e runner must handle while any call is in flight:
//! `Fetch.authRequired` (HTTP Basic Auth, e.g. an nginx `auth_basic` gate: credentials are
//! only ever given to the base URL's origin) and `Fetch.requestPaused` (top-level navigations
//! to origins outside the allow list are failed, so a worker cannot leave the app).

use serde_json::{json, Value};
use std::collections::VecDeque;
use std::net::TcpStream;
use std::time::{Duration, Instant};
use tungstenite::{Message, WebSocket};

pub struct BasicAuth {
    pub origin: String,
    pub user: String,
    pub password: String,
}

pub struct Cdp {
    ws: WebSocket<TcpStream>,
    next_id: u64,
    pub events: VecDeque<Value>,
    pub basic_auth: Option<BasicAuth>,
    /// Origins top-level navigations may go to (empty = anything).
    pub allowed_origins: Vec<String>,
    /// Set when a navigation was blocked (the URL), so the step can fail with "left the app".
    pub blocked: Option<String>,
    /// Set when Basic Auth was asked for and refused or unavailable.
    pub auth_failed: Option<String>,
    auth_attempts: u32,
}

/// `scheme://host[:port]` of a URL (lowercased), or "" when it has none.
pub fn origin_of(url: &str) -> String {
    let Some((scheme, rest)) = url.split_once("://") else { return String::new() };
    let host = rest.split(['/', '?', '#']).next().unwrap_or("");
    let host = host.rsplit('@').next().unwrap_or(host);
    format!("{}://{}", scheme.to_lowercase(), host.to_lowercase())
}

impl Cdp {
    pub fn connect(ws_url: &str) -> Result<Self, String> {
        let rest = ws_url.strip_prefix("ws://").ok_or_else(|| format!("not a local ws url: {ws_url}"))?;
        let hostport = rest.split('/').next().unwrap_or("");
        let stream = TcpStream::connect(hostport).map_err(|e| format!("devtools connect {hostport}: {e}"))?;
        stream.set_nodelay(true).ok();
        let (ws, _) = tungstenite::client::client(ws_url, stream).map_err(|e| format!("devtools handshake: {e}"))?;
        Ok(Cdp { ws, next_id: 0, events: VecDeque::new(), basic_auth: None, allowed_origins: vec![], blocked: None, auth_failed: None, auth_attempts: 0 })
    }

    fn set_timeout(&mut self, d: Option<Duration>) {
        let _ = self.ws.get_mut().set_read_timeout(d);
    }

    fn send(&mut self, method: &str, params: Value) -> Result<u64, String> {
        self.next_id += 1;
        let id = self.next_id;
        let msg = json!({"id": id, "method": method, "params": params}).to_string();
        self.ws.send(Message::Text(msg)).map_err(|e| format!("devtools send: {e}"))?;
        Ok(id)
    }

    /// One frame (None on timeout).
    fn read(&mut self) -> Result<Option<Value>, String> {
        match self.ws.read() {
            Ok(Message::Text(t)) => Ok(serde_json::from_str(&t).ok()),
            Ok(_) => Ok(None),
            Err(tungstenite::Error::Io(e)) if matches!(e.kind(), std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut) => Ok(None),
            Err(e) => Err(format!("devtools read: {e}")),
        }
    }

    fn handle_event(&mut self, ev: Value) -> Result<(), String> {
        let method = ev.get("method").and_then(Value::as_str).unwrap_or("").to_string();
        let p = ev.get("params").cloned().unwrap_or(json!({}));
        let rid = p.get("requestId").cloned().unwrap_or(Value::Null);
        match method.as_str() {
            "Fetch.authRequired" => {
                let url = p.pointer("/request/url").and_then(Value::as_str).unwrap_or("");
                let origin = origin_of(url);
                let resp = match &self.basic_auth {
                    Some(a) if a.origin == origin && self.auth_attempts < 3 => {
                        self.auth_attempts += 1;
                        json!({"response": "ProvideCredentials", "username": a.user, "password": a.password})
                    }
                    Some(a) if a.origin == origin => {
                        self.auth_failed = Some(format!("{origin} rejected the HTTP Basic Auth credentials"));
                        json!({"response": "CancelAuth"})
                    }
                    _ => {
                        self.auth_failed = Some(format!("{origin} asks for HTTP Basic Auth and no credentials are configured for it"));
                        json!({"response": "CancelAuth"})
                    }
                };
                self.send("Fetch.continueWithAuth", json!({"requestId": rid, "authChallengeResponse": resp}))?;
            }
            "Fetch.requestPaused" => {
                let url = p.pointer("/request/url").and_then(Value::as_str).unwrap_or("").to_string();
                let is_doc = p.get("resourceType").and_then(Value::as_str) == Some("Document");
                let o = origin_of(&url);
                let ok = !is_doc || self.allowed_origins.is_empty() || o.is_empty() || !o.starts_with("http") || self.allowed_origins.contains(&o);
                if ok {
                    self.send("Fetch.continueRequest", json!({"requestId": rid}))?;
                } else {
                    self.blocked = Some(url);
                    self.send("Fetch.failRequest", json!({"requestId": rid, "errorReason": "BlockedByClient"}))?;
                }
            }
            _ => self.events.push_back(ev),
        }
        if self.events.len() > 500 {
            self.events.drain(..250);
        }
        Ok(())
    }

    /// Send a command and wait for its result (events are handled meanwhile).
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value, String> {
        self.call_timeout(method, params, Duration::from_secs(30))
    }

    pub fn call_timeout(&mut self, method: &str, params: Value, timeout: Duration) -> Result<Value, String> {
        let id = self.send(method, params)?;
        let deadline = Instant::now() + timeout;
        self.set_timeout(Some(Duration::from_millis(200)));
        loop {
            if Instant::now() > deadline {
                return Err(format!("{method}: timed out"));
            }
            let Some(v) = self.read()? else { continue };
            if v.get("id").and_then(Value::as_u64) == Some(id) {
                if let Some(e) = v.get("error") {
                    return Err(format!("{method}: {}", e.get("message").and_then(Value::as_str).unwrap_or("error")));
                }
                return Ok(v.get("result").cloned().unwrap_or(json!({})));
            }
            if v.get("method").is_some() {
                self.handle_event(v)?;
            }
        }
    }

    /// Handle events for `d` (or until `stop` matches one, returned).
    pub fn pump(&mut self, d: Duration, stop: &dyn Fn(&Value) -> bool) -> Result<Option<Value>, String> {
        if let Some(i) = self.events.iter().position(stop) {
            return Ok(self.events.remove(i));
        }
        let deadline = Instant::now() + d;
        self.set_timeout(Some(Duration::from_millis(100)));
        while Instant::now() < deadline {
            if let Some(v) = self.read()? {
                if v.get("method").is_some() {
                    self.handle_event(v)?;
                    if let Some(i) = self.events.iter().position(stop) {
                        return Ok(self.events.remove(i));
                    }
                }
            }
        }
        Ok(None)
    }

    /// `Runtime.evaluate` of an expression, returning its JSON value.
    pub fn eval(&mut self, expr: &str) -> Result<Value, String> {
        let r = self.call("Runtime.evaluate", json!({"expression": expr, "returnByValue": true, "awaitPromise": true}))?;
        if let Some(ex) = r.get("exceptionDetails") {
            let text = ex.pointer("/exception/description").or_else(|| ex.get("text")).and_then(Value::as_str).unwrap_or("script error");
            return Err(text.lines().next().unwrap_or("script error").to_string());
        }
        Ok(r.pointer("/result/value").cloned().unwrap_or(Value::Null))
    }
}

#[cfg(test)]
mod tests {
    use super::origin_of;
    #[test]
    fn origins() {
        assert_eq!(origin_of("https://Mini.Example.com/a/b?x"), "https://mini.example.com");
        assert_eq!(origin_of("http://u:p@127.0.0.1:4317/"), "http://127.0.0.1:4317");
        assert_eq!(origin_of("about:blank"), "");
    }
}
