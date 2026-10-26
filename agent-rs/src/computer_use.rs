//! The `computer_use` tool: real browser actions through the `cu` CLI with a
//! REUSABLE daemon pool (v4-F).
//!
//! The bare `cu` tool shells out and resolves whatever daemon the CWD points
//! at — every headless turn would risk spawning another Chrome and never
//! reclaiming it. This tool owns one pool instead:
//!
//! * **one daemon, reused** — the registry (a small JSON file under a flock)
//!   remembers the live daemon's port, CDP port, data dir, pid and the tab
//!   the conversation is driving. A live entry is reused as-is, across agent
//!   processes and turns (the consumer runs one fresh process per turn, so
//!   the registry — not process memory — is the pool).
//! * **no stray ports** — before spawning, candidate ports are checked
//!   against `ss -tln` AND the registry; the daemon is spawned in its own
//!   session (`setsid`) so it outlives the turn that started it.
//! * **idle teardown** — every call first sweeps entries idle for more than
//!   `MINITUI_CU_IDLE_SECS` (default 900 s): the daemon is terminated and its
//!   data dir removed, so no chromes hang around after work stops.
//! * **bounded blast radius** — `navigate` accepts only localhost (or hosts
//!   explicitly allow-listed via `MINITUI_CU_ALLOW`, the sites Jaime asks for
//!   in prod); snapshots and page text are capped; screenshots attach to the
//!   observation as native images (the same `image_url` shape the `read`
//!   tool uses) instead of returning a file path. Never type credentials.

use base64::{engine::general_purpose::STANDARD, Engine};
use serde_json::{json, Value};
use std::collections::BTreeSet;
use std::io::{Read, Write};
use std::net::TcpStream;
use std::os::fd::AsRawFd;
use std::os::unix::process::CommandExt;
use std::path::PathBuf;
use std::time::{Duration, Instant, SystemTime};

/// Explicit opt-in: the pool spawns processes and browsers, so the tool only
/// exists when the operator set `MINITUI_COMPUTER_USE=1` — independent of the
/// native agent tools gate, so enabling the browser never widens anything else.
pub fn enabled() -> bool {
    std::env::var("MINITUI_COMPUTER_USE").map(|v| v == "1").unwrap_or(false)
}

const IDLE_SECS_DEFAULT: u64 = 900;
const COMMAND_TIMEOUT_MS: u64 = 60_000;
const START_TIMEOUT_MS: u64 = 30_000;
/// Snapshots and page text are capped: a runaway page must not eat the run's
/// context (the same idea as the read tool's byte budget).
const OUTPUT_MAX_BYTES: usize = 30 * 1024;
const IMAGE_MAX_BYTES: u64 = 8 * 1024 * 1024;

/// `MINITUI_CU_BIN`, else `~/.local/bin/cu` (a wrapper with its own glibc: the one that loads
/// inside the Docker image too), else `~/.cargo/bin/cu`, else `cu` on PATH.
pub(crate) fn cu_bin() -> PathBuf {
    if let Ok(p) = std::env::var("MINITUI_CU_BIN").map(PathBuf::from) {
        return p;
    }
    let home = crate::config::home();
    for p in [home.join(".local/bin/cu"), home.join(".cargo/bin/cu")] {
        if p.exists() {
            return p;
        }
    }
    PathBuf::from("cu")
}

fn idle_secs() -> u64 {
    std::env::var("MINITUI_CU_IDLE_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(IDLE_SECS_DEFAULT)
}

fn pool_dir() -> PathBuf {
    std::env::var("MINITUI_CU_POOL_DIR")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::config::home().join(".local/share/mini-tui/cu-pool"))
}

fn now_secs() -> u64 {
    SystemTime::now().duration_since(SystemTime::UNIX_EPOCH).map(|d| d.as_secs()).unwrap_or(0)
}

// ---- the registry (one JSON file under a flock) --------------------------------

#[derive(Clone, Default)]
struct Entry {
    port: u16,
    cdp: u16,
    data_dir: String,
    pid: u32,
    tab: String,
    last_used: u64,
}

