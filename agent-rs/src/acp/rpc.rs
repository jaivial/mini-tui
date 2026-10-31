//! JSON-RPC 2.0 framing for the ACP server: one JSON object per line on stdin and stdout.
//!
//! Stdout belongs to the protocol. Every write goes through [`Out`], which serializes a whole
//! message and its newline under one lock, so notifications from turn threads never interleave
//! with a response written by the main loop.

use serde_json::{json, Value};
use std::io::Write;
use std::sync::{Arc, Mutex};

pub const PARSE_ERROR: i64 = -32700;
pub const INVALID_REQUEST: i64 = -32600;
pub const METHOD_NOT_FOUND: i64 = -32601;
pub const INVALID_PARAMS: i64 = -32602;
pub const INTERNAL_ERROR: i64 = -32603;

#[derive(Debug, PartialEq)]
pub enum Incoming {
    Request { id: Value, method: String, params: Value },
    Notification { method: String, params: Value },
    /// A reply to a request this side sent. The server sends none today, so these are dropped.
    Response,
    /// Not a JSON-RPC message: answer `id` (null when unknown) with `code`.
    Invalid { id: Value, code: i64, message: String },
}

/// Classify one input line. Blank lines yield `None`.
pub fn parse(line: &str) -> Option<Incoming> {
    let line = line.trim();
    if line.is_empty() {
        return None;
    }
    let value: Value = match serde_json::from_str(line) {
        Ok(v) => v,
        Err(e) => return Some(Incoming::Invalid { id: Value::Null, code: PARSE_ERROR, message: format!("Parse error: {e}") }),
    };
    let Some(obj) = value.as_object() else {
        return Some(Incoming::Invalid { id: Value::Null, code: INVALID_REQUEST, message: "Invalid Request: not an object".into() });
    };
    let id = obj.get("id").cloned();
    match obj.get("method") {
        Some(Value::String(method)) => {
            let params = obj.get("params").cloned().unwrap_or(Value::Null);
            Some(match id {
                Some(id) if valid_id(&id) => Incoming::Request { id, method: method.clone(), params },
                Some(id) => Incoming::Invalid { id: Value::Null, code: INVALID_REQUEST, message: format!("Invalid Request: bad id {id}") },
                None => Incoming::Notification { method: method.clone(), params },
            })
        }
        Some(_) => Some(Incoming::Invalid { id: id.filter(valid_id).unwrap_or(Value::Null), code: INVALID_REQUEST, message: "Invalid Request: method must be a string".into() }),
        None if obj.contains_key("result") || obj.contains_key("error") => Some(Incoming::Response),
        None => Some(Incoming::Invalid { id: id.filter(valid_id).unwrap_or(Value::Null), code: INVALID_REQUEST, message: "Invalid Request: no method".into() }),
    }
}

fn valid_id(id: &Value) -> bool {
    matches!(id, Value::String(_) | Value::Number(_) | Value::Null)
}

/// The shared, line-atomic writer for protocol messages.
#[derive(Clone)]
pub struct Out(Arc<Mutex<Box<dyn Write + Send>>>);

impl Out {
    pub fn new(w: Box<dyn Write + Send>) -> Self {
        Out(Arc::new(Mutex::new(w)))
    }

    pub fn stdout() -> Self {
        Self::new(Box::new(std::io::stdout()))
    }

    pub fn send(&self, msg: &Value) {
        let mut line = serde_json::to_string(msg).unwrap_or_default();
        line.push('\n');
        let mut w = self.0.lock().unwrap_or_else(|p| p.into_inner());
        // A closed stdout means the client is gone; the read loop sees EOF and shuts down.
        let _ = w.write_all(line.as_bytes()).and_then(|_| w.flush());
    }

    pub fn result(&self, id: &Value, result: Value) {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "result": result}));
    }

    pub fn error(&self, id: &Value, code: i64, message: &str) {
        self.send(&json!({"jsonrpc": "2.0", "id": id, "error": {"code": code, "message": message}}));
    }

    pub fn notify(&self, method: &str, params: Value) {
        self.send(&json!({"jsonrpc": "2.0", "method": method, "params": params}));
    }

    /// `session/update` for one session.
    pub fn update(&self, session_id: &str, update: Value) {
        self.notify("session/update", json!({"sessionId": session_id, "update": update}));
    }
}

#[cfg(test)]
pub mod tests {
    use super::*;

    /// An in-memory sink standing in for stdout.
    #[derive(Clone, Default)]
    pub struct Buf(pub Arc<Mutex<Vec<u8>>>);

    impl Write for Buf {
        fn write(&mut self, b: &[u8]) -> std::io::Result<usize> {
            self.0.lock().unwrap().extend_from_slice(b);
            Ok(b.len())
        }
        fn flush(&mut self) -> std::io::Result<()> {
            Ok(())
        }
    }

    impl Buf {
        pub fn lines(&self) -> Vec<Value> {
            let text = String::from_utf8(self.0.lock().unwrap().clone()).unwrap();
            text.lines().map(|l| serde_json::from_str(l).expect("every stdout line is JSON")).collect()
        }
    }

    #[test]
    fn classifies_requests_notifications_and_responses() {
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1}}"#),
            Some(Incoming::Request { id: json!(1), method: "initialize".into(), params: json!({"protocolVersion": 1}) })
        );
        assert_eq!(
            parse(r#"{"jsonrpc":"2.0","method":"session/cancel","params":{"sessionId":"s"}}"#),
            Some(Incoming::Notification { method: "session/cancel".into(), params: json!({"sessionId": "s"}) })
        );
        assert_eq!(parse(r#"{"jsonrpc":"2.0","id":"a","method":"x"}"#), Some(Incoming::Request { id: json!("a"), method: "x".into(), params: Value::Null }));
        assert_eq!(parse(r#"{"jsonrpc":"2.0","id":3,"result":{}}"#), Some(Incoming::Response));
        assert_eq!(parse("   "), None);
    }

    #[test]
    fn malformed_input_maps_to_json_rpc_errors() {
        assert!(matches!(parse("{not json"), Some(Incoming::Invalid { code: PARSE_ERROR, .. })));
        assert!(matches!(parse("[1,2]"), Some(Incoming::Invalid { code: INVALID_REQUEST, .. })));
        assert!(matches!(parse(r#"{"id":4,"method":7}"#), Some(Incoming::Invalid { id, code: INVALID_REQUEST, .. }) if id == json!(4)));
        assert!(matches!(parse(r#"{"id":{"x":1},"method":"m"}"#), Some(Incoming::Invalid { code: INVALID_REQUEST, .. })));
    }

    #[test]
    fn writes_one_json_object_per_line() {
        let buf = Buf::default();
        let out = Out::new(Box::new(buf.clone()));
        out.result(&json!(1), json!({"ok": true}));
        out.error(&json!("x"), METHOD_NOT_FOUND, "Method not found: nope");
        out.update("s1", json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": "a\nb"}}));
        let lines = buf.lines();
        assert_eq!(lines.len(), 3);
        assert_eq!(lines[0], json!({"jsonrpc": "2.0", "id": 1, "result": {"ok": true}}));
        assert_eq!(lines[1]["error"]["code"], json!(-32601));
        assert_eq!(lines[2]["method"], json!("session/update"));
        assert_eq!(lines[2]["params"]["update"]["content"]["text"], json!("a\nb"));
    }
}
