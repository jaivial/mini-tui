//! One prompt turn: run the agent on the session's conversation and stream its journal.
//!
//! Each turn is a child `mini-agent-rs -y --exit-immediately -o turn-N.traj.json --resume <prev>`
//! in the session's cwd, with the environment mini-tui gives its own runs. While it runs, the
//! turn's thread polls the journal (no polling at all between turns) and forwards what it maps
//! to `session/update`. The prompt's response is sent when the child exits.

use super::events::Mapper;
use super::{runenv, store, Server};
use base64::Engine;
use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom, Write};
use std::os::unix::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicI32, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

const POLL: Duration = Duration::from_millis(150);
/// A cancelled agent gets this long to save after SIGINT before SIGTERM.
const CANCEL_GRACE: Duration = Duration::from_secs(2);
const TITLE_TIMEOUT: Duration = Duration::from_secs(20);

/// Agents alive right now, for the signal handler: it cannot take locks.
pub static PIDS: [AtomicI32; 64] = [const { AtomicI32::new(0) }; 64];

fn register(pid: i32) {
    for slot in PIDS.iter() {
        if slot.compare_exchange(0, pid, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            return;
        }
    }
}

fn unregister(pid: i32) {
    for slot in PIDS.iter() {
        let _ = slot.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}

/// A prompt waiting to run: the request ids it answers and the task text the agent gets.
pub struct Prompt {
    pub ids: Vec<Value>,
    pub task: String,
    pub display: String,
}

pub struct Handle {
    pid: AtomicI32,
    cancelled: AtomicBool,
    done: AtomicBool,
    control: PathBuf,
    /// Requests whose prompt was folded into this turn through the control file.
    waiters: Mutex<Vec<Value>>,
    model: Mutex<String>,
}

impl Handle {
    pub fn new(control: PathBuf, model: &str) -> Arc<Self> {
        Arc::new(Handle {
            pid: AtomicI32::new(0),
            cancelled: AtomicBool::new(false),
            done: AtomicBool::new(false),
            control,
            waiters: Mutex::new(Vec::new()),
            model: Mutex::new(model.to_string()),
        })
    }

    pub fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::SeqCst)
    }

    fn append_control(&self, line: &str) {
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&self.control) {
            let _ = writeln!(f, "{line}");
        }
    }

    /// A prompt sent while the agent works: it reads it before its next step, as a mini-tui
    /// follow-up. Its request is answered when this turn ends.
    pub fn follow_up(&self, prompt: Prompt) {
        self.append_control(&format!("MESSAGE {}", Value::String(prompt.task)));
        self.waiters.lock().unwrap().extend(prompt.ids);
    }

    pub fn switch_model(&self, model: &str) {
        self.append_control(&format!("MODEL {model}"));
        *self.model.lock().unwrap() = model.to_string();
    }

    /// SIGINT (the agent saves and stops), then SIGTERM if it has not exited after the grace.
    pub fn cancel(self: &Arc<Self>) {
        if self.cancelled.swap(true, Ordering::SeqCst) {
            return;
        }
        let pid = self.pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGINT) };
        }
        let me = self.clone();
        std::thread::spawn(move || {
            std::thread::sleep(CANCEL_GRACE);
            let pid = me.pid.load(Ordering::SeqCst);
            if !me.done.load(Ordering::SeqCst) && pid > 0 {
                unsafe { libc::kill(pid, libc::SIGTERM) };
            }
        });
    }

    pub fn terminate(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        let pid = self.pid.load(Ordering::SeqCst);
        if pid > 0 {
            unsafe { libc::kill(pid, libc::SIGTERM) };
        }
    }

    pub fn done(&self) -> bool {
        self.done.load(Ordering::SeqCst)
    }
}