/// Run `f` holding an exclusive flock on the pool's lock file. The lock is
/// what makes "reuse vs spawn" safe across the concurrent consumer turns.
fn with_registry<T>(f: impl FnOnce(&mut Vec<Entry>) -> T) -> Result<T, String> {
    let dir = pool_dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("pool dir: {e}"))?;
    let lock_path = dir.join("registry.lock");
    let lock = std::fs::OpenOptions::new().create(true).truncate(false).write(true).open(&lock_path).map_err(|e| format!("pool lock: {e}"))?;
    let rc = unsafe { libc::flock(lock.as_raw_fd(), libc::LOCK_EX) };
    if rc != 0 {
        return Err("pool lock: flock failed".into());
    }
    let path = dir.join("registry.json");
    let mut entries: Vec<Entry> = std::fs::read(&path)
        .ok()
        .and_then(|raw| serde_json::from_slice::<Vec<Value>>(&raw).ok())
        .map(|items| {
            items
                .into_iter()
                .map(|v| Entry {
                    port: v.get("port").and_then(Value::as_u64).unwrap_or(0) as u16,
                    cdp: v.get("cdp").and_then(Value::as_u64).unwrap_or(0) as u16,
                    data_dir: v.get("data_dir").and_then(Value::as_str).unwrap_or_default().to_string(),
                    pid: v.get("pid").and_then(Value::as_u64).unwrap_or(0) as u32,
                    tab: v.get("tab").and_then(Value::as_str).unwrap_or_default().to_string(),
                    last_used: v.get("last_used").and_then(Value::as_u64).unwrap_or(0),
                })
                .collect()
        })
        .unwrap_or_default();
    let out = f(&mut entries);
    let items: Vec<Value> = entries
        .iter()
        .map(|e| json!({"port": e.port, "cdp": e.cdp, "data_dir": e.data_dir, "pid": e.pid, "tab": e.tab, "last_used": e.last_used}))
        .collect();
    let mut file = std::fs::File::create(&path).map_err(|e| format!("pool registry: {e}"))?;
    file.write_all(&serde_json::to_vec(&items).unwrap_or_default()).map_err(|e| format!("pool registry: {e}"))?;
    drop(lock); // flock released
    Ok(out)
}

// ---- liveness / ports -----------------------------------------------------------

fn pid_alive(pid: u32) -> bool {
    if pid == 0 {
        return false;
    }
    // kill -0: signal 0 checks existence only.
    unsafe { libc::kill(pid as i32, 0) == 0 }
}

fn port_listening(port: u16) -> bool {
    TcpStream::connect_timeout(&std::net::SocketAddr::from(([127, 0, 0, 1], port)), Duration::from_millis(300)).is_ok()
}

fn alive(entry: &Entry) -> bool {
    entry.port != 0 && pid_alive(entry.pid) && port_listening(entry.port)
}

/// Ports actually LISTENING right now, parsed from `ss -tln` — the bind check
/// the task demands before starting a daemon (never trust the registry alone).
fn ss_listening() -> BTreeSet<u16> {
    let mut out = BTreeSet::new();
    if let Ok(o) = std::process::Command::new("ss").arg("-tln").output() {
        for line in String::from_utf8_lossy(&o.stdout).lines() {
            // State Recv-Q Send-Q Local-Address:Port ...; v6 hosts end in ]:port.
            let local = line.split_whitespace().nth(3).unwrap_or("");
            if let Some(port) = local.rsplit(':').next().and_then(|p| p.parse::<u16>().ok()) {
                out.insert(port);
            }
        }
    }
    out
}

fn free_port(listening: &BTreeSet<u16>, taken: &[u16], mut range: std::ops::Range<u16>) -> Option<u16> {
    range.find(|p| !listening.contains(p) && !taken.contains(p))
}

// ---- daemon lifecycle ------------------------------------------------------------

fn teardown(entry: &Entry) {
    if entry.pid != 0 {
        // TERM the process group (setsid made the daemon its own leader), then
        // KILL after a beat so the chrome tree cannot outlive the entry.
        unsafe {
            libc::kill(-(entry.pid as i32), libc::SIGTERM);
        }
        std::thread::sleep(Duration::from_millis(800));
        unsafe {
            libc::kill(-(entry.pid as i32), libc::SIGKILL);
        }
    }
    let _ = std::fs::remove_dir_all(&entry.data_dir);
}

/// The current entry: reuse a live one or start exactly one new daemon.
fn acquire() -> Result<Entry, String> {
    with_registry(|entries| acquire_inner(entries)).and_then(|r| r)
}

