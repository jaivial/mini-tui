//! `mini-agent-rs acp`: mini-tui as an Agent Client Protocol agent (JSON-RPC 2.0 over stdio).
//!
//! The server is a thin session manager. It keeps one directory per session and, for every
//! prompt, runs this same binary as a normal mini-agent turn that resumes the session's previous
//! trajectory; the turn's journal is streamed back as `session/update` notifications. Between
//! turns nothing runs but the stdin read. See docs/acp.md.

mod catalog;
mod events;
mod rpc;
mod runenv;
mod store;
mod turn;

use rpc::{Incoming, Out};
use serde_json::{json, Value};
use std::collections::{HashMap, VecDeque};
use std::io::BufRead;
use std::path::PathBuf;
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const PROTOCOL_VERSION: i64 = 1;

pub struct Session {
    pub cwd: String,
    pub model: String,
    pub mcp: Vec<Value>,
    /// meta.json once the session has had a prompt; `Null` before (an unused `session/new`, such
    /// as a client's model discovery, leaves nothing on disk).
    pub meta: Value,
    pub turn: Option<Arc<turn::Handle>>,
    pub queued: VecDeque<turn::Prompt>,
}

pub struct Server {
    pub out: Out,
    pub sessions: Mutex<HashMap<String, Session>>,
    pub exe: PathBuf,
}

type Reply = Result<Value, (i64, String)>;

fn invalid(msg: impl Into<String>) -> (i64, String) {
    (rpc::INVALID_PARAMS, msg.into())
}

fn param<'a>(params: &'a Value, key: &str) -> Result<&'a str, (i64, String)> {
    params.get(key).and_then(Value::as_str).ok_or_else(|| invalid(format!("missing string parameter `{key}`")))
}

fn session_id(params: &Value) -> Result<String, (i64, String)> {
    let id = param(params, "sessionId")?;
    if !store::valid_id(id) {
        return Err(invalid(format!("invalid sessionId: {id}")));
    }
    Ok(id.to_string())
}