/// ACP content blocks to the agent's task text, saving inline images and blobs under `attach`.
/// Returns `(task, display)`: what the agent reads and what a replay shows as the user message.
pub fn prompt_text(blocks: &[Value], attach: &Path) -> (String, String) {
    let mut texts: Vec<String> = Vec::new();
    let mut files: Vec<String> = Vec::new();
    let mut names: Vec<String> = Vec::new();
    let s = |v: &Value, k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    let save = |data: &str, mime: &str, name: &str| -> Option<(String, usize)> {
        let bytes = base64::engine::general_purpose::STANDARD.decode(data.trim()).ok()?;
        std::fs::create_dir_all(attach).ok()?;
        let ext = match mime {
            "image/png" => "png",
            "image/jpeg" | "image/jpg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "audio/wav" | "audio/x-wav" => "wav",
            "audio/mpeg" => "mp3",
            _ => Path::new(name).extension().and_then(|e| e.to_str()).unwrap_or("bin"),
        };
        let path = attach.join(format!("{}.{ext}", crate::util_hex(12)));
        std::fs::write(&path, &bytes).ok()?;
        Some((path.display().to_string(), bytes.len()))
    };
    for b in blocks {
        match b.get("type").and_then(Value::as_str).unwrap_or("") {
            "text" => texts.push(s(b, "text")),
            "resource_link" => {
                let uri = s(b, "uri");
                let name = Some(s(b, "name")).filter(|n| !n.is_empty()).unwrap_or_else(|| uri.clone());
                let target = file_path(&uri).unwrap_or(uri);
                let mime = Some(s(b, "mimeType")).filter(|m| !m.is_empty()).unwrap_or_else(|| "file".into());
                let size = b.get("size").and_then(Value::as_u64).map(|n| format!(", {n} bytes")).unwrap_or_default();
                files.push(format!("- {name} — {mime}{size} — at {target}"));
                names.push(name);
            }
            kind @ ("image" | "audio") => {
                let mime = s(b, "mimeType");
                let name = Some(s(b, "uri")).filter(|u| !u.is_empty()).and_then(|u| u.rsplit('/').next().map(str::to_string)).unwrap_or_else(|| kind.to_string());
                match save(&s(b, "data"), &mime, &name) {
                    Some((path, size)) => files.push(format!("- {name} — {mime}, {size} bytes — saved at {path}")),
                    None => files.push(format!("- {name} — {mime} — could not be decoded")),
                }
                names.push(name);
            }
            "resource" => {
                let r = b.get("resource").cloned().unwrap_or(json!({}));
                let uri = s(&r, "uri");
                if let Some(text) = r.get("text").and_then(Value::as_str) {
                    texts.push(format!("<resource uri=\"{uri}\">\n{text}\n</resource>"));
                } else if let Some(blob) = r.get("blob").and_then(Value::as_str) {
                    let mime = s(&r, "mimeType");
                    let name = uri.rsplit('/').next().unwrap_or("resource").to_string();
                    if let Some((path, size)) = save(blob, &mime, &name) {
                        files.push(format!("- {name} — {mime}, {size} bytes — saved at {path}"));
                    }
                    names.push(name);
                }
            }
            _ => {}
        }
    }
    let body = texts.join("\n\n");
    let mut task = body.clone();
    let mut display = body;
    if !files.is_empty() {
        task = format!("{task}\n\n<attachments>\n{}\n</attachments>", files.join("\n")).trim_start().to_string();
        display = format!("{display}\n\n[attached: {}]", names.join(", ")).trim_start().to_string();
    }
    (task, display)
}

/// The local path of a `file://` URI (percent-decoded), None for anything else.
fn file_path(uri: &str) -> Option<String> {
    let rest = uri.strip_prefix("file://")?;
    let rest = rest.strip_prefix("localhost").unwrap_or(rest);
    let bytes = rest.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        if bytes[i] == b'%' && i + 2 < bytes.len() {
            if let Ok(b) = u8::from_str_radix(&rest[i + 1..i + 3], 16) {
                out.push(b);
                i += 3;
                continue;
            }
        }
        out.push(bytes[i]);
        i += 1;
    }
    String::from_utf8(out).ok()
}

