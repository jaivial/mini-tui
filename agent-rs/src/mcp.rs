//! Minimal MCP client: one opt-in server (`MINI_AGENT_MCP_URL`), the servers installed through
//! mini-tui (`MINI_AGENT_MCP_SERVERS`) and mini-tui's built-in `cu` server (`MINI_AGENT_CU_MCP=1`).
//! Servers are reached over Streamable HTTP or, for a local program, over stdio.
//!
//! The default is deliberately off: a bare run pays no connection, schema or prompt cost. mini-tui
//! turns the built-in on for every run it spawns, the way it turns on the native agent tools.
//! It supports initialize + session IDs, JSON and SSE responses, paginated tools/list and
//! tools/call. Credentials are read from the environment and never included in errors.
//!
//! OAuth access tokens are short-lived (Google's: one hour) and runs are not. mini-tui refreshes
//! them in `mcp.json` and names that file in `MINI_AGENT_MCP_FILE`: an installed server's
//! headers are read from it at connect time (an inherited env can be hours old) and again when
//! the server answers 401/403, and the call is retried once on a new session.

use crate::util::get;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::io::{BufRead, BufReader, Write};
use std::process::{Child, ChildStdin, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::mpsc::{channel, RecvTimeoutError, Sender};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::{Duration, Instant};

#[derive(Clone)]
struct RemoteTool {
    exposed: String,
    original: String,
    description: String,
    schema: Value,
}

/// What a request carries; replaced when the credentials are reloaded.
#[derive(Clone)]
struct Conn {
    headers: Vec<(String, String)>,
    session: Option<String>,
    protocol: String,
}

struct Registry {
    url: String,
    /// The mcp.json id of an installed server (fresh credentials are looked up by it).
    id: Option<String>,
    conn: Mutex<Conn>,
    tools: Vec<RemoteTool>,
}

impl Registry {
    fn conn(&self) -> Conn {
        self.conn.lock().map(|c| c.clone()).unwrap_or_else(|e| e.into_inner().clone())
    }
}

/// One server to connect. The legacy single server (`MINI_AGENT_MCP_URL`) keeps its tool names;
/// servers installed through mini-tui (`MINI_AGENT_MCP_SERVERS`, a JSON array of
/// `{"name","url","headers"}`) are namespaced `mcp__<server>__<tool>`, as Claude Code does, so two
/// servers can both expose `search`.
struct ServerSpec {
    name: String,
    /// The mcp.json id (`name` before slugging); None for the legacy server.
    id: Option<String>,
    url: String,
    headers: Vec<(String, String)>,
    prefixed: bool,
    /// Only these tools are exposed (`"tools": [...]`); empty = all. A server with a hundred
    /// tools (OpenPencil: 132, ~31k tokens of schemas) would otherwise fill every prompt.
    allow: Vec<String>,
    /// Extra guidance appended to one tool's description (`"hints": {"render": "..."}`): what the
    /// server documents elsewhere and a model would otherwise guess (OpenPencil's JSX props).
    hints: Vec<(String, String)>,
    /// A local server: the program to run and talk to over its stdin/stdout, instead of `url`
    /// (which then holds the `stdio:<name>` address its registry is known by).
    stdio: Option<StdioCommand>,
}

#[derive(Clone, Debug, PartialEq)]
struct StdioCommand {
    program: String,
    args: Vec<String>,
    env: Vec<(String, String)>,
}

/// The name of mini-tui's built-in server: its tools are `mcp__cu__*`.
const BUILTIN_CU: &str = "cu";

/// mini-tui's built-in server: `cu mcp`, the browser daemon's tools (navigate, snapshot, click,
/// type, act, screenshot...), one page per run. mini-tui sets `MINI_AGENT_CU_MCP=1` on every run it
/// spawns and offers no way to turn it off; a bare `mini-agent-rs` run (benchmarks, the parity
/// suite) does not get it, like the native agent tools. Never in unit tests: they must not start
/// the developer's browser daemon, even when they run inside a mini-tui session.
fn builtin_cu_on() -> bool {
    !cfg!(test) && std::env::var("MINI_AGENT_CU_MCP").map(|v| v.trim() == "1").unwrap_or(false)
}

fn builtin_cu() -> ServerSpec {
    ServerSpec {
        name: BUILTIN_CU.into(),
        id: None,
        url: format!("stdio:{BUILTIN_CU}"),
        headers: vec![],
        prefixed: true,
        allow: vec![],
        hints: vec![],
        stdio: Some(StdioCommand { program: crate::computer_use::cu_bin().to_string_lossy().into_owned(), args: vec!["mcp".into()], env: vec![] }),
    }
}

static REGISTRY: OnceLock<Result<Vec<Registry>, String>> = OnceLock::new();
static NEXT_ID: AtomicU64 = AtomicU64::new(1);

fn configured() -> bool {
    builtin_cu_on()
        || std::env::var("MINI_AGENT_MCP_URL").map(|v| !v.trim().is_empty()).unwrap_or(false)
        || std::env::var("MINI_AGENT_MCP_SERVERS").map(|v| v.trim().starts_with('[') && v.trim() != "[]").unwrap_or(false)
}

/// Tool-name-safe server name: `[A-Za-z0-9_-]`, never empty.
fn server_slug(name: &str) -> String {
    let slug: String = name.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).collect();
    let slug = slug.trim_matches('_').chars().take(24).collect::<String>();
    if slug.is_empty() { "mcp".into() } else { slug }
}