fn mcp_param(params: &Value) -> Vec<Value> {
    params.get("mcpServers").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn config_options(model: &str) -> Value {
    let options = catalog::with_current(catalog::options(&catalog::connections()), model);
    json!([{
        "id": "model",
        "name": "Model",
        "description": "The model mini-agent runs this session's turns on",
        "category": "model",
        "type": "select",
        "currentValue": model,
        "options": options,
    }])
}

impl Server {
    fn handle_request(self: &Arc<Self>, id: &Value, method: &str, params: &Value) -> Option<Reply> {
        Some(match method {
            "initialize" => Ok(json!({
                "protocolVersion": PROTOCOL_VERSION,
                "agentCapabilities": {
                    "loadSession": true,
                    "promptCapabilities": {"image": true, "audio": false, "embeddedContext": true},
                    "mcpCapabilities": {"http": true, "sse": false},
                    "sessionCapabilities": {"list": {}, "close": {}},
                },
                "authMethods": [],
                "agentInfo": {"name": "mini-tui", "title": "mini-tui", "version": crate::agent::VERSION},
            })),
            "authenticate" => Ok(json!({})),
            "session/new" => self.new_session(params),
            "session/load" => self.load_session(params),
            "session/prompt" => return self.prompt(id, params),
            "session/set_config_option" => self.set_config_option(params),
            "session/set_model" => self.set_model(params),
            "session/list" => {
                let cwd = params.get("cwd").and_then(Value::as_str);
                Ok(json!({"sessions": store::list(cwd).iter().map(store::info).collect::<Vec<_>>()}))
            }
            "session/close" => self.close_session(params),
            _ => Err((rpc::METHOD_NOT_FOUND, format!("Method not found: {method}"))),
        })
    }

    fn handle_notification(self: &Arc<Self>, method: &str, params: &Value) {
        if method == "session/cancel" {
            if let Ok(sid) = session_id(params) {
                self.cancel(&sid);
            }
        }
    }

    fn new_session(&self, params: &Value) -> Reply {
        let cwd = param(params, "cwd")?;
        if !std::path::Path::new(cwd).is_absolute() {
            return Err(invalid(format!("cwd must be an absolute path: {cwd}")));
        }
        let model = catalog::default_model(&catalog::options(&catalog::connections()));
        let sid = store::new_id();
        let session = Session { cwd: cwd.to_string(), model: model.clone(), mcp: mcp_param(params), meta: Value::Null, turn: None, queued: VecDeque::new() };
        self.sessions.lock().unwrap().insert(sid.clone(), session);
        Ok(json!({"sessionId": sid, "configOptions": config_options(&model)}))
    }

    /// Replay the stored conversation as notifications, then answer.
    fn load_session(&self, params: &Value) -> Reply {
        let sid = session_id(params)?;
        let meta = store::load(&sid);
        let cwd = params.get("cwd").and_then(Value::as_str).map(str::to_string)
            .or_else(|| meta.as_ref().and_then(|m| m["cwd"].as_str().map(str::to_string)))
            .ok_or_else(|| invalid("missing string parameter `cwd`"))?;
        let model = meta.as_ref().and_then(|m| m["model"].as_str().map(str::to_string)).filter(|m| !m.is_empty())
            .unwrap_or_else(|| catalog::default_model(&catalog::options(&catalog::connections())));
        let model = {
            let mut sessions = self.sessions.lock().unwrap();
            let session = sessions.entry(sid.clone()).or_insert_with(|| Session {
                cwd: cwd.clone(), model: model.clone(), mcp: vec![], meta: meta.clone().unwrap_or(Value::Null), turn: None, queued: VecDeque::new(),
            });
            session.cwd = cwd.clone();
            session.mcp = mcp_param(params);
            session.model.clone()
        };
        if let Some(meta) = &meta {
            for update in replay(meta, &cwd, &model) {
                self.out.update(&sid, update);
            }
        }
        Ok(json!({"configOptions": config_options(&model)}))
    }

    fn prompt(self: &Arc<Self>, id: &Value, params: &Value) -> Option<Reply> {
        let sid = match session_id(params) {
            Ok(s) => s,
            Err(e) => return Some(Err(e)),
        };
        let Some(blocks) = params.get("prompt").and_then(Value::as_array) else {
            return Some(Err(invalid("missing array parameter `prompt`")));
        };
        let mut sessions = self.sessions.lock().unwrap();
        if !sessions.contains_key(&sid) {
            // A client that restarted the server may prompt a stored session without loading it.
            let Some(meta) = store::load(&sid) else {
                return Some(Err(invalid(format!("unknown session: {sid}"))));
            };
            let session = Session {
                cwd: meta["cwd"].as_str().unwrap_or("/").to_string(),
                model: meta["model"].as_str().unwrap_or("").to_string(),
                mcp: vec![], meta, turn: None, queued: VecDeque::new(),
            };
            sessions.insert(sid.clone(), session);
        }
        let session = sessions.get_mut(&sid).unwrap();
        let (task, display) = turn::prompt_text(blocks, &store::dir(&sid).join("attachments"));
        if task.trim().is_empty() {
            return Some(Err(invalid("the prompt has no text or attachment")));
        }
        let prompt = turn::Prompt { ids: vec![id.clone()], task, display };
        match &session.turn {
            Some(h) if !h.cancelled() && !h.done() => h.follow_up(prompt),
            Some(_) => session.queued.push_back(prompt),
            None => {
                let handle = turn::Handle::new(store::dir(&sid).join("control"), &session.model);
                session.turn = Some(handle.clone());
                let me = self.clone();
                std::thread::spawn(move || turn::run(me, sid, handle, prompt));
            }
        }
        None
    }

    fn cancel(&self, sid: &str) {
        let (handle, queued) = {
            let mut sessions = self.sessions.lock().unwrap();
            let Some(session) = sessions.get_mut(sid) else { return };
            (session.turn.clone(), session.queued.drain(..).collect::<Vec<_>>())
        };
        for p in queued {
            for id in p.ids {
                self.out.result(&id, json!({"stopReason": "cancelled"}));
            }
        }
        if let Some(h) = handle {
            h.cancel();
        }
    }

    fn change_model(&self, params: &Value, model: &str) -> Result<String, (i64, String)> {
        let sid = session_id(params)?;
        let model = model.trim();
        if model.is_empty() {
            return Err(invalid("empty model"));
        }
        let mut sessions = self.sessions.lock().unwrap();
        let session = sessions.get_mut(&sid).ok_or_else(|| invalid(format!("unknown session: {sid}")))?;
        session.model = model.to_string();
        if session.meta.is_object() {
            session.meta["model"] = json!(model);
            let _ = store::save(&sid, &session.meta);
        }
        if let Some(h) = session.turn.as_ref().filter(|h| !h.done()) {
            h.switch_model(model);
        }
        Ok(model.to_string())
    }

    fn set_config_option(&self, params: &Value) -> Reply {
        let config = param(params, "configId")?;
        if config != "model" {
            return Err(invalid(format!("unknown config option: {config}")));
        }
        let value = params.get("value").and_then(Value::as_str).ok_or_else(|| invalid("`value` must be a model id"))?;
        let model = self.change_model(params, value)?;
        Ok(json!({"configOptions": config_options(&model)}))
    }

    fn set_model(&self, params: &Value) -> Reply {
        self.change_model(params, param(params, "modelId")?)?;
        Ok(json!({}))
    }

    fn close_session(&self, params: &Value) -> Reply {
        let sid = session_id(params)?;
        let removed = self.sessions.lock().unwrap().remove(&sid);
        if let Some(session) = removed {
            for p in session.queued {
                for id in p.ids {
                    self.out.result(&id, json!({"stopReason": "cancelled"}));
                }
            }
            if let Some(h) = session.turn {
                h.terminate();
            }
        }
        Ok(json!({}))
    }

    /// Stop every running agent and give the turn threads a moment to answer.
    fn shutdown(&self) {
        let handles: Vec<Arc<turn::Handle>> = self.sessions.lock().unwrap().values().filter_map(|s| s.turn.clone()).collect();
        for h in &handles {
            h.terminate();
        }
        let deadline = Instant::now() + Duration::from_secs(3);
        while handles.iter().any(|h| !h.done()) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(50));
        }
    }
}