/// The title a session gets before (or without) a generated one.
pub fn fallback_title(display: &str) -> String {
    let line = display.lines().find(|l| !l.trim().is_empty()).unwrap_or("").split_whitespace().collect::<Vec<_>>().join(" ");
    line.chars().take(60).collect()
}

/// Run `prompt` and every prompt queued behind it on session `sid`, answering each.
pub fn run(server: Arc<Server>, sid: String, handle: Arc<Handle>, prompt: Prompt) {
    let (mut handle, mut prompt) = (handle, prompt);
    loop {
        let outcome = run_one(&server, &sid, &handle, &prompt);
        handle.done.store(true, Ordering::SeqCst);
        let mut ids = prompt.ids.clone();
        ids.extend(handle.waiters.lock().unwrap().drain(..));
        // Follow-ups the agent never read (it was already finishing) become the next turn.
        let unread = unread_messages(&handle.control);
        let mut sessions = server.sessions.lock().unwrap();
        let Some(session) = sessions.get_mut(&sid) else {
            drop(sessions);
            answer(&server, &ids, &outcome);
            return;
        };
        let next = if !unread.is_empty() && !handle.cancelled() {
            // The requests behind those messages are answered by the turn that reads them.
            let late: Vec<Value> = ids.split_off(prompt.ids.len().min(ids.len()));
            let text = unread.join("\n\n");
            Some(Prompt { ids: late, task: text.clone(), display: text })
        } else {
            session.queued.pop_front()
        };
        match next {
            Some(p) => {
                let h = Handle::new(store::dir(&sid).join("control"), &session.model);
                session.turn = Some(h.clone());
                drop(sessions);
                answer(&server, &ids, &outcome);
                handle = h;
                prompt = p;
            }
            None => {
                session.turn = None;
                drop(sessions);
                answer(&server, &ids, &outcome);
                return;
            }
        }
    }
}

fn answer(server: &Server, ids: &[Value], outcome: &Result<String, String>) {
    for id in ids {
        match outcome {
            Ok(reason) => server.out.result(id, json!({"stopReason": reason})),
            Err(message) => server.out.error(id, super::rpc::INTERNAL_ERROR, message),
        }
    }
}

fn unread_messages(control: &Path) -> Vec<String> {
    let Ok(raw) = std::fs::read_to_string(control) else { return vec![] };
    let _ = std::fs::write(control, "");
    raw.lines()
        .filter_map(|l| l.trim().strip_prefix("MESSAGE "))
        .filter_map(|p| serde_json::from_str::<Value>(p.trim()).ok().and_then(|v| v.as_str().map(str::to_string)))
        .filter(|t| !t.trim().is_empty())
        .collect()
}

struct TurnSetup {
    cwd: String,
    model: String,
    mcp: Vec<Value>,
    traj: PathBuf,
    previous: Vec<PathBuf>,
    turn_index: usize,
    first: bool,
}

/// Record the turn in meta.json (persisting the session on its first prompt).
fn setup(server: &Server, sid: &str, prompt: &Prompt) -> Result<TurnSetup, String> {
    let mut sessions = server.sessions.lock().unwrap();
    let session = sessions.get_mut(sid).ok_or("session closed")?;
    let dir = store::dir(sid);
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let now = crate::util::now_iso();
    if !session.meta.is_object() {
        session.meta = json!({"sessionId": sid, "cwd": session.cwd, "model": session.model, "title": fallback_title(&prompt.display), "createdAt": now, "updatedAt": now, "turns": []});
    }
    let turns = session.meta["turns"].as_array().cloned().unwrap_or_default();
    let previous: Vec<PathBuf> = turns.iter().rev().filter_map(|t| t.get("traj").and_then(Value::as_str)).map(PathBuf::from).collect();
    let turn_index = turns.len();
    let traj = dir.join(format!("turn-{}.traj.json", turn_index + 1));
    session.meta["turns"].as_array_mut().unwrap().push(json!({"prompt": prompt.display, "task": prompt.task, "traj": traj.display().to_string(), "startedAt": now}));
    session.meta["updatedAt"] = json!(now);
    session.meta["cwd"] = json!(session.cwd);
    session.meta["model"] = json!(session.model);
    store::save(sid, &session.meta).map_err(|e| format!("cannot save session: {e}"))?;
    Ok(TurnSetup { cwd: session.cwd.clone(), model: session.model.clone(), mcp: session.mcp.clone(), traj, previous, turn_index, first: turn_index == 0 })
}