fn json_headers(value: Option<&Value>) -> Vec<(String, String)> {
    match value {
        Some(Value::Object(map)) => map.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))).collect(),
        _ => vec![],
    }
}

fn specs_from(servers_json: Option<&str>) -> Vec<ServerSpec> {
    let Some(raw) = servers_json else { return vec![] };
    let Ok(Value::Array(items)) = serde_json::from_str::<Value>(raw) else {
        eprintln!("[mcp] MINI_AGENT_MCP_SERVERS is not a JSON array; ignored");
        return vec![];
    };
    items
        .iter()
        .filter_map(|item| {
            let raw_name = item.get("name").and_then(Value::as_str).unwrap_or("mcp");
            let name = server_slug(raw_name);
            let allow = item.get("tools").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
            let hints = json_headers(item.get("hints"));
            // A local server: a program to run instead of a URL to call.
            if let Some(program) = item.get("command").and_then(Value::as_str).map(str::trim).filter(|c| !c.is_empty()) {
                let args = item.get("args").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(str::to_string).collect()).unwrap_or_default();
                let stdio = StdioCommand { program: program.to_string(), args, env: json_headers(item.get("env")) };
                return Some(ServerSpec { url: format!("stdio:{name}"), name, id: Some(raw_name.to_string()), headers: vec![], prefixed: true, allow, hints, stdio: Some(stdio) });
            }
            let url = item.get("url").and_then(Value::as_str)?.trim().trim_end_matches('/').to_string();
            if url.is_empty() {
                return None;
            }
            let headers = fresh_headers(raw_name).unwrap_or_else(|| json_headers(item.get("headers")));
            Some(ServerSpec { name, id: Some(raw_name.to_string()), url, headers, prefixed: true, allow, hints, stdio: None })
        })
        .collect()
}

fn specs() -> Vec<ServerSpec> {
    let mut out = Vec::new();
    if let Ok(url) = std::env::var("MINI_AGENT_MCP_URL") {
        if !url.trim().is_empty() {
            let name = std::env::var("MINI_AGENT_MCP_NAME").unwrap_or_else(|_| "composio".into());
            out.push(ServerSpec { name, id: None, url: url.trim().trim_end_matches('/').to_string(), headers: headers(), prefixed: false, allow: vec![], hints: vec![], stdio: None });
        }
    }
    let builtin = builtin_cu_on();
    for spec in specs_from(std::env::var("MINI_AGENT_MCP_SERVERS").ok().as_deref()) {
        // The built-in owns the `cu` namespace: an installed server of that name would collide
        // with it tool by tool (and take the whole run's MCP down with a name collision).
        if builtin && spec.name == BUILTIN_CU {
            eprintln!("[mcp] {BUILTIN_CU}: the name belongs to the built-in browser server; the installed one is skipped");
            continue;
        }
        out.push(spec);
    }
    if builtin {
        out.push(builtin_cu());
    }
    out
}