fn acquire_inner(entries: &mut Vec<Entry>) -> Result<Entry, String> {
    // Idle teardown first: a sweep is the only reaper this pool needs.
    let cutoff = now_secs().saturating_sub(idle_secs());
    // Stale screenshots too (shot files live in the pool root so the chat
    // channel can read them even after this process exits).
    if let Ok(entries) = std::fs::read_dir(pool_dir()) {
        for item in entries.flatten() {
            let name = item.file_name().to_string_lossy().into_owned();
            if name.starts_with("shot-") && name.ends_with(".png") {
                if let Ok(meta) = item.metadata() {
                    if let Ok(modified) = meta.modified() {
                        if modified.elapsed().map(|e| e.as_secs() > idle_secs()).unwrap_or(false) {
                            let _ = std::fs::remove_file(item.path());
                        }
                    }
                }
            }
        }
    }
    let stale: Vec<Entry> = entries.iter().filter(|e| e.last_used < cutoff).cloned().collect();
    for e in &stale {
        teardown(e);
    }
    entries.retain(|e| !stale.iter().any(|s| s.port == e.port));
    if let Some(e) = entries.iter_mut().find(|e| alive(e)) {
        e.last_used = now_secs();
        return Ok(e.clone());
    }
    // Nothing live: drop dead entries and start one new daemon.
    let dead: Vec<Entry> = entries.iter().filter(|e| !alive(e)).cloned().collect();
    for e in &dead {
        teardown(e);
    }
    entries.retain(|e| !dead.iter().any(|d| d.port == e.port));
    let listening = ss_listening();
    let taken: Vec<u16> = entries.iter().map(|e| e.port).chain(entries.iter().map(|e| e.cdp)).collect();
    let port = free_port(&listening, &taken, 4720..4820).ok_or("no free cu port in 4720..4820")?;
    let cdp = free_port(&listening, &taken, 9320..9420).ok_or("no free CDP port in 9320..9420")?;
    let dir = pool_dir();
    let data_dir = dir.join(format!("d-{port}"));
    std::fs::create_dir_all(&data_dir).map_err(|e| format!("data dir: {e}"))?;
    let log = std::fs::File::create(data_dir.join("cu-start.log")).map_err(|e| format!("daemon log: {e}"))?;
    let log_err = log.try_clone().map_err(|e| format!("daemon log: {e}"))?;
    let mut cmd = std::process::Command::new(cu_bin());
    cmd.args(["start", "--port", &port.to_string(), "--data"]).arg(&data_dir).env("CU_CDP_PORT", cdp.to_string()).env("CU_BROWSER", "google-chrome").stdout(log).stderr(log_err);
    // Own session: the daemon outlives this (short-lived) turn process and
    // never receives its signals.
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = cmd.spawn().map_err(|e| format!("cu start: {e}"))?;
    let pid = child.id();
    let deadline = Instant::now() + Duration::from_millis(START_TIMEOUT_MS);
    while Instant::now() < deadline {
        if port_listening(port) {
            let entry = Entry { port, cdp, data_dir: data_dir.to_string_lossy().into_owned(), pid, tab: String::new(), last_used: now_secs() };
            entries.push(entry.clone());
            return Ok(entry);
        }
        if !pid_alive(pid) {
            break;
        }
        std::thread::sleep(Duration::from_millis(400));
    }
    teardown(&Entry { port, cdp, data_dir: data_dir.to_string_lossy().into_owned(), pid, tab: String::new(), last_used: 0 });
    Err("cu daemon did not become ready in 30s (see cu-start.log in the pool dir)".into())
}

fn touch(entry: &Entry) {
    let _ = with_registry::<()>(|entries| {
        if let Some(e) = entries.iter_mut().find(|e| e.port == entry.port) {
            e.last_used = now_secs();
            e.tab = entry.tab.clone();
        }
    });
}

// ---- running cu commands ----------------------------------------------------------

/// One `cu` invocation inside the entry's data dir (the CLI resolves the
/// daemon through `server.json` there). Bounded capture, wall-clock timeout:
/// a hung page must not hang the agent turn forever.
fn run_cu(entry: &Entry, args: &[String]) -> Result<(i32, String, String), String> {
    let mut cmd = std::process::Command::new(cu_bin());
    cmd.args(args).current_dir(&entry.data_dir).stdin(std::process::Stdio::null());
    let mut child = cmd.stdout(std::process::Stdio::piped()).stderr(std::process::Stdio::piped()).spawn().map_err(|e| format!("cu {}: {e}", args0(args)))?;
    let deadline = Instant::now() + Duration::from_millis(COMMAND_TIMEOUT_MS);
    loop {
        match child.try_wait().map_err(|e| format!("cu: {e}"))? {
            Some(status) => {
                let mut out = Vec::new();
                let mut err = Vec::new();
                if let Some(mut s) = child.stdout.take() {
                    let _ = s.read_to_end(&mut out);
                }
                if let Some(mut s) = child.stderr.take() {
                    let _ = s.read_to_end(&mut err);
                }
                let code = status.code().unwrap_or(-1);
                return Ok((code, cap(String::from_utf8_lossy(&out).into_owned()), String::from_utf8_lossy(&err).into_owned()));
            }
            None if Instant::now() > deadline => {
                let _ = child.kill();
                return Err("cu command timed out after 60s".into());
            }
            None => std::thread::sleep(Duration::from_millis(150)),
        }
    }
}