fn finish(server: &Server, sid: &str, index: usize, start: Option<usize>, outcome: &Result<String, String>) {
    let mut sessions = server.sessions.lock().unwrap();
    let Some(session) = sessions.get_mut(sid) else { return };
    let now = crate::util::now_iso();
    if let Some(turn) = session.meta["turns"].get_mut(index) {
        if let Some(start) = start {
            turn["start"] = json!(start);
        }
        turn["stopReason"] = json!(match outcome {
            Ok(r) => r.as_str(),
            Err(_) => "error",
        });
    }
    session.meta["updatedAt"] = json!(now);
    session.meta["model"] = json!(session.model);
    let _ = store::save(sid, &session.meta);
}

/// Copies of this task the agent collapses when resuming (see `drop_pending_task_copies`): the
/// turn's first message can sit that many places before the end of the resumed history.
fn copies_of(task: &str, history: &[Value]) -> usize {
    let task = task.trim();
    let follow_up = format!("The user added a new task: {task}");
    history.iter().filter(|m| {
        let text = super::events::content_text(m.get("content"));
        m.get("role").and_then(Value::as_str) == Some("user") && (text.trim() == task || text == follow_up || text.contains(task))
    }).count()
}

fn run_one(server: &Arc<Server>, sid: &str, handle: &Arc<Handle>, prompt: &Prompt) -> Result<String, String> {
    let setup = setup(server, sid, prompt)?;
    let dir = store::dir(sid);
    if setup.first {
        let title = fallback_title(&prompt.display);
        if !title.is_empty() {
            server.out.update(sid, json!({"sessionUpdate": "session_info_update", "title": title}));
        }
    }

    // The conversation so far: the newest turn that left one.
    let mut resume: Option<PathBuf> = None;
    let mut history: Vec<Value> = Vec::new();
    for traj in &setup.previous {
        let (msgs, exported) = store::turn_conversation(traj);
        if msgs.is_empty() {
            continue;
        }
        resume = Some(if exported {
            traj.clone()
        } else {
            let file = dir.join(format!("resume-{}.json", setup.turn_index + 1));
            std::fs::write(&file, json!({"messages": msgs}).to_string()).map_err(|e| format!("{}: {e}", file.display()))?;
            file
        });
        history = msgs;
        break;
    }
    // The agent drops the resumed `exit` messages and collapses unanswered copies of this task.
    history.retain(|m| m.get("role").and_then(Value::as_str) != Some("exit"));
    let threshold = history.len().saturating_sub(copies_of(&prompt.task, &history));

    let task_file = dir.join("task.txt");
    std::fs::write(&task_file, &prompt.task).map_err(|e| format!("{}: {e}", task_file.display()))?;
    std::fs::write(&handle.control, "").map_err(|e| format!("{}: {e}", handle.control.display()))?;
    if handle.cancelled() {
        finish(server, sid, setup.turn_index, None, &Ok("cancelled".into()));
        return Ok("cancelled".into());
    }
    if !Path::new(&setup.cwd).is_dir() {
        let outcome = Err(format!("working directory does not exist: {}", setup.cwd));
        finish(server, sid, setup.turn_index, None, &outcome);
        return outcome;
    }

    let env = runenv::run_env(&runenv::RunSpec {
        session_id: sid,
        model: &setup.model,
        control: &handle.control,
        trajectories: &setup.previous,
        acp_mcp: &setup.mcp,
    });
    let log_path = setup.traj.with_extension("log");
    let log = std::fs::File::create(&log_path).map_err(|e| format!("{}: {e}", log_path.display()))?;
    let mut cmd = Command::new(&server.exe);
    cmd.args(["-y", "--exit-immediately", "-o"]).arg(&setup.traj);
    if let Some(r) = &resume {
        cmd.arg("--resume").arg(r);
    }
    if !setup.model.is_empty() {
        cmd.args(["-m", &setup.model]);
    }
    cmd.arg("-t").arg(format!("@{}", task_file.display()));
    cmd.current_dir(&setup.cwd)
        .envs(env.iter().cloned())
        .stdin(Stdio::null())
        .stdout(log.try_clone().map_err(|e| e.to_string())?)
        .stderr(log)
        .process_group(0);
    unsafe {
        // The agent dies with this server even when the server is SIGKILLed.
        cmd.pre_exec(|| {
            libc::prctl(libc::PR_SET_PDEATHSIG, libc::SIGTERM);
            Ok(())
        });
    }
    let mut child = cmd.spawn().map_err(|e| format!("cannot start {}: {e}", server.exe.display()))?;
    let pid = child.id() as i32;
    register(pid);
    handle.pid.store(pid, Ordering::SeqCst);
    if handle.cancelled() {
        unsafe { libc::kill(pid, libc::SIGINT) };
    }
    if setup.first && std::env::var("MINI_AGENT_ACP_TITLES").as_deref() != Ok("0") {
        spawn_title(server.clone(), sid.to_string(), prompt.task.clone(), setup.model.clone(), env.clone(), setup.cwd.clone());
    }

    let journal = store::journal_of(&setup.traj);
    let mut tail = Tail::new(journal, setup.cwd.clone(), setup.model.clone(), threshold, prompt.task.clone());
    let status = loop {
        let model = handle.model.lock().unwrap().clone();
        tail.mapper.set_model(&model);
        for update in tail.poll() {
            server.out.update(sid, update);
        }
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => std::thread::sleep(POLL),
            Err(_) => break None,
        }
    };
    for update in tail.poll() {
        server.out.update(sid, update);
    }
    unregister(pid);

    let outcome = if handle.cancelled() {
        Ok("cancelled".to_string())
    } else {
        match tail.mapper.exit_status.as_deref() {
            Some("Submitted") => Ok("end_turn".to_string()),
            Some("LimitsExceeded" | "TimeExceeded") => Ok("max_turn_requests".to_string()),
            _ if status.is_some_and(|s| s.success()) => {
                if let Some(other) = tail.mapper.exit_status.as_deref() {
                    if !tail.mapper.emitted_text {
                        server.out.update(sid, json!({"sessionUpdate": "agent_message_chunk", "content": {"type": "text", "text": format!("The agent stopped: {other}")}}));
                    }
                }
                Ok("end_turn".to_string())
            }
            _ => Err(failure(&log_path, status)),
        }
    };
    finish(server, sid, setup.turn_index, tail.start, &outcome);
    outcome
}