/// The updates that rebuild a stored session for `session/load`: per turn, the prompt as the
/// user wrote it, then what the agent did, then the title.
fn replay(meta: &Value, cwd: &str, model: &str) -> Vec<Value> {
    let mut out = Vec::new();
    for t in meta["turns"].as_array().into_iter().flatten() {
        let prompt = t["prompt"].as_str().unwrap_or("");
        if !prompt.is_empty() {
            out.push(json!({"sessionUpdate": "user_message_chunk", "content": {"type": "text", "text": prompt}}));
        }
        let Some(traj) = t["traj"].as_str().map(PathBuf::from) else { continue };
        let msgs = store::turn_messages(&traj);
        let task = t["task"].as_str().unwrap_or(prompt);
        let start = t["start"].as_u64().map(|s| s as usize).or_else(|| store::turn_start(&msgs, task, 0)).unwrap_or(msgs.len());
        let mut mapper = events::Mapper::new(cwd, model, true);
        for m in msgs.iter().skip(start) {
            out.extend(mapper.message(m));
        }
    }
    if let Some(title) = meta["title"].as_str().filter(|t| !t.is_empty()) {
        out.push(json!({"sessionUpdate": "session_info_update", "title": title, "updatedAt": meta["updatedAt"]}));
    }
    out
}

extern "C" fn on_signal(sig: libc::c_int) {
    for slot in turn::PIDS.iter() {
        let pid = slot.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }
    unsafe { libc::_exit(128 + sig) };
}

fn install_signals() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        for sig in [libc::SIGTERM, libc::SIGINT, libc::SIGHUP] {
            libc::sigaction(sig, &action, std::ptr::null_mut());
        }
    }
}

const USAGE: &str = "usage: mini-agent-rs acp

Serve the Agent Client Protocol (JSON-RPC 2.0, one message per line) on stdin/stdout.
Each prompt runs a mini-agent turn in the session's cwd. Sessions are stored under
~/.config/mini-tui/acp-sessions (MINI_AGENT_ACP_HOME overrides). See docs/acp.md.";

pub fn main(args: &[String]) -> i32 {
    if args.iter().any(|a| a == "-h" || a == "--help") {
        println!("{USAGE}");
        return 0;
    }
    if let Some(a) = args.first() {
        eprintln!("unknown argument: {a}\n{USAGE}");
        return 2;
    }
    install_signals();
    let exe = match std::env::current_exe() {
        Ok(p) => p,
        Err(e) => {
            eprintln!("cannot locate this executable: {e}");
            return 1;
        }
    };
    let server = Arc::new(Server { out: Out::stdout(), sessions: Mutex::new(HashMap::new()), exe });
    serve(&server, std::io::stdin().lock());
    server.shutdown();
    0
}