fn args0(args: &[String]) -> String {
    args.first().map(String::as_str).unwrap_or("").to_string()
}

fn cap(text: String) -> String {
    if text.len() <= OUTPUT_MAX_BYTES {
        return text;
    }
    let mut cut = OUTPUT_MAX_BYTES;
    while !text.is_char_boundary(cut) {
        cut -= 1;
    }
    format!("{}\n\n[{} truncated: output over the {}B tool cap]", &text[..cut], text.len() - cut, OUTPUT_MAX_BYTES)
}

// ---- security ---------------------------------------------------------------------

/// The hosts a navigate may target: loopback always, plus exactly the hosts
/// the operator allow-lists (`MINITUI_CU_ALLOW=host1,host2` — the sites Jaime
/// asks for in prod). Everything else is refused, honestly, with the rule.
fn navigate_allowed(url: &str) -> Result<(), String> {
    let lower = url.trim().to_lowercase();
    if !(lower.starts_with("http://") || lower.starts_with("https://")) {
        return Err(format!("navigate refuses '{url}': only http(s) URLs are allowed"));
    }
    let host = match url::host_of(url) {
        Some(h) => h,
        None => return Err(format!("navigate refuses '{url}': no host")),
    };
    let loopback = matches!(host.as_str(), "localhost" | "127.0.0.1" | "::1") || host.ends_with(".localhost");
    if loopback {
        return Ok(());
    }
    let allow = std::env::var("MINITUI_CU_ALLOW").unwrap_or_default();
    let allowed: Vec<String> = allow.split(',').map(|s| s.trim().to_lowercase()).filter(|s| !s.is_empty()).collect();
    if allowed.iter().any(|a| a == &host) {
        return Ok(());
    }
    Err(format!(
        "navigate refuses '{host}': only localhost is allowed unless the host is in MINITUI_CU_ALLOW (operator-configured)"
    ))
}

/// Minimal URL host extraction (no url crate): after the scheme, up to the
/// path/query/fragment, minus userinfo and the port.
mod url {
    pub fn host_of(url: &str) -> Option<String> {
        let rest = url.split("://").nth(1)?;
        let authority = rest.split(['/', '?', '#']).next()?;
        let authority = authority.rsplit('@').next()?;
        let host = if let Some(rest) = authority.strip_prefix('[') { rest.split(']').next()? } else { authority.split(':').next()? };
        if host.is_empty() { None } else { Some(host.to_lowercase()) }
    }
}

// ---- the tool surface --------------------------------------------------------------

pub const COMPUTER_USE_DESCRIPTION: &str = "Drive a real (headless) browser through the managed cu daemon pool: navigate/snapshot/click/type/shot, one shared reusable daemon (a second call reuses it; idle daemons are torn down after 15 minutes). Screenshots attach to the result as native images. navigate accepts only localhost URLs unless the host is in MINITUI_CU_ALLOW. Security: never enter credentials, never submit logins, nothing beyond the pages needed for the task.";

fn params() -> Value {
    json!({
        "type": "object",
        "properties": {
            "action": {"type": "string", "enum": ["navigate", "snapshot", "click", "type", "shot"], "description": "The browser action to run"},
            "url": {"type": "string", "description": "navigate: the http(s) URL to open (localhost by default)"},
            "ref": {"type": "string", "description": "click/type: the element ref from the last snapshot (e.g. e7)"},
            "text": {"type": "string", "description": "type: the text to type"},
            "submit": {"type": "boolean", "description": "type: press Enter afterwards"}
        },
        "required": ["action"]
    })
}

pub fn computer_use_tool_chat() -> Value {
    json!({"type": "function", "function": {"name": "computer_use", "description": COMPUTER_USE_DESCRIPTION, "parameters": params()}})
}
pub fn computer_use_tool_responses() -> Value {
    json!({"type": "function", "name": "computer_use", "description": COMPUTER_USE_DESCRIPTION, "parameters": params()})
}
pub fn computer_use_tool_anthropic() -> Value {
    json!({"name": "computer_use", "description": COMPUTER_USE_DESCRIPTION, "input_schema": params()})
}