/// The last meaningful line the agent wrote, for a turn that failed.
fn failure(log: &Path, status: Option<std::process::ExitStatus>) -> String {
    let text = std::fs::read(log).ok().map(|b| {
        let from = b.len().saturating_sub(8192);
        String::from_utf8_lossy(&b[from..]).into_owned()
    }).unwrap_or_default();
    let line = text.lines().rev().map(str::trim).find(|l| !l.is_empty() && !l.starts_with("[turn]") && !l.starts_with("[mcp]"));
    let code = match status {
        Some(s) => s.code().map(|c| format!("exit code {c}")).unwrap_or_else(|| "killed by a signal".into()),
        None => "unknown exit".into(),
    };
    match line {
        Some(l) => format!("mini-agent failed ({code}): {}", l.chars().take(500).collect::<String>()),
        None => format!("mini-agent failed ({code})"),
    }
}

/// `mini-agent-rs title <task> <model>` in the background; the title reaches the client as a
/// `session_info_update` when it is ready.
fn spawn_title(server: Arc<Server>, sid: String, task: String, model: String, env: Vec<(String, String)>, cwd: String) {
    std::thread::spawn(move || {
        let task: String = task.chars().take(2000).collect();
        let Ok(mut child) = Command::new(&server.exe)
            .arg("title").arg(&task).arg(&model)
            .current_dir(&cwd)
            .envs(env)
            .stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null())
            .spawn() else { return };
        let started = Instant::now();
        loop {
            match child.try_wait() {
                Ok(Some(_)) => break,
                Ok(None) if started.elapsed() < TITLE_TIMEOUT => std::thread::sleep(Duration::from_millis(100)),
                _ => {
                    let _ = child.kill();
                    let _ = child.wait();
                    return;
                }
            }
        }
        let mut out = String::new();
        let _ = child.stdout.take().map(|mut s| s.read_to_string(&mut out));
        let Some(title) = serde_json::from_str::<Value>(out.trim()).ok().and_then(|v| v.as_str().map(|s| s.trim().to_string())).filter(|t| !t.is_empty()) else { return };
        {
            let mut sessions = server.sessions.lock().unwrap();
            let Some(session) = sessions.get_mut(&sid) else { return };
            session.meta["title"] = json!(title);
            let _ = store::save(&sid, &session.meta);
        }
        server.out.update(&sid, json!({"sessionUpdate": "session_info_update", "title": title}));
    });
}