fn serve(server: &Arc<Server>, mut input: impl BufRead) {
    let mut line = String::new();
    loop {
        line.clear();
        match input.read_line(&mut line) {
            Ok(0) => return,
            Ok(_) => {}
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(e) if e.kind() == std::io::ErrorKind::InvalidData => {
                server.out.error(&Value::Null, rpc::PARSE_ERROR, "Parse error: input is not UTF-8");
                continue;
            }
            Err(_) => return,
        }
        match rpc::parse(&line) {
            None | Some(Incoming::Response) => {}
            Some(Incoming::Invalid { id, code, message }) => server.out.error(&id, code, &message),
            Some(Incoming::Notification { method, params }) => server.handle_notification(&method, &params),
            Some(Incoming::Request { id, method, params }) => match server.handle_request(&id, &method, &params) {
                Some(Ok(result)) => server.out.result(&id, result),
                Some(Err((code, message))) => server.out.error(&id, code, &message),
                None => {}
            },
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use rpc::tests::Buf;

    fn server() -> (Arc<Server>, Buf) {
        let buf = Buf::default();
        let server = Arc::new(Server { out: Out::new(Box::new(buf.clone())), sessions: Mutex::new(HashMap::new()), exe: PathBuf::from("/bin/false") });
        (server, buf)
    }

    #[test]
    fn handshake_new_session_and_errors() {
        let (server, buf) = server();
        let input = [
            r#"{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":1,"clientCapabilities":{}}}"#,
            r#"{"jsonrpc":"2.0","id":2,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}"#,
            r#"{"jsonrpc":"2.0","id":3,"method":"session/new","params":{"cwd":"relative","mcpServers":[]}}"#,
            r#"{"jsonrpc":"2.0","id":4,"method":"nope/nope","params":{}}"#,
            r#"{"jsonrpc":"2.0","method":"unknown/notification","params":{}}"#,
            "garbage",
            r#"{"jsonrpc":"2.0","id":5,"method":"session/prompt","params":{"sessionId":"../x","prompt":[]}}"#,
        ]
        .join("\n");
        serve(&server, std::io::Cursor::new(input));
        let lines = buf.lines();
        assert_eq!(lines.len(), 6, "{lines:?}");
        assert_eq!(lines[0]["result"]["protocolVersion"], json!(1));
        assert_eq!(lines[0]["result"]["agentCapabilities"]["loadSession"], json!(true));
        let sid = lines[1]["result"]["sessionId"].as_str().unwrap();
        assert!(store::valid_id(sid));
        let model = &lines[1]["result"]["configOptions"][0];
        assert_eq!((model["id"].as_str(), model["category"].as_str(), model["type"].as_str()), (Some("model"), Some("model"), Some("select")));
        assert!(model["options"].as_array().unwrap().iter().any(|o| o["value"] == model["currentValue"]));
        assert_eq!(lines[2]["error"]["code"], json!(rpc::INVALID_PARAMS));
        assert_eq!(lines[3]["error"]["code"], json!(rpc::METHOD_NOT_FOUND));
        assert_eq!(lines[4]["error"]["code"], json!(rpc::PARSE_ERROR));
        assert_eq!(lines[5]["error"]["code"], json!(rpc::INVALID_PARAMS));
        // An unprompted session leaves nothing on disk.
        assert!(!store::dir(sid).exists());
    }

    #[test]
    fn set_config_option_switches_the_model() {
        let (server, buf) = server();
        serve(&server, std::io::Cursor::new(r#"{"jsonrpc":"2.0","id":1,"method":"session/new","params":{"cwd":"/tmp","mcpServers":[]}}"#));
        let sid = buf.lines()[0]["result"]["sessionId"].as_str().unwrap().to_string();
        let req = json!({"jsonrpc": "2.0", "id": 2, "method": "session/set_config_option", "params": {"sessionId": sid, "configId": "model", "value": "openai/gpt-mock"}});
        let bad = json!({"jsonrpc": "2.0", "id": 3, "method": "session/set_config_option", "params": {"sessionId": sid, "configId": "mode", "value": "x"}});
        serve(&server, std::io::Cursor::new(format!("{req}\n{bad}\n")));
        let lines = buf.lines();
        assert_eq!(lines[1]["result"]["configOptions"][0]["currentValue"], json!("openai/gpt-mock"));
        assert_eq!(lines[2]["error"]["code"], json!(rpc::INVALID_PARAMS));
        assert_eq!(server.sessions.lock().unwrap()[&sid].model, "openai/gpt-mock");
    }

    #[test]
    fn replay_rebuilds_prompts_tool_calls_and_title() {
        let dir = std::env::temp_dir().join(format!("acp-replay-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let traj = dir.join("turn-1.traj.json");
        let messages = json!([
            {"role": "system", "content": "s"},
            {"role": "user", "content": "Please solve this issue: list files"},
            {"role": "assistant", "content": null, "tool_calls": [{"id": "c1", "function": {"name": "bash", "arguments": "{\"command\": \"ls\"}"}}]},
            {"role": "tool", "tool_call_id": "c1", "content": "x", "extra": {"raw_output": "a\n", "returncode": 0}},
            {"role": "user", "content": "The user added a new task: and sizes", "extra": {"interrupt_type": "UserNewTask"}},
            {"role": "assistant", "content": "Done."},
            {"role": "exit", "content": "", "extra": {"exit_status": "Submitted", "submission": "Done."}}
        ]);
        std::fs::write(&traj, json!({"messages": messages}).to_string()).unwrap();
        let meta = json!({"title": "Files", "updatedAt": "2026-10-31T00:00:00Z", "turns": [{"prompt": "list files", "task": "list files", "traj": traj.display().to_string()}]});
        let kinds: Vec<String> = replay(&meta, "/r", "m").iter().map(|u| u["sessionUpdate"].as_str().unwrap().to_string()).collect();
        assert_eq!(kinds, vec!["user_message_chunk", "tool_call", "tool_call_update", "user_message_chunk", "agent_message_chunk", "session_info_update"]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