/// Append the tool to a protocol's tool list when the pool is enabled.
pub fn with_computer_use(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if enabled() {
        out.push(computer_use_tool_chat());
    }
    out
}
pub fn with_computer_use_anthropic(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if enabled() {
        out.push(computer_use_tool_anthropic());
    }
    out
}
pub fn with_computer_use_responses(base: Vec<Value>) -> Vec<Value> {
    let mut out = base;
    if enabled() {
        out.push(computer_use_tool_responses());
    }
    out
}

fn fail(msg: String) -> Value {
    json!({"output": msg, "returncode": 1, "exception_info": msg})
}

/// The observation for one parsed `computer_use` call. The pool entry is
/// acquired (or reused) per call and its last_used/tab are persisted, so a
/// later turn in the SAME conversation resumes the SAME daemon and tab.
pub fn outcome(args: &Value) -> Value {
    if !enabled() {
        return fail("computer_use is not enabled (MINITUI_COMPUTER_USE=1 is required).".into());
    }
    let action = crate::util::get_str(args, "action").unwrap_or("").trim().to_string();
    let entry = match acquire() {
        Ok(e) => e,
        Err(e) => return fail(e),
    };
    let mut entry = entry;
    let run = |entry: &Entry, extra: Vec<String>| run_cu(entry, &[vec![action.clone()], extra].concat());
    let result = match action.as_str() {
        "navigate" => {
            let url = crate::util::get_str(args, "url").unwrap_or("").trim().to_string();
            if url.is_empty() {
                return fail("navigate: missing required argument 'url'".into());
            }
            if let Err(e) = navigate_allowed(&url) {
                return fail(e);
            }
            let mut extra: Vec<String> = vec![url.clone()];
            if !entry.tab.is_empty() {
                extra.push("--tab".into());
                extra.push(entry.tab.clone());
            }
            let (code, out, err) = match run(&entry, extra) {
                Ok(r) => r,
                Err(e) => return fail(e),
            };
            // The tab id lands on stderr ("working in a fresh tab (HEX)") the
            // first time; keep it so later actions drive the same tab.
            if entry.tab.is_empty() {
                if let Some(id) = tab_id_from(&err).or_else(|| tab_id_from(&out)) {
                    entry.tab = id;
                }
            }
            touch(&entry);
            let output = cap(format!("{out}\n{err}").trim().to_string());
            json!({"output": if output.trim().is_empty() { "(navigated)".to_string() } else { output }, "returncode": if code == 0 { 0 } else { 1 }, "exception_info": if code == 0 { "".into() } else { cap(err.clone()) }, "extra": {"action": "navigate", "tab": entry.tab, "url": url}})
        }
        "snapshot" => {
            if entry.tab.is_empty() {
                return fail("snapshot: no tab open yet — navigate first".into());
            }
            let (code, out, err) = match run(&entry, vec!["--tab".into(), entry.tab.clone()]) {
                Ok(r) => r,
                Err(e) => return fail(e),
            };
            touch(&entry);
            json!({"output": if out.trim().is_empty() { format!("(empty snapshot){err}") } else { out }, "returncode": if code == 0 { 0 } else { 1 }, "exception_info": if code == 0 { "".into() } else { cap(err) }, "extra": {"action": "snapshot", "tab": entry.tab}})
        }
        "click" | "type" => {
            let reference = crate::util::get_str(args, "ref").unwrap_or("").trim().to_string();
            if reference.is_empty() {
                return fail(format!("{action}: missing required argument 'ref' (take a snapshot first)"));
            }
            if entry.tab.is_empty() {
                return fail(format!("{action}: no tab open yet — navigate first"));
            }
            let mut extra = vec![reference.clone(), "--tab".into(), entry.tab.clone()];
            if action == "type" {
                let text = crate::util::get_str(args, "text").unwrap_or("");
                extra.insert(1, text.to_string());
                if args.get("submit").and_then(Value::as_bool).unwrap_or(false) {
                    extra.push("--submit".into());
                }
            }
            let (code, out, err) = match run(&entry, extra) {
                Ok(r) => r,
                Err(e) => return fail(e),
            };
            touch(&entry);
            let mut output = cap(format!("{out}\n{err}").trim().to_string());
            if output.trim().is_empty() {
                output = format!("({action} done; take a snapshot to see the new page state)");
            }
            json!({"output": output, "returncode": if code == 0 { 0 } else { 1 }, "exception_info": if code == 0 { "".into() } else { cap(err) }, "extra": {"action": action, "tab": entry.tab, "ref": reference}})
        }
        "shot" => {
            if entry.tab.is_empty() {
                return fail("shot: no tab open yet — navigate first".into());
            }
            let file = pool_dir().join(format!("shot-{}-{}.png", entry.port, now_secs()));
            let (code, out, err) = match run(&entry, vec![file.to_string_lossy().into_owned(), "--png".into(), "--tab".into(), entry.tab.clone()]) {
                Ok(r) => r,
                Err(e) => return fail(e),
            };
            touch(&entry);
            if code != 0 {
                return fail(cap(format!("shot failed: {out}\n{err}").trim().to_string()));
            }
            match std::fs::read(&file) {
                Ok(raw) => {
                    let size = raw.len();
                    if size as u64 > IMAGE_MAX_BYTES {
                        return fail(format!("screenshot is {} and over the 8MB cap", format_bytes(size)));
                    }
                    let data_url = format!("data:image/png;base64,{}", STANDARD.encode(&raw));
                    let file_path = file.to_string_lossy().into_owned();
                    // The file STAYS in the pool dir (8MB cap, swept with the
                    // daemon) so the chat channel can deliver it as media: the
                    // model shares it by ending its reply with the marker.
                    json!({"output": format!("Screenshot captured ({size} bytes): {file_path}\nVisual content is attached below (do not infer pixels from this text). To send this image in the chat, end the reply with exactly [[mini-image: {file_path}]] on its own last line."),
                        "returncode": 0, "exception_info": "", "image_url": data_url,
                        "extra": {"action": "shot", "tab": entry.tab, "path": file_path, "bytes": size, "visual_attachment": true}})
                }
                Err(e) => fail(format!("shot: cannot read the capture: {e}")),
            }
        }
        other => fail(format!("unknown computer_use action '{other}' (navigate|snapshot|click|type|shot)")),
    };
    result
}