/// A local MCP server: a child process speaking JSON-RPC, one message per line, over its
/// stdin/stdout. It is started once per run and lives as long as the run, so a tool call costs a
/// write and a read, not a process. Its sessions live here, by their registry's `stdio:` address.
struct StdioSession {
    child: Mutex<Child>,
    /// Taken (closed) to stop the server: end of input is how a stdio server is told to finish.
    stdin: Mutex<Option<ChildStdin>>,
    /// Requests in flight, by JSON-RPC id; the reader thread hands each its answer.
    pending: Arc<Mutex<HashMap<u64, Sender<Value>>>>,
    /// False once the server's output ended: every call then fails at once instead of waiting
    /// out its timeout (a program that is not an MCP server prints and exits).
    alive: Arc<AtomicBool>,
}

static STDIO: OnceLock<Mutex<HashMap<String, Arc<StdioSession>>>> = OnceLock::new();

fn stdio_sessions() -> &'static Mutex<HashMap<String, Arc<StdioSession>>> {
    STDIO.get_or_init(|| Mutex::new(HashMap::new()))
}

fn stdio_session(address: &str) -> Option<Arc<StdioSession>> {
    stdio_sessions().lock().ok()?.get(address).cloned()
}

impl StdioSession {
    fn spawn(command: &StdioCommand) -> Result<Self, String> {
        let mut cmd = Command::new(&command.program);
        cmd.args(&command.args).envs(command.env.iter().map(|(k, v)| (k, v)));
        // stderr is the server's log, not part of the protocol; it would only fill the run's log.
        cmd.stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::null());
        // Its own process group: a Ctrl-C meant for the agent must not kill the server before the
        // agent stops it (cu closes the run's tabs on the way out). If the agent dies instead,
        // the pipe closes and the server sees the end of its input all the same.
        #[cfg(unix)]
        {
            use std::os::unix::process::CommandExt;
            cmd.process_group(0);
        }
        let mut child = cmd.spawn().map_err(|error| format!("cannot run {}: {error}", command.program))?;
        let stdin = child.stdin.take().ok_or("the server has no stdin")?;
        let stdout = child.stdout.take().ok_or("the server has no stdout")?;
        let pending: Arc<Mutex<HashMap<u64, Sender<Value>>>> = Arc::new(Mutex::new(HashMap::new()));
        let alive = Arc::new(AtomicBool::new(true));
        let (reader_pending, reader_alive) = (Arc::clone(&pending), Arc::clone(&alive));
        std::thread::spawn(move || {
            for line in BufReader::new(stdout).lines() {
                let Ok(line) = line else { break };
                // Anything that is not a JSON-RPC answer (a notification, a stray print) is skipped.
                let Ok(value) = serde_json::from_str::<Value>(line.trim()) else { continue };
                let Some(id) = value.get("id").and_then(Value::as_u64) else { continue };
                let sender = reader_pending.lock().ok().and_then(|mut map| map.remove(&id));
                if let Some(sender) = sender {
                    let _ = sender.send(value);
                }
            }
            // Output ended: the server is gone. Dropping the senders wakes every waiting call.
            reader_alive.store(false, Ordering::SeqCst);
            if let Ok(mut map) = reader_pending.lock() {
                map.clear();
            }
        });
        Ok(StdioSession { child: Mutex::new(child), stdin: Mutex::new(Some(stdin)), pending, alive })
    }

    fn write_line(&self, payload: &Value) -> Result<(), String> {
        let mut guard = self.stdin.lock().map_err(|_| "the server's input is gone")?;
        let stdin = guard.as_mut().ok_or("the server was stopped")?;
        stdin.write_all(format!("{payload}\n").as_bytes()).and_then(|_| stdin.flush()).map_err(|error| format!("cannot write to the server: {error}"))
    }

    /// One request, one answer, matched by id.
    fn request(&self, payload: Value, timeout: Duration) -> Result<Value, String> {
        let id = payload.get("id").and_then(Value::as_u64).ok_or("a request needs an id")?;
        let method = payload.get("method").and_then(Value::as_str).unwrap_or("request").to_string();
        let (sender, receiver) = channel();
        self.pending.lock().map_err(|_| "the server is gone")?.insert(id, sender);
        // Checked after the waiter is in: the reader marks the server gone BEFORE it clears the
        // waiters, so either this sees it gone, or the clear drops this waiter (Disconnected).
        // Checked first, a server ending in between left a waiter nobody would ever wake.
        if !self.alive.load(Ordering::SeqCst) {
            let _ = self.pending.lock().map(|mut map| map.remove(&id));
            return Err(format!("MCP {method}: the server exited"));
        }
        if let Err(error) = self.write_line(&payload) {
            let _ = self.pending.lock().map(|mut map| map.remove(&id));
            return Err(error);
        }
        let answer = match receiver.recv_timeout(timeout) {
            Ok(answer) => answer,
            Err(RecvTimeoutError::Disconnected) => return Err(format!("MCP {method}: the server exited before answering")),
            Err(RecvTimeoutError::Timeout) => {
                let _ = self.pending.lock().map(|mut map| map.remove(&id));
                return Err(format!("MCP {method}: no answer in {}s", timeout.as_secs()));
            }
        };
        if let Some(error) = answer.get("error") {
            let message = error.get("message").and_then(Value::as_str).unwrap_or_else(|| error.as_str().unwrap_or("MCP error"));
            return Err(format!("MCP {method}: {message}"));
        }
        Ok(answer.get("result").cloned().unwrap_or(Value::Null))
    }

    /// Close its input and give it a moment to finish (cu answers what is in flight and closes
    /// the tabs the run opened); kill it if it does not.
    fn stop(&self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            stdin.take();
        }
        let Ok(mut child) = self.child.lock() else { return };
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if matches!(child.try_wait(), Ok(Some(_))) {
                return;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        let _ = child.kill();
        let _ = child.wait();
    }
}

