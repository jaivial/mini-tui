//! Minimal MCP Streamable HTTP client for one opt-in server (`MINI_AGENT_MCP_URL`).
//!
//! The default is deliberately off: normal coding runs pay no connection, schema or prompt cost.
//! It supports initialize + session IDs, JSON and SSE responses, paginated tools/list and
//! tools/call. Credentials are read from the environment and never included in errors.

use crate::util::get;
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::OnceLock;
use std::time::Duration;

#[derive(Clone)]
struct RemoteTool {
    exposed: String,
    original: String,
    description: String,
    schema: Value,
}

struct Registry {
    url: String,
    headers: Vec<(String, String)>,
    session: Option<String>,
    protocol: String,
    tools: Vec<RemoteTool>,
}

static REGISTRY: OnceLock<Result<Registry, String>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn configured() -> bool {
    std::env::var("MINI_AGENT_MCP_URL").map(|v| !v.trim().is_empty()).unwrap_or(false)
}

fn safe_url(url: &str) -> String {
    url.split('?').next().unwrap_or(url).to_string()
}

fn fnv(text: &str) -> String {
    let mut hash = 0xcbf29ce484222325u64;
    for byte in text.as_bytes() {
        hash ^= u64::from(*byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:08x}").chars().take(8).collect()
}

fn reserved(name: &str) -> bool {
    matches!(name, "bash" | "cu" | "read" | "write" | "edit" | "code" | "codejs" | "computer_use" | "task_verify")
        || name.starts_with("task_")
        || name.starts_with("agent_")
}

fn exposed_name(original: &str, server: &str) -> String {
    let mut name = if reserved(original) { format!("mcp__{server}__{original}") } else { original.to_string() };
    if name.len() > 64 {
        // OpenAI-compatible providers commonly cap function names at 64 bytes. Keep the
        // readable prefix and a deterministic suffix instead of colliding after truncation.
        name = format!("{}__{}", name.chars().take(54).collect::<String>(), fnv(original));
    }
    name
}

fn headers() -> Vec<(String, String)> {
    let mut out = Vec::new();
    if let Ok(key) = std::env::var("MINI_AGENT_MCP_API_KEY") {
        if !key.trim().is_empty() {
            out.push(("Authorization".into(), format!("Bearer {}", key.trim())));
        }
    }
    if let Ok(raw) = std::env::var("MINI_AGENT_MCP_HEADERS") {
        if let Ok(Value::Object(values)) = serde_json::from_str::<Value>(&raw) {
            for (key, value) in values {
                if let Some(value) = value.as_str() {
                    out.push((key, value.to_string()));
                }
            }
        }
    }
    out
}

fn parse_body(content_type: &str, body: &str) -> Result<Value, String> {
    if body.trim().is_empty() {
        return Ok(Value::Null);
    }
    if !content_type.to_lowercase().contains("text/event-stream") {
        return serde_json::from_str(body).map_err(|e| format!("invalid MCP JSON response: {e}"));
    }
    // A Streamable HTTP response may contain one or more SSE events. Return the first complete
    // JSON-RPC response; notifications have no id and are ignored by the caller when appropriate.
    for block in body.replace("\r\n", "\n").split("\n\n") {
        let data = block.lines().filter_map(|line| line.strip_prefix("data:").map(str::trim)).collect::<Vec<_>>().join("\n");
        if data.is_empty() || data == "[DONE]" {
            continue;
        }
        if let Ok(value) = serde_json::from_str::<Value>(&data) {
            return Ok(value);
        }
    }
    Err("MCP SSE response ended without a JSON-RPC response".into())
}

fn post(client: &Registry, payload: &Value) -> Result<(Option<String>, Value), String> {
    let url = client.url.trim_end_matches('/');
    let mut request = ureq::post(url)
        .set("Content-Type", "application/json")
        .set("Accept", "application/json, text/event-stream")
        .set("MCP-Protocol-Version", &client.protocol)
        .timeout(Duration::from_secs_f64(std::env::var("MINI_AGENT_MCP_TIMEOUT").ok().and_then(|v| v.parse().ok()).unwrap_or(60.0)));
    if let Some(session) = &client.session {
        request = request.set("Mcp-Session-Id", session);
    }
    for (key, value) in &client.headers {
        request = request.set(key, value);
    }
    let response = match request.send_string(&payload.to_string()) {
        Ok(response) => response,
        Err(ureq::Error::Status(code, response)) => {
            let body = response.into_string().unwrap_or_default();
            return Err(format!("MCP HTTP {code} from {}: {}", safe_url(url), body.chars().take(500).collect::<String>()));
        }
        Err(error) => return Err(format!("MCP transport error from {}: {error}", safe_url(url))),
    };
    let session = response.header("Mcp-Session-Id").map(str::to_string);
    let content_type = response.header("Content-Type").unwrap_or("application/json").to_string();
    let body = response.into_string().map_err(|e| format!("cannot read MCP response: {e}"))?;
    let value = parse_body(&content_type, &body)?;
    if let Some(error) = value.get("error") {
        let message = error.get("message").and_then(Value::as_str).unwrap_or_else(|| error.as_str().unwrap_or("MCP error"));
        return Err(format!("MCP {}: {message}", payload.get("method").and_then(Value::as_str).unwrap_or("request")));
    }
    Ok((session, value.get("result").cloned().unwrap_or(value)))
}

fn initialize(url: String, headers: Vec<(String, String)>) -> Result<Registry, String> {
    let protocol = "2024-11-05".to_string();
    let mut client = Registry { url, headers, session: None, protocol: protocol.clone(), tools: vec![] };
    let (session, initialized) = post(&client, &json!({
        "jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "initialize",
        "params": {"protocolVersion": protocol, "capabilities": {}, "clientInfo": {"name": "mini-agent-rs", "version": crate::agent::VERSION}}
    }))?;
    client.session = session;
    if let Some(negotiated) = initialized.get("protocolVersion").and_then(Value::as_str) {
        client.protocol = negotiated.to_string();
    }
    // initialized is a notification (no id and normally 202/empty). Some compatible servers
    // return 200 instead; both are accepted by post().
    let _ = post(&client, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    let server = std::env::var("MINI_AGENT_MCP_NAME").unwrap_or_else(|_| "composio".into());
    let mut raw_tools = Vec::new();
    let mut cursor = Value::Null;
    for _ in 0..20 {
        let params = if cursor.is_null() { json!({}) } else { json!({"cursor": cursor}) };
        let (_, result) = post(&client, &json!({"jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "tools/list", "params": params}))?;
        raw_tools.extend(result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default());
        let next = result.get("nextCursor").cloned().filter(|v| !v.is_null());
        let Some(next) = next else { break };
        cursor = next;
    }
    let mut exposed = std::collections::HashSet::new();
    for tool in raw_tools {
        let Some(original) = tool.get("name").and_then(Value::as_str) else { continue };
        let name = exposed_name(original, &server);
        if !exposed.insert(name.clone()) {
            return Err(format!("MCP tool name collision after normalization: {name}"));
        }
        client.tools.push(RemoteTool {
            exposed: name,
            original: original.to_string(),
            description: tool.get("description").and_then(Value::as_str).unwrap_or("MCP tool").to_string(),
            schema: tool.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
        });
    }
    Ok(client)
}

fn registry() -> Result<&'static Registry, String> {
    if !configured() {
        return Err("MINI_AGENT_MCP_URL is not set".into());
    }
    REGISTRY.get_or_init(|| {
        let url = std::env::var("MINI_AGENT_MCP_URL").unwrap().trim().trim_end_matches('/').to_string();
        initialize(url, headers())
    }).as_ref().map_err(Clone::clone)
}

fn tool_values(tool: &RemoteTool, protocol: &str) -> Value {
    match protocol {
        "messages" => json!({"name": tool.exposed, "description": tool.description, "input_schema": tool.schema}),
        "responses" => json!({"type": "function", "name": tool.exposed, "description": tool.description, "parameters": tool.schema}),
        _ => json!({"type": "function", "function": {"name": tool.exposed, "description": tool.description, "parameters": tool.schema}}),
    }
}

pub fn tools(protocol: &str) -> Vec<Value> {
    if !configured() {
        return vec![];
    }
    match registry() {
        Ok(registry) => registry.tools.iter().map(|tool| tool_values(tool, protocol)).collect(),
        Err(error) => {
            eprintln!("[mcp] {error}");
            vec![]
        }
    }
}

pub fn tool_names() -> Result<Vec<String>, String> {
    Ok(registry()?.tools.iter().map(|tool| tool.exposed.clone()).collect())
}

pub fn is_tool(name: &str) -> bool {
    configured() && registry().map(|registry| registry.tools.iter().any(|tool| tool.exposed == name)).unwrap_or(false)
}

pub fn outcome(name: &str, args: &Value) -> Value {
    let result = registry().and_then(|registry| {
        let tool = registry.tools.iter().find(|tool| tool.exposed == name).ok_or_else(|| format!("unknown MCP tool {name}"))?;
        let (_, result) = post(registry, &json!({"jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "tools/call", "params": {"name": tool.original, "arguments": args}}))?;
        Ok(result)
    });
    match result {
        Ok(result) => {
            let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
            let text = result.get("content").and_then(Value::as_array).map(|parts| {
                parts.iter().filter_map(|part| get(part, "text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
            }).unwrap_or_default();
            let output = if !text.is_empty() { text } else if let Some(structured) = result.get("structuredContent") { structured.to_string() } else { result.to_string() };
            json!({"output": output, "returncode": if is_error { 1 } else { 0 }, "exception_info": if is_error { output.clone() } else { String::new() }, "extra": {"mcp": true, "tool": name, "structuredContent": result.get("structuredContent").cloned().unwrap_or(Value::Null)}})
        }
        Err(error) => json!({"output": error, "returncode": 2, "exception_info": "MCP tool call failed"}),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::io::{Read, Write};
    use std::net::TcpListener;

    fn request(stream: &mut std::net::TcpStream) -> String {
        let mut raw = Vec::new();
        let mut buffer = [0u8; 4096];
        loop {
            let count = stream.read(&mut buffer).unwrap();
            raw.extend_from_slice(&buffer[..count]);
            let headers_end = raw.windows(4).position(|w| w == b"\r\n\r\n").map(|i| i + 4);
            if let Some(end) = headers_end {
                let headers = String::from_utf8_lossy(&raw[..end]);
                let length = headers.lines().find_map(|line| line.to_lowercase().strip_prefix("content-length:")?.trim().parse::<usize>().ok()).unwrap_or(0);
                if raw.len() >= end + length {
                    return String::from_utf8_lossy(&raw).into_owned();
                }
            }
            if count == 0 {
                return String::from_utf8_lossy(&raw).into_owned();
            }
        }
    }

    fn response(stream: &mut std::net::TcpStream, body: &str, session: bool) {
        let headers = format!("HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{}Connection: close\r\n\r\n", body.len(), if session { "Mcp-Session-Id: test-session\r\n" } else { "" });
        stream.write_all(headers.as_bytes()).unwrap();
        stream.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn sse_frames_and_tool_name_limits_are_handled() {
        let value = parse_body("text/event-stream", "data: {\"jsonrpc\":\"2.0\",\"id\":7,\"result\":{\"ok\":true}}\n\n").unwrap();
        assert_eq!(value["id"], 7);
        assert!(parse_body("text/event-stream", ": keepalive\n\n").is_err());
        let long = "A".repeat(90);
        let first = exposed_name(&long, "mock");
        assert!(first.len() <= 64);
        assert_eq!(first, exposed_name(&long, "mock"));
        assert!(exposed_name("task_update", "mock").starts_with("mcp__mock__"));
    }

    #[test]
    fn client_initializes_lists_and_calls_a_streamable_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let raw = request(&mut stream);
                requests.push(raw.clone());
                match index {
                    0 => response(&mut stream, r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2024-11-05","capabilities":{},"serverInfo":{"name":"mock","version":"1"}}}"#, true),
                    1 => response(&mut stream, "", false),
                    2 => response(&mut stream, r#"{"jsonrpc":"2.0","id":3,"result":{"tools":[{"name":"PING","description":"Ping test","inputSchema":{"type":"object","properties":{"value":{"type":"string"}}}}]}}"#, false),
                    _ => response(&mut stream, r#"{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"pong"}],"isError":false}}"#, false),
                }
            }
            requests
        });
        std::env::set_var("MINI_AGENT_MCP_URL", url);
        std::env::set_var("MINI_AGENT_MCP_API_KEY", "secret-test");
        std::env::set_var("MINI_AGENT_MCP_NAME", "mock");
        assert_eq!(tool_names().unwrap(), vec!["PING"]);
        assert_eq!(tools("chat")[0]["function"]["name"], "PING");
        let result = outcome("PING", &json!({"value": "x"}));
        assert_eq!(result["returncode"], 0);
        assert_eq!(result["output"], "pong");
        let requests = handle.join().unwrap();
        assert!(requests[0].contains("initialize"));
        assert!(requests[0].contains("authorization: Bearer secret-test") || requests[0].contains("Authorization: Bearer secret-test"));
        assert!(requests[2].contains("tools/list"));
        assert!(requests[2].to_lowercase().contains("mcp-session-id: test-session"));
        assert!(requests[3].contains("tools/call"));
        assert!(requests[3].contains("PING"));
        std::env::remove_var("MINI_AGENT_MCP_URL");
        std::env::remove_var("MINI_AGENT_MCP_API_KEY");
        std::env::remove_var("MINI_AGENT_MCP_NAME");
    }
}