/// The tab id `cu` names on stderr, whether the command opened a fresh tab or
/// continued in the page its session already had (a session's second command
/// reuses it): "working in a fresh tab (HEX)" / "working in tab (HEX)".
fn tab_id_from(text: &str) -> Option<String> {
    let marker = text.find("fresh tab (").or_else(|| text.find("working in tab ("))?;
    let open = text[marker..].find('(')? + 1;
    let rest = &text[marker + open..];
    let id: String = rest.chars().take_while(|c| c.is_ascii_hexdigit()).collect();
    if id.len() >= 8 { Some(id) } else { None }
}

fn format_bytes(bytes: usize) -> String {
    if bytes >= 1024 * 1024 { format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0)) } else { format!("{bytes}B") }
}

#[cfg(test)]
mod tests {
    #[test]
    fn navigate_allows_loopback_and_refuses_elsewhere() {
        use super::navigate_allowed;
        std::env::remove_var("MINITUI_CU_ALLOW");
        for url in ["http://127.0.0.1:4317/api/health", "https://localhost:3119/x", "http://[::1]:9/x", "http://panel.localhost/"] {
            assert!(navigate_allowed(url).is_ok(), "{url} should be allowed");
        }
        assert!(navigate_allowed("https://example.com").is_err());
        assert!(navigate_allowed("file:///etc/passwd").is_err());
        std::env::set_var("MINITUI_CU_ALLOW", "example.com, Foo.Example.ORG ");
        assert!(navigate_allowed("https://example.com/x").is_ok());
        assert!(navigate_allowed("https://foo.example.org").is_ok());
        assert!(navigate_allowed("https://evil-example.com").is_err());
        std::env::remove_var("MINITUI_CU_ALLOW");
    }

    #[test]
    fn host_of_extracts_host_without_port_or_userinfo() {
        use super::url::host_of;
        assert_eq!(host_of("http://127.0.0.1:4317/x").as_deref(), Some("127.0.0.1"));
        assert_eq!(host_of("https://user:pw@Example.COM:8443/a?b").as_deref(), Some("example.com"));
        assert_eq!(host_of("http://[::1]:9/x").as_deref(), Some("::1"));
        assert_eq!(host_of("http://"), None);
    }

    #[test]
    fn tab_id_parser_finds_the_fresh_tab_line() {
        use super::tab_id_from;
        assert_eq!(tab_id_from("cu: working in a fresh tab (E429869843314F4B9AE4DE8AE966F92B); collected").as_deref(), Some("E429869843314F4B9AE4DE8AE966F92B"));
        assert_eq!(tab_id_from("nothing here"), None);
    }