/// The timeout a request gets (the same knob as the HTTP transport's).
fn request_timeout() -> Duration {
    Duration::from_secs_f64(std::env::var("MINI_AGENT_MCP_TIMEOUT").ok().and_then(|v| v.parse().ok()).unwrap_or(60.0))
}

/// Start a local server, run the handshake and register its session under its address.
fn stdio_connect(spec: &ServerSpec, command: &StdioCommand) -> Result<Arc<StdioSession>, String> {
    let session = Arc::new(StdioSession::spawn(command)?);
    let initialized = session.request(json!({
        "jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "initialize",
        "params": {"protocolVersion": "2024-11-05", "capabilities": {}, "clientInfo": {"name": "mini-agent-rs", "version": crate::agent::VERSION}}
    }), request_timeout());
    if let Err(error) = initialized {
        session.stop();
        return Err(error);
    }
    let _ = session.write_line(&json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    if let Ok(mut sessions) = stdio_sessions().lock() {
        sessions.insert(spec.url.clone(), Arc::clone(&session));
    }
    Ok(session)
}

/// The headers mini-tui would send for server `id` right now, from `MINI_AGENT_MCP_FILE`
/// (same rule as `authHeaders` in src/mcp/client.ts: static headers, then the OAuth access token
/// or the token file). None when there is no file or no such server.
fn fresh_headers(id: &str) -> Option<Vec<(String, String)>> {
    let path = std::env::var("MINI_AGENT_MCP_FILE").ok().filter(|p| !p.trim().is_empty())?;
    headers_from_file(&path, id)
}

fn headers_from_file(path: &str, id: &str) -> Option<Vec<(String, String)>> {
    let data: Value = serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()?;
    let server = data.get("servers")?.as_array()?.iter().find(|s| s.get("id").and_then(Value::as_str) == Some(id))?;
    let mut out: Vec<(String, String)> = json_headers(server.get("headers")).into_iter().filter(|(k, _)| !k.eq_ignore_ascii_case("authorization")).collect();
    let static_auth = json_headers(server.get("headers")).into_iter().find(|(k, _)| k.eq_ignore_ascii_case("authorization"));
    let token = server.pointer("/oauth/tokens/accessToken").and_then(Value::as_str).map(str::to_string).or_else(|| {
        let file = server.get("tokenFile").and_then(Value::as_str)?;
        let home = std::env::var("HOME").unwrap_or_default();
        let file = if file == "~" || file.starts_with("~/") { format!("{home}{}", &file[1..]) } else { file.to_string() };
        let token = std::fs::read_to_string(file).ok()?.trim().to_string();
        (!token.is_empty() && !token.contains(['\r', '\n'])).then_some(token)
    });
    match token {
        Some(token) => out.push(("Authorization".into(), format!("Bearer {token}"))),
        None => out.extend(static_auth),
    }
    Some(out)
}

fn auth_refused(error: &str) -> bool {
    error.starts_with("MCP HTTP 401 ") || error.starts_with("MCP HTTP 403 ")
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
    exposed_name_for(original, server, false)
}

fn exposed_name_for(original: &str, server: &str, prefixed: bool) -> String {
    let mut name = if prefixed || reserved(original) { format!("mcp__{server}__{original}") } else { original.to_string() };
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

fn post(url: &str, client: &Conn, payload: &Value) -> Result<(Option<String>, Value), String> {
    let url = url.trim_end_matches('/');
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

/// initialize + notifications/initialized: a new session with these headers.
fn handshake(url: &str, headers: Vec<(String, String)>) -> Result<Conn, String> {
    let protocol = "2024-11-05".to_string();
    let mut client = Conn { headers, session: None, protocol: protocol.clone() };
    let (session, initialized) = post(url, &client, &json!({
        "jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "initialize",
        "params": {"protocolVersion": protocol, "capabilities": {}, "clientInfo": {"name": "mini-agent-rs", "version": crate::agent::VERSION}}
    }))?;
    client.session = session;
    if let Some(negotiated) = initialized.get("protocolVersion").and_then(Value::as_str) {
        client.protocol = negotiated.to_string();
    }
    // initialized is a notification (no id and normally 202/empty). Some compatible servers
    // return 200 instead; both are accepted by post().
    let _ = post(url, &client, &json!({"jsonrpc": "2.0", "method": "notifications/initialized"}));
    Ok(client)
}

fn initialize(spec: &ServerSpec, exposed: &mut std::collections::HashSet<String>) -> Result<Registry, String> {
    let stdio = match &spec.stdio {
        Some(command) => Some(stdio_connect(spec, command)?),
        None => None,
    };
    let conn = match &stdio {
        Some(_) => Conn { headers: vec![], session: None, protocol: "2024-11-05".into() },
        None => handshake(&spec.url, spec.headers.clone())?,
    };
    let mut client = Registry { url: spec.url.clone(), id: spec.id.clone(), conn: Mutex::new(conn.clone()), tools: vec![] };
    let mut raw_tools = Vec::new();
    let mut cursor = Value::Null;
    for _ in 0..20 {
        let params = if cursor.is_null() { json!({}) } else { json!({"cursor": cursor}) };
        let request = json!({"jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "tools/list", "params": params});
        let listed = match &stdio {
            Some(session) => session.request(request, request_timeout()),
            None => post(&client.url, &conn, &request).map(|(_, result)| result),
        };
        let result = match listed {
            Ok(result) => result,
            Err(error) => {
                if let Some(session) = &stdio {
                    session.stop();
                }
                return Err(error);
            }
        };
        raw_tools.extend(result.get("tools").and_then(Value::as_array).cloned().unwrap_or_default());
        let next = result.get("nextCursor").cloned().filter(|v| !v.is_null());
        let Some(next) = next else { break };
        cursor = next;
    }
    for tool in raw_tools {
        let Some(original) = tool.get("name").and_then(Value::as_str) else { continue };
        if !spec.allow.is_empty() && !spec.allow.iter().any(|a| a == original) {
            continue;
        }
        let name = exposed_name_for(original, &spec.name, spec.prefixed);
        if !exposed.insert(name.clone()) {
            return Err(format!("MCP tool name collision after normalization: {name}"));
        }
        client.tools.push(RemoteTool {
            exposed: name,
            original: original.to_string(),
            description: {
                let base = tool.get("description").and_then(Value::as_str).unwrap_or("MCP tool");
                match spec.hints.iter().find(|(t, _)| t == original) {
                    Some((_, hint)) => format!("{base}\n\n{hint}"),
                    None => base.to_string(),
                }
            },
            schema: tool.get("inputSchema").cloned().unwrap_or_else(|| json!({"type": "object", "properties": {}})),
        });
    }
    Ok(client)
}

/// Every configured server, connected once. The legacy server failing is an error (the benchmark
/// relies on it); an installed server failing is reported and skipped, so one server whose login
/// expired does not take the others down.
fn registry() -> Result<&'static Vec<Registry>, String> {
    if !configured() {
        return Err("no MCP server configured (MINI_AGENT_MCP_URL / MINI_AGENT_MCP_SERVERS)".into());
    }
    REGISTRY.get_or_init(|| {
        let mut exposed = std::collections::HashSet::new();
        let mut out = Vec::new();
        for spec in specs() {
            match initialize(&spec, &mut exposed) {
                Ok(registry) => out.push(registry),
                Err(error) if !spec.prefixed => return Err(error),
                Err(error) => eprintln!("[mcp] {}: {error}", spec.name),
            }
        }
        Ok(out)
    }).as_ref().map_err(Clone::clone)
}

fn find_tool(name: &str) -> Result<(&'static Registry, &'static RemoteTool), String> {
    for registry in registry()? {
        if let Some(tool) = registry.tools.iter().find(|tool| tool.exposed == name) {
            return Ok((registry, tool));
        }
    }
    Err(format!("unknown MCP tool {name}"))
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
        Ok(registries) => registries.iter().flat_map(|registry| registry.tools.iter().map(|tool| tool_values(tool, protocol))).collect(),
        Err(error) => {
            eprintln!("[mcp] {error}");
            vec![]
        }
    }
}

/// End every MCP session this process opened (HTTP DELETE with its `Mcp-Session-Id`), as the
/// Streamable HTTP spec asks of a client that is done. Servers cap live sessions (OpenPencil: 10,
/// idle ones expire after 15 minutes), so a run that just exits holds a slot another worker needs.
/// Best effort, short timeout, and a no-op when nothing was connected.
pub fn close_sessions() {
    // Local servers: end of input, a moment to finish, then a kill. Taken out of the map, so a
    // second call (a signal during the normal exit) has nothing left to stop.
    let local: Vec<Arc<StdioSession>> = stdio_sessions().lock().map(|mut map| map.drain().map(|(_, session)| session).collect()).unwrap_or_default();
    for session in local {
        session.stop();
    }
    let Some(Ok(registries)) = REGISTRY.get() else { return };
    for registry in registries {
        if registry.url.starts_with("stdio:") {
            continue;
        }
        let conn = registry.conn();
        let Some(session) = &conn.session else { continue };
        let mut request = ureq::delete(registry.url.trim_end_matches('/')).set("Mcp-Session-Id", session).timeout(Duration::from_secs(2));
        for (key, value) in &conn.headers {
            request = request.set(key, value);
        }
        let _ = request.call();
    }
}

pub fn tool_names() -> Result<Vec<String>, String> {
    Ok(registry()?.iter().flat_map(|registry| registry.tools.iter().map(|tool| tool.exposed.clone())).collect())
}

pub fn is_tool(name: &str) -> bool {
    configured() && find_tool(name).is_ok()
}

fn call(registry: &Registry, tool: &RemoteTool, args: &Value) -> Result<Value, String> {
    let payload = || json!({"jsonrpc": "2.0", "id": NEXT_ID.fetch_add(1, Ordering::SeqCst), "method": "tools/call", "params": {"name": tool.original, "arguments": args}});
    if registry.url.starts_with("stdio:") {
        let session = stdio_session(&registry.url).ok_or_else(|| format!("MCP server {} was stopped", registry.url.trim_start_matches("stdio:")))?;
        return session.request(payload(), request_timeout());
    }
    let conn = registry.conn();
    match post(&registry.url, &conn, &payload()) {
        Err(error) if auth_refused(&error) => {
            // The token in hand expired (or was rotated): take the one mini-tui holds now.
            let Some(id) = &registry.id else { return Err(error) };
            let hint = format!("{error}\nThe login for MCP server \"{id}\" was refused: if this persists, log in again with /mcp (web: Settings → MCP).");
            let Some(headers) = fresh_headers(id) else { return Err(hint) };
            if headers == conn.headers {
                return Err(hint);
            }
            let next = handshake(&registry.url, headers).map_err(|e| format!("{e}\n{hint}"))?;
            if let Ok(mut slot) = registry.conn.lock() {
                *slot = next.clone();
            }
            post(&registry.url, &next, &payload()).map(|(_, result)| result).map_err(|e| if auth_refused(&e) { format!("{e}\nThe login for MCP server \"{id}\" was refused: log in again with /mcp (web: Settings → MCP).") } else { e })
        }
        other => other.map(|(_, result)| result),
    }
}

/// The first image block of a tool result as a data URL, within the size an attachment may have.
fn image_url(result: &Value) -> Option<String> {
    const IMAGE_MAX_BYTES: usize = 8 * 1024 * 1024;
    let part = result.get("content")?.as_array()?.iter().find(|part| part.get("type").and_then(Value::as_str) == Some("image"))?;
    let data = part.get("data")?.as_str()?;
    let mime = part.get("mimeType").and_then(Value::as_str).filter(|m| m.starts_with("image/") && !m.contains([';', ',']))?;
    (data.len() / 4 * 3 <= IMAGE_MAX_BYTES).then(|| format!("data:{mime};base64,{data}"))
}

pub fn outcome(name: &str, args: &Value) -> Value {
    let result = find_tool(name).and_then(|(registry, tool)| call(registry, tool, args));
    match result {
        Ok(result) => {
            let is_error = result.get("isError").and_then(Value::as_bool).unwrap_or(false);
            let text = result.get("content").and_then(Value::as_array).map(|parts| {
                parts.iter().filter_map(|part| get(part, "text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n")
            }).unwrap_or_default();
            let output = if !text.is_empty() { text } else if let Some(structured) = result.get("structuredContent") { structured.to_string() } else { result.to_string() };
            let mut observation = json!({"output": output, "returncode": if is_error { 1 } else { 0 }, "exception_info": if is_error { output.clone() } else { String::new() }, "extra": {"mcp": true, "tool": name, "structuredContent": result.get("structuredContent").cloned().unwrap_or(Value::Null)}});
            // An image the tool answered (cu's screenshot) reaches the model as an image, the way a
            // `read` of a .png does, instead of being dropped with everything that is not text.
            if let Some(url) = image_url(&result) {
                observation["image_url"] = Value::String(url);
                observation["extra"]["visual_attachment"] = Value::Bool(true);
            }
            observation
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
    fn installed_servers_are_parsed_and_namespaced() {
        let specs = specs_from(Some(r#"[{"name":"Figma Dev","url":"https://mcp.figma.com/mcp/","headers":{"Authorization":"Bearer t"}},{"name":"x"},{"url":""}]"#));
        assert_eq!(specs.len(), 1);
        assert_eq!(specs[0].name, "Figma_Dev");
        assert_eq!(specs[0].url, "https://mcp.figma.com/mcp");
        assert_eq!(specs[0].headers, vec![("Authorization".to_string(), "Bearer t".to_string())]);
        assert!(specs[0].prefixed);
        assert_eq!(exposed_name_for("get_code", "figma", true), "mcp__figma__get_code");
        assert_eq!(exposed_name_for("get_code", "figma", false), "get_code");
        assert!(exposed_name_for(&"x".repeat(80), "figma", true).len() <= 64);
        assert!(specs_from(Some("not json")).is_empty());
        assert!(specs[0].allow.is_empty());
        let limited = specs_from(Some(r#"[{"name":"openpencil","url":"http://127.0.0.1:7600/mcp","tools":["render","export_image",3]}]"#));
        assert_eq!(limited[0].allow, vec!["render".to_string(), "export_image".to_string()]);
        let hinted = specs_from(Some(r#"[{"name":"op","url":"http://x/mcp","hints":{"render":"Use flex=\"row\"."}}]"#));
        assert_eq!(hinted[0].hints, vec![("render".to_string(), "Use flex=\"row\".".to_string())]);
        assert_eq!(server_slug("  "), "mcp");
    }

    fn unauthorized(stream: &mut std::net::TcpStream) {
        let body = r#"{"error":{"code":401,"message":"invalid OAuth"}}"#;
        let head = format!("HTTP/1.1 401 Unauthorized\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n", body.len());
        stream.write_all(head.as_bytes()).unwrap();
        stream.write_all(body.as_bytes()).unwrap();
    }

    #[test]
    fn mcp_json_headers_follow_mini_tui_auth_rules() {
        let dir = std::env::temp_dir().join(format!("mcp-headers-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let token_file = dir.join("token");
        std::fs::write(&token_file, "file-token\n").unwrap();
        let file = dir.join("mcp.json");
        std::fs::write(&file, json!({"servers": [
            {"id": "gsc", "url": "https://x/mcp", "headers": {"X-Key": "k", "Authorization": "Bearer static"}, "oauth": {"tokens": {"accessToken": "oauth-token"}}},
            {"id": "op", "url": "http://127.0.0.1/mcp", "tokenFile": token_file.to_string_lossy()},
            {"id": "plain", "url": "https://y/mcp", "headers": {"Authorization": "Bearer static"}}
        ]}).to_string()).unwrap();
        let path = file.to_string_lossy().to_string();
        assert_eq!(headers_from_file(&path, "gsc").unwrap(), vec![("X-Key".to_string(), "k".to_string()), ("Authorization".to_string(), "Bearer oauth-token".to_string())]);
        assert_eq!(headers_from_file(&path, "op").unwrap(), vec![("Authorization".to_string(), "Bearer file-token".to_string())]);
        assert_eq!(headers_from_file(&path, "plain").unwrap(), vec![("Authorization".to_string(), "Bearer static".to_string())]);
        assert!(headers_from_file(&path, "missing").is_none());
        assert!(headers_from_file("/nonexistent/mcp.json", "gsc").is_none());
        let _ = std::fs::remove_dir_all(dir);
    }

    /// A one-hour token expires during a long run: the 401 makes the client take the token
    /// mini-tui refreshed in mcp.json, open a new session with it and retry the call.
    #[test]
    fn an_expired_token_is_reloaded_from_mcp_json_and_the_call_retried() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..4 {
                let (mut stream, _) = listener.accept().unwrap();
                let raw = request(&mut stream);
                requests.push(raw.clone());
                match index {
                    0 => unauthorized(&mut stream),
                    1 => response(&mut stream, r#"{"jsonrpc":"2.0","id":1,"result":{"protocolVersion":"2025-06-18","capabilities":{}}}"#, true),
                    2 => response(&mut stream, "", false),
                    _ => response(&mut stream, r#"{"jsonrpc":"2.0","id":4,"result":{"content":[{"type":"text","text":"sites"}],"isError":false}}"#, false),
                }
            }
            requests
        });
        let dir = std::env::temp_dir().join(format!("mcp-retry-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("mcp.json");
        std::fs::write(&file, json!({"servers": [{"id": "google-search-console", "url": url, "oauth": {"tokens": {"accessToken": "new-token"}}}]}).to_string()).unwrap();
        std::env::set_var("MINI_AGENT_MCP_FILE", &file);
        let registry = Registry {
            url: url.clone(),
            id: Some("google-search-console".into()),
            conn: Mutex::new(Conn { headers: vec![("Authorization".into(), "Bearer old-token".into())], session: Some("old".into()), protocol: "2025-06-18".into() }),
            tools: vec![],
        };
        let tool = RemoteTool { exposed: "mcp__google-search-console__sites_list".into(), original: "sites_list".into(), description: String::new(), schema: json!({}) };
        let result = call(&registry, &tool, &json!({})).unwrap();
        std::env::remove_var("MINI_AGENT_MCP_FILE");
        assert_eq!(result["content"][0]["text"], "sites");
        let requests = handle.join().unwrap();
        assert!(requests[0].contains("Bearer old-token") && requests[0].contains("tools/call"));
        assert!(requests[1].contains("Bearer new-token") && requests[1].contains("initialize"));
        assert!(requests[3].contains("Bearer new-token") && requests[3].contains("tools/call"));
        assert!(requests[3].to_lowercase().contains("mcp-session-id: test-session"));
        assert_eq!(registry.conn().headers, vec![("Authorization".to_string(), "Bearer new-token".to_string())]);
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn client_initializes_lists_and_calls_a_streamable_server() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/mcp", listener.local_addr().unwrap());
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for index in 0..5 {
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
        close_sessions();
        let requests = handle.join().unwrap();
        assert!(requests[0].contains("initialize"));
        assert!(requests[0].contains("authorization: Bearer secret-test") || requests[0].contains("Authorization: Bearer secret-test"));
        assert!(requests[2].contains("tools/list"));
        assert!(requests[2].to_lowercase().contains("mcp-session-id: test-session"));
        assert!(requests[3].contains("tools/call"));
        assert!(requests[3].contains("PING"));
        assert!(requests[4].starts_with("DELETE "));
        assert!(requests[4].to_lowercase().contains("mcp-session-id: test-session"));
        std::env::remove_var("MINI_AGENT_MCP_URL");
        std::env::remove_var("MINI_AGENT_MCP_API_KEY");
        std::env::remove_var("MINI_AGENT_MCP_NAME");
    }
}