/// Incremental reader of a turn's journal.
struct Tail {
    path: PathBuf,
    offset: u64,
    partial: Vec<u8>,
    /// Index of the next `msg` record in the current journal generation.
    index: usize,
    /// Highest message index already handled (a rewritten journal repeats them).
    handled: Option<usize>,
    threshold: usize,
    task: String,
    pub start: Option<usize>,
    pub mapper: Mapper,
}

impl Tail {
    fn new(path: PathBuf, cwd: String, model: String, threshold: usize, task: String) -> Self {
        Tail { path, offset: 0, partial: Vec::new(), index: 0, handled: None, threshold, task, start: None, mapper: Mapper::new(&cwd, &model, false) }
    }

    fn poll(&mut self) -> Vec<Value> {
        let Ok(mut f) = std::fs::File::open(&self.path) else { return vec![] };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            // Truncated: the agent started the journal over.
            self.offset = 0;
            self.partial.clear();
        }
        if len == self.offset || f.seek(SeekFrom::Start(self.offset)).is_err() {
            return vec![];
        }
        let mut bytes = Vec::new();
        if f.read_to_end(&mut bytes).is_err() {
            return vec![];
        }
        self.offset += bytes.len() as u64;
        self.partial.extend_from_slice(&bytes);
        let Some(last_nl) = self.partial.iter().rposition(|b| *b == b'\n') else { return vec![] };
        let complete: Vec<u8> = self.partial.drain(..=last_nl).collect();
        let mut out = Vec::new();
        for line in complete.split(|b| *b == b'\n') {
            let Ok(rec) = serde_json::from_slice::<Value>(line) else { continue };
            out.extend(self.record(&rec));
        }
        out
    }

    fn record(&mut self, rec: &Value) -> Vec<Value> {
        match rec.get("t").and_then(Value::as_str) {
            Some("meta") => {
                self.index = 0;
                vec![]
            }
            Some("msg") => {
                let i = self.index;
                self.index += 1;
                if self.handled.is_some_and(|h| i <= h) {
                    return vec![];
                }
                self.handled = Some(i);
                let Some(start) = self.start else {
                    let m = rec.get("m").cloned().unwrap_or(Value::Null);
                    if i >= self.threshold && store::turn_start(std::slice::from_ref(&m), &self.task, 0).is_some() {
                        self.start = Some(i + 1);
                    }
                    return vec![];
                };
                if i < start {
                    return vec![];
                }
                self.mapper.record(rec)
            }
            // Fragments and totals before the turn's own messages belong to nothing shown.
            _ if self.start.is_none() => vec![],
            _ => self.mapper.record(rec),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn prompt_blocks_become_task_text_and_attachments() {
        let dir = std::env::temp_dir().join(format!("acp-turn-test-{}", std::process::id()));
        let png = base64::engine::general_purpose::STANDARD.encode([0x89u8, b'P', b'N', b'G']);
        let blocks = vec![
            json!({"type": "text", "text": "Look at this"}),
            json!({"type": "image", "mimeType": "image/png", "data": png}),
            json!({"type": "resource_link", "uri": "file:///repo/My%20File.rs", "name": "My File.rs", "mimeType": "text/x-rust"}),
            json!({"type": "resource", "resource": {"uri": "file:///repo/b.txt", "text": "inline"}}),
        ];
        let (task, display) = prompt_text(&blocks, &dir);
        assert!(task.starts_with("Look at this\n\n<resource uri=\"file:///repo/b.txt\">\ninline\n</resource>\n\n<attachments>\n"));
        assert!(task.contains("- My File.rs — text/x-rust — at /repo/My File.rs"));
        let saved = task.lines().find(|l| l.contains("image/png")).unwrap();
        let path = saved.rsplit("saved at ").next().unwrap();
        assert_eq!(std::fs::read(path).unwrap(), vec![0x89u8, b'P', b'N', b'G']);
        assert!(display.ends_with("[attached: image, My File.rs]"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn tail_skips_resumed_history_and_handles_partial_lines() {
        let dir = std::env::temp_dir().join(format!("acp-tail-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("t.traj.jsonl");
        let line = |v: Value| format!("{}\n", v);
        let history = [
            json!({"t": "meta"}),
            json!({"t": "msg", "m": {"role": "system", "content": "s"}}),
            json!({"t": "msg", "m": {"role": "user", "content": "Please solve this issue: first"}}),
            json!({"t": "msg", "m": {"role": "assistant", "content": "old answer"}}),
            json!({"t": "msg", "m": {"role": "user", "content": "The user added a new task: second", "extra": {"interrupt_type": "UserNewTask"}}}),
        ];
        let mut text: String = history.iter().map(|v| line(v.clone())).collect();
        let reply = line(json!({"t": "msg", "m": {"role": "assistant", "content": "new answer"}}));
        let (head, rest) = reply.split_at(10);
        text.push_str(head);
        std::fs::write(&path, &text).unwrap();
        let mut tail = Tail::new(path.clone(), "/r".into(), "m".into(), 3, "second".into());
        assert!(tail.poll().is_empty());
        assert_eq!(tail.start, Some(4));
        std::fs::OpenOptions::new().append(true).open(&path).unwrap().write_all(rest.as_bytes()).unwrap();
        let out = tail.poll();
        assert_eq!(out.len(), 1);
        assert_eq!(out[0]["content"]["text"], json!("new answer"));
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn file_uris_decode() {
        assert_eq!(file_path("file:///a/b%20c.txt").as_deref(), Some("/a/b c.txt"));
        assert_eq!(file_path("file://localhost/x").as_deref(), Some("/x"));
        assert_eq!(file_path("https://x"), None);
        assert_eq!(file_path("file:///odd%2").as_deref(), Some("/odd%2"));
    }

    #[test]
    fn unread_follow_ups_are_taken_from_the_control_file() {
        let dir = std::env::temp_dir().join(format!("acp-control-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let control = dir.join("control");
        std::fs::write(&control, "MODEL x\nMESSAGE \"one\"\nMESSAGE \"two\\nlines\"\n").unwrap();
        assert_eq!(unread_messages(&control), vec!["one".to_string(), "two\nlines".to_string()]);
        assert_eq!(std::fs::read_to_string(&control).unwrap(), "");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