    #[test]
    fn tab_id_parser_finds_the_reused_tab_line() {
        use super::tab_id_from;
        // `cu` works in a session's own page from its second command on: the
        // id is named the same way, with a different sentence around it.
        assert_eq!(
            tab_id_from("cu: working in tab (E429869843314F4B9AE4DE8AE966F92B), the page this session already had; it is collected when the session exits").as_deref(),
            Some("E429869843314F4B9AE4DE8AE966F92B")
        );
        assert_eq!(tab_id_from("cu: could not open this session's tab (refused); working in the default page"), None);
    }

    /// La cascada REAL del pool contra el `cu` DESPLEGADO: la pestana que el
    /// pool tiene guardada se pierde (registro vaciado), y la `navigate` que
    /// sigue tiene que volver a descubrir el id por stderr. Con el parser que
    /// solo conocia "fresh tab (" el id se pierde y `snapshot` -- que exige
    /// `--tab` -- aborta con "no tab open yet" para el resto del turno.
    ///
    /// `MINITUI_CU_BIN` debe apuntar al binario desplegado. Ignorado por
    /// defecto (arranca un daemon real y Chrome).
    #[test]
    #[ignore]
    fn live_cascade_tab_lost() {
        use std::io::{BufRead, BufReader, Write};
        let work = std::env::temp_dir().join(format!("cu-cascade-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::env::set_var("MINITUI_COMPUTER_USE", "1");
        std::env::set_var("MINITUI_CU_POOL_DIR", &work);
        std::env::set_var("MINITUI_CU_IDLE_SECS", "600");
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut r = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = r.read_line(&mut line);
                let mut s = stream;
                let _ = s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 33\r\n\r\n<html><body><h1>CASCADE OK</h1></body></html>");
            }
        });
        let url = format!("http://127.0.0.1:{port}/");
        struct Guard(std::path::PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) {
                if let Ok(items) = serde_json::from_slice::<Vec<serde_json::Value>>(&std::fs::read(self.0.join("registry.json")).unwrap_or_default()) {
                    for item in items {
                        if let Some(pid) = item["pid"].as_u64() {
                            unsafe { libc::kill(-(pid as i32), libc::SIGKILL); }
                        }
                    }
                }
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let _guard = Guard(work.clone());

        let r1 = super::outcome(&serde_json::json!({"action": "navigate", "url": url}));
        assert_eq!(r1["returncode"], 0, "navigate failed: {r1}");
        let r2 = super::outcome(&serde_json::json!({"action": "snapshot"}));
        assert_eq!(r2["returncode"], 0, "snapshot before the loss failed: {r2}");

        // El registro pierde la pestana guardada: el daemon sigue vivo con la
        // pagina de la sesion, pero el pool ya no sabe cual es.
        let reg = work.join("registry.json");
        let mut items: Vec<serde_json::Value> =
            serde_json::from_slice(&std::fs::read(&reg).unwrap()).unwrap_or_default();
        for e in items.iter_mut() {
            e["tab"] = serde_json::Value::String(String::new());
        }
        std::fs::write(&reg, serde_json::to_vec(&items).unwrap()).unwrap();

        // Esta navigate recibe de stderr la linea de pestana REUTILIZADA.
        let r3 = super::outcome(&serde_json::json!({"action": "navigate", "url": format!("{url}otra")}));
        assert_eq!(r3["returncode"], 0, "navigate after the loss failed: {r3}");
        let tab = r3["extra"]["tab"].as_str().unwrap_or("");
        println!("tab recuperada tras perderla: {tab:?}");

        // El fallo real: sin id, snapshot aborta y el agente se queda sin pagina.
        let r4 = super::outcome(&serde_json::json!({"action": "snapshot"}));
        assert_eq!(r4["returncode"], 0, "CASCADE: el snapshot no recupero la pagina: {r4}");
        assert!(
            format!("{}", r4["output"]).contains("CASCADE OK"),
            "snapshot leyo otra pagina: {r4}"
        );
    }

    /// The REAL pool E2E (ignored by default — it spawns a real cu daemon and
    /// Chrome): navigate → snapshot → shot (native image) → reuse (same
    /// daemon, no second spawn) → external URL refused → idle teardown kills
    /// the daemon and removes its data dir. Run: `cargo test computer_use -- --ignored --nocapture`
    #[test]
    #[ignore]
    fn live_pool_e2e() {
        use std::io::{BufRead, BufReader};
        let work = std::env::temp_dir().join(format!("cu-pool-e2e-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&work);
        std::env::set_var("MINITUI_COMPUTER_USE", "1");
        std::env::set_var("MINITUI_CU_POOL_DIR", &work);
        std::env::set_var("MINITUI_CU_IDLE_SECS", "1");
        // One tiny HTTP page on an ephemeral loopback port.
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { break };
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut line = String::new();
                let _ = reader.read_line(&mut line);
                let mut s = stream;
                s.write_all(b"HTTP/1.1 200 OK\r\ncontent-type: text/html\r\ncontent-length: 45\r\n\r\n<html><body><h1>pool e2e OK</h1></body></html>").unwrap();
            }
        });
        let url = format!("http://127.0.0.1:{port}/");
        // A failing assertion must not leak the spawned daemon: the guard
        // reaps every registry entry (process group + data dir) on unwind.
        struct Guard(std::path::PathBuf);
        impl Drop for Guard {
            fn drop(&mut self) {
                if let Ok(items) = serde_json::from_slice::<Vec<serde_json::Value>>(&std::fs::read(self.0.join("registry.json")).unwrap_or_default()) {
                    for item in items {
                        if let Some(pid) = item["pid"].as_u64() {
                            unsafe {
                                libc::kill(-(pid as i32), libc::SIGKILL);
                            }
                        }
                    }
                }
                let _ = std::fs::remove_dir_all(&self.0);
            }
        }
        let guard = Guard(work.clone());
        use std::io::Write as IoWrite;
        use serde_json::Value as JsonValue;
        let registry = || -> Vec<JsonValue> {
            serde_json::from_slice::<Vec<JsonValue>>(&std::fs::read(work.join("registry.json")).unwrap_or_default()).unwrap_or_default()
        };
        // 1. navigate: spawns the daemon, opens the page, remembers the tab.
        let r1 = super::outcome(&serde_json::json!({"action": "navigate", "url": url}));
        assert_eq!(r1["returncode"], 0, "navigate failed: {r1}");
        assert_eq!(registry().len(), 1, "exactly one daemon after the first call");
        let daemon_pid = registry()[0]["pid"].as_u64().unwrap();
        let daemon_port = registry()[0]["port"].as_u64().unwrap();
        // 2. snapshot through the SAME daemon (no second entry).
        let r2 = super::outcome(&serde_json::json!({"action": "snapshot"}));
        assert_eq!(r2["returncode"], 0, "snapshot failed: {r2}");
        assert!(format!("{}", r2["output"]).contains("pool e2e OK"), "snapshot missed the page text: {r2}");
        assert_eq!(registry().len(), 1);
        assert_eq!(registry()[0]["port"].as_u64().unwrap(), daemon_port);
        // 3. shot: a native PNG image attachment, not a file path.
        let r3 = super::outcome(&serde_json::json!({"action": "shot"}));
        assert_eq!(r3["returncode"], 0, "shot failed: {r3}");
        assert!(r3["image_url"].as_str().unwrap_or("").starts_with("data:image/png;base64,"), "shot carried no image: {r3}");
        // 4. click/type without refs fail honestly (and still one daemon).
        let r4 = super::outcome(&serde_json::json!({"action": "click"}));
        assert_eq!(r4["returncode"], 1);
        // 5. a non-allowlisted external URL is refused at the boundary.
        let r5 = super::outcome(&serde_json::json!({"action": "navigate", "url": "https://example.com"}));
        assert_eq!(r5["returncode"], 1);
        assert!(format!("{}", r5["output"]).contains("MINITUI_CU_ALLOW"));
        // 6. idle teardown: after the 1s idle window the next call reaps the
        // daemon and starts fresh — the old data dir is gone.
        std::thread::sleep(std::time::Duration::from_secs(2));
        let r6 = super::outcome(&serde_json::json!({"action": "navigate", "url": url}));
        assert_eq!(r6["returncode"], 0, "post-teardown navigate failed: {r6}");
        assert_eq!(registry().len(), 1, "the swept daemon left no entry behind");
        let new_pid = registry()[0]["pid"].as_u64().unwrap();
        assert_ne!(new_pid, daemon_pid, "teardown did not happen: same daemon reused");
        assert!(work.join(format!("d-{}", registry()[0]["port"].as_u64().unwrap())).exists(), "the fresh daemon has no data dir");
        drop(guard);
    }
}
