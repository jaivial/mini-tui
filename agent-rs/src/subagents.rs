//! Subagents owned by the session's own agent.
//!
//! Every `mini-agent-rs` run (unless `MINI_AGENT_SUBAGENTS=0`) starts a small hub: a Unix socket
//! its bash commands reach through `MINI_AGENT_SOCKET`, and a monitor thread. The model drives it
//! with `mini-agent-rs agent …` (see `HELP`):
//!
//! - `spawn` starts a child: an ordinary `mini-agent-rs` run in its own process group, with its
//!   OWN control file kept open. A finished child holds at its exit with its whole context, so a
//!   follow-up (`send`) is one `MESSAGE` line, not a new process replaying the history; a
//!   message sent mid-turn lands before the child's next model call.
//! - The monitor follows every child's journal. A child finishing, failing, stalling or asking
//!   (`agent ask`) becomes a note the parent receives before its next model call — or that wakes
//!   it while it holds at its exit — so the orchestrator never spends steps polling.
//! - Children's spend counts toward the parent's cost limit; they stop with the parent.
//! - `<traj dir>/subagents/index.json` lists the children (paths, pid, state) so mini-tui can show
//!   them as sessions under their parent and follow any of them live.

use crate::plan::{Plan, Task, SATISFIED};
use crate::util::now;
use crate::resources::{self, Tracker};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, BufReader, Read, Seek, SeekFrom, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::process::{Child as Proc, Command, Stdio};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex, OnceLock};
use std::time::Duration;

pub const HELP: &str = "mini-agent-rs agent - subagents of this session (run from the agent's bash tool)

  agent spawn <name> [options] <task...>   start a subagent (returns at once)
      --cwd DIR          folder it works in (default: the current folder)
      -m, --model M      its model (default: this session's)
      --max-steps N      model calls per turn (default 200)
      --cost-limit USD   its budget per turn (default 2, capped by what this session has left)
      --skill NAME       inline a skill's SKILL.md (repeatable; `$name` in the task works too)
      --prompt-file F    read the task from a file ('-' = stdin)
      --context-file F   hand it context instead of making it re-discover (repeatable; capped)
      --brief            the task is a structured brief (goal, key paths, conventions,
                         searches done, decisions): validated and wrapped as <brief>
      --fork [--fork-k N] [--from NAME]
                         the child continues a compacted conversation instead of starting
                         cold: this session's by default, or sibling NAME's with --from.
                         Its context = the source's compaction summary + the last N messages
                         (default 12, MINI_AGENT_FORK_K), replayed as its own history.
  agent send <name> <text...>            message it: mid-turn it lands before its next model call;
                                         a finished one continues with its full context.
      --steps N / --cost USD             extend its budget (automatic after LimitsExceeded)
  agent model <name> <model>             switch its model from its next step
  agent resources [--json]               the box's free memory, an average subagent's cost, and
                                         how many more may start (the 10 GiB reserve applies)
  agent can-spawn N [--json]             would N more subagents fit now?
  agent ls [--json]                      every subagent: state, steps, cost, idle, last command
  agent status <name> [--json]           one subagent in detail
  agent wait [names...] [--any] [--timeout S]
                                         block until they finish their turn (default 20 s: the bash
                                         tool times out at 30). You are also told when each one
                                         finishes, before your next step, so you rarely need it.
  agent result <name>                    its final answer (or its last reply)
  agent tail <name> [-n N]               its last steps
  agent stop <name...>|--all             interrupt (it saves); `send` continues it later
  agent ask <text...>                    (inside a subagent) message the session that started it

  agent plan submit --file plan.json     hand over a whole DAG plan (validated: ids, deps, no cycles)
  agent plan add <id> [--deps a,b] [--group G] [--priority N] [--steps N] [--cost C]
                 [--artifact F]... [--title T] <task...>    re-plan in flight
  agent plan rm <id...>                  drop tasks that are not running
  agent plan dep <id> <dep...> [--rm]    change dependencies (re-validated)
  agent plan show [--json]               task states + the ready queue
  agent plan graph                       edges and states (the task board draws this)
  agent plan review <id> ok|fail [why]   accept a finished task (review -> done) or fail it
  agent plan retry <id>                  relaunch a failed/blocked task

Plan tasks launch themselves: the moment a task's deps are satisfied the hub starts it (subject to
memory, cost and its group), hands over its deps' results and artifacts, and reports [plan] notes.
A task ends pending -> running -> review (done enough for successors) -> done when you review it.

States: starting, running, waiting (turn done; holds its context for `send`), stopped, exited.
Notes about subagents arrive as user messages that start with [subagent <name>].";

/// Default budget of a child turn (the old `orch` defaults).
const DEFAULT_MAX_STEPS: i64 = 200;
const DEFAULT_COST_LIMIT: f64 = 2.0;

static HUB: OnceLock<Arc<Mutex<Hub>>> = OnceLock::new();
/// The children's spend, as f64 bits: read by the agent loop's cost check without the lock.
static CHILD_COST: AtomicU64 = AtomicU64::new(0);
static ACTIVE: AtomicBool = AtomicBool::new(false);

pub struct Child {
    pub name: String,
    pub task: String,
    pub cwd: String,
    pub model: String,
    pub skills: Vec<String>,
    dir: PathBuf,
    traj: PathBuf,
    journal: PathBuf,
    control: PathBuf,
    log: PathBuf,
    proc: Option<Proc>,
    pid: i32,
    pub state: String,
    pub exit_status: String,
    pub submission: String,
    /// The text of its last exit message (the reason when a turn failed).
    pub exit_text: String,
    pub last_text: String,
    pub last_command: String,
    pub steps: i64,
    pub calls: i64,
    pub cost: f64,
    /// Cost of earlier processes of this child (a resumed one starts its own count at 0).
    cost_before: f64,
    pub turns: i64,
    pub started_at: f64,
    pub last_activity: f64,
    max_steps: i64,
    cost_limit: f64,
    offset: u64,
    partial: String,
    stall_reported: bool,
    stop_requested: bool,
    exit_code: Option<i32>,
    /// A resumed process first replays its old conversation (exits included): everything up to
    /// the new task's message is history already counted, not news.
    replaying: bool,
    /// The task a resumed process was started with (the end of its replay).
    resume_task: String,
    /// Turns the parent has already been told about (directly through `wait`/`result`, or by a note).
    turns_seen: i64,
    /// Last sampled RSS of this child's process group (MiB); 0 when not sampled yet.
    pub mem_rss: u64,
    /// Its rolling mean RSS, and its peak (MiB): what a new child is charged for.
    pub mem_avg: u64,
    pub mem_peak: u64,
}

impl Child {
    fn total_cost(&self) -> f64 {
        self.cost_before + self.cost
    }

    fn summary(&self) -> Value {
        json!({
            "name": self.name,
            "state": self.state,
            "exit_status": self.exit_status,
            "task": first_line(&self.task, 200),
            "cwd": self.cwd,
            "model": self.model,
            "skills": self.skills,
            "steps": self.steps,
            "calls": self.calls,
            "cost": round4(self.total_cost()),
            "turns": self.turns,
            "pid": self.pid,
            "traj_path": self.traj.display().to_string(),
            "control_path": self.control.display().to_string(),
            "log_path": self.log.display().to_string(),
            "started_at": self.started_at,
            "last_activity": self.last_activity,
            "idle_s": (now() - self.last_activity).max(0.0) as i64,
            "last_command": first_line(&self.last_command, 160),
            "exit_code": self.exit_code,
            "mem_rss": self.mem_rss,
            "mem_avg": self.mem_avg,
            "mem_peak": self.mem_peak,
        })
    }

    fn running(&self) -> bool {
        self.state == "running" || self.state == "starting"
    }

    fn control_line(&self, line: &str) -> Result<(), String> {
        let mut f = std::fs::OpenOptions::new().append(true).create(true).open(&self.control).map_err(|e| format!("{}: {e}", self.control.display()))?;
        writeln!(f, "{line}").map_err(|e| e.to_string())
    }
}

pub struct Hub {
    dir: PathBuf,
    /// The parent's own journal: what `--fork` continues from when no sibling is named.
    journal: PathBuf,
    /// The run tree's shared state on disk (`<run dir>/context/`): the whole tree writes and reads it.
    context_dir: PathBuf,
    runtime: PathBuf,
    socket: PathBuf,
    exe: PathBuf,
    configs: Vec<String>,
    depth: u32,
    children: Vec<Child>,
    /// (child, turn, text): a turn report names its child and turn; other notes have turn 0.
    notes: Vec<(String, i64, String)>,
    /// The parent's cost limit and own spend, for capping a child's budget.
    parent_limit: f64,
    parent_cost: f64,
    /// The model the parent runs on now (children default to it, `/model` switches included).
    parent_model: String,
    /// Rolling memory use of each live child, and the fan-out question it answers.
    usage: Tracker,
    /// Monitor ticks so far: memory sampling runs every other one.
    tick: u64,
    /// Fingerprint of the roster the last `index.json` write held (see `roster_key`).
    index_key: String,
    /// The DAG plan this hub executes (`<traj dir>/subagents/plan.json`), if any.
    plan: Option<Plan>,
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

pub fn first_line_pub(text: &str, width: usize) -> String {
    first_line(text, width)
}

fn first_line(text: &str, width: usize) -> String {
    let line = text.trim().lines().next().unwrap_or("").trim();
    if line.chars().count() <= width {
        line.to_string()
    } else {
        format!("{}…", line.chars().take(width - 1).collect::<String>())
    }
}

fn tail_chars(text: &str, n: usize) -> String {
    let count = text.chars().count();
    if count <= n {
        text.trim().to_string()
    } else {
        format!("…{}", text.chars().skip(count - n).collect::<String>().trim())
    }
}

fn head_chars(text: &str, n: usize) -> String {
    if text.chars().count() <= n {
        text.trim().to_string()
    } else {
        format!("{}…", text.chars().take(n).collect::<String>().trim_end())
    }
}

pub fn valid_name(name: &str) -> bool {
    !name.is_empty() && name.len() <= 64 && name.chars().all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-') && !name.starts_with('.')
}

fn env_num<T: std::str::FromStr>(key: &str, default: T) -> T {
    std::env::var(key).ok().and_then(|v| v.parse().ok()).unwrap_or(default)
}

// ---- skills ----------------------------------------------------------------------------

fn skills_dir() -> PathBuf {
    match std::env::var("MINITUI_SKILLS_DIR").ok().filter(|s| !s.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => PathBuf::from(std::env::var("HOME").unwrap_or_default()).join(".config/mini-tui/skills"),
    }
}

/// `name -> folder` of every skill (a folder with a SKILL.md), two levels deep, like mini-tui.
fn discover_skills(dir: &Path) -> BTreeMap<String, PathBuf> {
    let mut found = BTreeMap::new();
    fn scan(base: &Path, depth: u32, found: &mut BTreeMap<String, PathBuf>) {
        let Ok(rd) = std::fs::read_dir(base) else { return };
        let mut names: Vec<_> = rd.filter_map(|e| e.ok()).map(|e| e.file_name().to_string_lossy().to_string()).collect();
        names.sort();
        let mut nested = vec![];
        for name in names {
            if name.starts_with('.') {
                continue;
            }
            let path = base.join(&name);
            if !path.is_dir() {
                continue;
            }
            if path.join("SKILL.md").exists() {
                if !found.contains_key(&name) && name.chars().all(|c| c.is_alphanumeric() || c == '_' || c == '.' || c == '-') {
                    found.insert(name, path);
                }
            } else if depth > 0 {
                nested.push(path);
            }
        }
        for p in nested {
            scan(&p, depth - 1, found);
        }
    }
    scan(dir, 2, &mut found);
    found
}

/// The `$name` references in a text, in order, without repeats (mini-tui's SKILL_TOKEN).
fn skill_refs(text: &str) -> Vec<String> {
    let re = regex::Regex::new(r#"(^|[\s(\[{"'`,;])\$([A-Za-z][\w.-]*[\w]|[A-Za-z])"#).unwrap();
    let mut out: Vec<String> = vec![];
    for c in re.captures_iter(text) {
        let n = c[2].to_string();
        if !out.contains(&n) {
            out.push(n);
        }
    }
    out
}

const REQUEST_HEADER: &str = "Follow the skills above where the request references them ($name):\n";

/// mini-tui's `expandSkills`: the instructions of the referenced (and `extra`) skills, then the
/// text verbatim — the same block the TUI sends, so both UIs show the prompt collapsed again.
/// Skills in `already` (sent to this child before) are not sent twice.
pub fn expand_skills(text: &str, extra: &[String], already: &[String]) -> (String, Vec<String>, Vec<String>) {
    let available = discover_skills(&skills_dir());
    let mut wanted: Vec<String> = extra.to_vec();
    for r in skill_refs(text) {
        if !wanted.contains(&r) {
            wanted.push(r);
        }
    }
    let mut used = vec![];
    let mut missing = vec![];
    let mut blocks = vec![];
    for name in wanted {
        if already.contains(&name) {
            continue;
        }
        match available.get(&name) {
            Some(dir) => {
                let path = dir.join("SKILL.md");
                if let Ok(body) = std::fs::read_to_string(&path) {
                    blocks.push(format!("<skill name=\"{name}\" path=\"{}\">\n{}\n</skill>", path.display(), body.trim()));
                    used.push(name);
                }
            }
            None => {
                if extra.contains(&name) {
                    missing.push(name);
                }
            }
        }
    }
    if blocks.is_empty() {
        return (text.to_string(), used, missing);
    }
    (format!("<skills>\n{}\n</skills>\n\n{REQUEST_HEADER}{text}", blocks.join("\n\n")), used, missing)
}

// ---- context inheritance (Fase 1) ----------------------------------------------------------

/// The brief sections a parent's brief must cover (English or Spanish headings).
const BRIEF_SECTIONS: &[(&str, &[&str])] = &[
    ("goal", &["goal", "objetivo"]),
    ("key paths", &["key paths", "rutas", "rutas clave"]),
    ("conventions", &["conventions", "convenciones"]),
    ("searches done", &["searches", "searches done", "busquedas", "búsquedas"]),
    ("decisions", &["decisions", "decisiones"]),
];

/// Wrap the parent's brief in a `<brief>` block after checking it covers the sections that make a
/// child stop re-discovering: what to do, where, the conventions, what was already searched, and
/// the decisions taken. At least 3 of the 5 sections must be present (goal being one).
pub fn wrap_brief(task: &str) -> Result<String, String> {
    let lower = task.to_lowercase();
    let present: Vec<&str> = BRIEF_SECTIONS
        .iter()
        .filter(|(_, heads)| heads.iter().any(|h| lower.contains(&format!("## {h}")) || lower.contains(&format!("{h}:"))))
        .map(|(name, _)| *name)
        .collect();
    let missing: Vec<&str> = BRIEF_SECTIONS.iter().map(|(n, _)| *n).filter(|n| !present.contains(n)).collect();
    if !present.contains(&"goal") || present.len() < 3 {
        return Err(format!(
            "`--brief` needs a structured brief with `## <section>` headings (or `section:` lines):\n  sections seen: {}\n  missing: {}\n  write: goal / key paths / conventions / searches done / decisions (or: objetivo / rutas clave / convenciones / búsquedas / decisiones)",
            if present.is_empty() { "none".into() } else { present.join(", ") },
            missing.join(", ")
        ));
    }
    Ok(format!(
        "<brief>\n{}\n\n(This is the parent\u{2019}s brief: it already contains the goal, the key paths, the\nconventions, the searches already done and the decisions taken. Work from it instead of\nre-discovering that; verify the claims that matter to your task.)\n</brief>",
        task.trim()
    ))
}

/// The note every child gets about the run tree's shared state on disk (append-only).
pub fn shared_context_note(dir: &Path) -> String {
    format!(
        "<shared-context>\nShared state on disk: {} (append-only).\nBefore searching or reading something, check what prior tasks left there (findings.md,\nsearch-cache.jsonl, artifacts/); when you learn something reusable or write an artifact, leave\nit there under your own file (one file per task, e.g. {}), stamped with date and author.\n</shared-context>",
        dir.display(),
        format!("{}/<your-task-id>.md", dir.display())
    )
}

// ---- fork from a compacted conversation (F4 · plan Fase 5) ------------------------------

/// The conversation a forked child starts from (`fork.json`, replayed as its own history): its
/// source's system prompt, then a compacted summary of the source's work plus its last `k`
/// messages slimmed to their text. Not a cold start: the child knows what its source knew.
pub fn fork_messages(source: &str, msgs: &[Value], k: usize, cap: usize) -> Vec<Value> {
    let summary = crate::compaction::compaction_summary(msgs)
        .unwrap_or_else(|| crate::compaction::fallback_summary(msgs));
    let summary = head_chars(&summary, cap / 2);
    let mut recent: Vec<String> = Vec::new();
    for m in msgs.iter().rev().take(k).rev() {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        if role == "system" {
            continue;
        }
        let text = content_text(m);
        if text.trim().is_empty() {
            continue;
        }
        recent.push(format!("[{role}] {}", head_chars(&text, 2000)));
    }
    let block = |recent: &[String]| {
        format!(
            "[Context forked from {source}: its conversation, compacted. Continue that work from this summary and its last messages; do not redo what it already did.]\n\n<summary>\n{}\n</summary>\n\n<recent>\n{}\n</recent>",
            summary.trim(),
            recent.join("\n\n")
        )
    };
    let mut body = block(&recent);
    // The summary is dense but the tail can be long: drop the oldest whole messages first.
    while body.chars().count() > cap && recent.len() > 1 {
        recent.remove(0);
        body = block(&recent);
    }
    let mut out: Vec<Value> = msgs
        .iter()
        .filter(|m| m.get("role").and_then(Value::as_str) == Some("system"))
        .cloned()
        .collect();
    out.push(json!({"role": "user", "content": body}));
    out.push(json!({"role": "assistant", "content": "(Continuing from the forked context above.)"}));
    out
}

// ---- the hub -----------------------------------------------------------------------------

/// Stops the children and removes the socket when the run ends.
pub struct Guard;
impl Drop for Guard {
    fn drop(&mut self) {
        shutdown();
    }
}

/// Runtime dirs of runs that died without cleaning up (SIGKILL, a crash): `mini-agent-<pid>-<hex>`.
fn prune_stale_runtimes() {
    let Ok(rd) = std::fs::read_dir(std::env::temp_dir()) else { return };
    for e in rd.flatten() {
        let name = e.file_name().to_string_lossy().to_string();
        let Some(rest) = name.strip_prefix("mini-agent-") else { continue };
        let Some(pid) = rest.split('-').next().and_then(|p| p.parse::<i32>().ok()) else { continue };
        let alive = unsafe { libc::kill(pid, 0) } == 0 || std::io::Error::last_os_error().raw_os_error() == Some(libc::EPERM);
        if !alive {
            let _ = std::fs::remove_dir_all(e.path());
        }
    }
}

pub fn enabled() -> bool {
    std::env::var("MINI_AGENT_SUBAGENTS").map(|v| v != "0").unwrap_or(true)
}

/// Start the hub for a run that journals into `traj`. `configs` are the run's `-c` specs, which
/// children inherit (same agent config and model settings unless they choose another model).
pub fn start(traj: &Path, configs: &[String], parent_limit: f64) -> Option<Guard> {
    if !enabled() || HUB.get().is_some() {
        return None;
    }
    let dir = traj.parent().unwrap_or(Path::new(".")).join("subagents");
    // The shared state of the whole run tree: the root's `context/`, or the one we were given.
    let context_dir = match std::env::var("MINI_AGENT_CONTEXT_DIR").ok().filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => traj.parent().unwrap_or(Path::new(".")).join("context"),
    };
    let _ = std::fs::create_dir_all(&context_dir);
    let pid = std::process::id();
    let depth: u32 = env_num("MINI_AGENT_DEPTH", 0);
    // At the nesting limit a run can not start children: no hub, no socket, nothing to clean up.
    if depth >= env_num("MINI_AGENT_MAX_DEPTH", 2u32) {
        return None;
    }
    prune_stale_runtimes();
    // Socket paths are limited to ~107 bytes: keep it short, under the temp dir.
    let runtime = std::env::temp_dir().join(format!("mini-agent-{pid}-{}", crate::util_hex(6)));
    let bin = runtime.join("bin");
    if std::fs::create_dir_all(&bin).is_err() {
        return None;
    }
    use std::os::unix::fs::PermissionsExt;
    let _ = std::fs::set_permissions(&runtime, std::fs::Permissions::from_mode(0o700));
    let exe = std::env::current_exe().ok()?;
    let _ = std::os::unix::fs::symlink(&exe, bin.join("mini-agent-rs"));
    let socket = runtime.join("hub.sock");
    let listener = UnixListener::bind(&socket).ok()?;
    let _ = std::fs::set_permissions(&socket, std::fs::Permissions::from_mode(0o600));
    // The bash tool reads the process environment for every command (before any thread starts).
    std::env::set_var("MINI_AGENT_SOCKET", &socket);
    std::env::set_var("MINI_AGENT_BIN", &exe);
    let path = std::env::var("PATH").unwrap_or_default();
    std::env::set_var("PATH", format!("{}:{path}", bin.display()));
    let plan = load_plan(&dir);
    let hub = Hub {
        dir,
        journal: crate::agent::journal_path(traj),
        context_dir,
        runtime,
        socket,
        exe,
        configs: configs.to_vec(),
        depth,
        children: vec![],
        notes: vec![],
        parent_limit,
        parent_cost: 0.0,
        parent_model: String::new(),
        usage: Tracker::default(),
        tick: 0,
        index_key: String::new(),
        plan,
    };
    let hub = Arc::new(Mutex::new(hub));
    let _ = HUB.set(hub.clone());
    ACTIVE.store(true, Ordering::SeqCst);
    {
        let hub = hub.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(stream) = stream else { continue };
                if !ACTIVE.load(Ordering::SeqCst) {
                    break;
                }
                let hub = hub.clone();
                std::thread::spawn(move || serve(hub, stream));
            }
        });
    }
    {
        let hub = hub.clone();
        let every = Duration::from_millis(env_num("MINI_AGENT_MONITOR_MS", 250u64));
        std::thread::spawn(move || {
            while ACTIVE.load(Ordering::SeqCst) {
                if let Ok(mut h) = hub.lock() {
                    h.monitor();
                }
                std::thread::sleep(every);
            }
        });
    }
    Some(Guard)
}

/// Notes for the parent (children finished, failed, stalled or asked), oldest first.
pub fn take_notes() -> Vec<String> {
    let Some(hub) = HUB.get() else { return vec![] };
    let Ok(mut h) = hub.lock() else { return vec![] };
    h.monitor(); // nothing that already happened is held back for a poll interval
    h.live_notes()
}

pub fn has_notes() -> bool {
    HUB.get()
        .and_then(|h| {
            h.lock().ok().map(|mut h| {
                h.monitor();
                let live = h.live_notes();
                let any = !live.is_empty();
                h.notes.extend(live.into_iter().map(|t| (String::new(), 0, t)));
                any
            })
        })
        .unwrap_or(false)
}

/// Children still working on a turn (a finished one holds at its exit and does not count).
pub fn live_children() -> usize {
    HUB.get().and_then(|h| h.lock().ok().map(|mut h| {
        h.monitor();
        h.children.iter().filter(|c| c.proc.is_some() && c.running()).count()
    })).unwrap_or(0)
}

pub fn children_cost() -> f64 {
    f64::from_bits(CHILD_COST.load(Ordering::SeqCst))
}

/// The parent's spend, limit and current model: a child's budget is capped by what the session
/// has left, and a child runs on the parent's model unless told otherwise.
pub fn set_parent_state(cost: f64, limit: f64, model: &str) {
    if let Some(hub) = HUB.get() {
        if let Ok(mut h) = hub.lock() {
            h.parent_cost = cost;
            h.parent_limit = limit;
            h.parent_model = model.to_string();
        }
    }
}

/// The children, for the trajectory's `info.subagents` (None when the hub is off or empty).
pub fn snapshot() -> Option<Value> {
    let hub = HUB.get()?;
    let h = hub.lock().ok()?;
    if h.children.is_empty() {
        return None;
    }
    Some(Value::Array(h.children.iter().map(Child::summary).collect()))
}

/// Interrupt every child (they save), give them a moment, then kill what is left.
pub fn shutdown() {
    if !ACTIVE.swap(false, Ordering::SeqCst) {
        return;
    }
    let Some(hub) = HUB.get() else { return };
    let Ok(mut h) = hub.lock() else { return };
    for c in h.children.iter() {
        if c.proc.is_some() && c.pid > 0 {
            unsafe {
                libc::killpg(c.pid, libc::SIGINT);
            }
        }
    }
    let deadline = now() + env_num("MINI_AGENT_SHUTDOWN_GRACE_S", 3.0);
    loop {
        let mut alive = false;
        for c in h.children.iter_mut() {
            if let Some(p) = c.proc.as_mut() {
                if matches!(p.try_wait(), Ok(None)) {
                    alive = true;
                } else {
                    c.proc = None;
                    crate::e2e::worker::unregister(c.pid);
                }
            }
        }
        if !alive || now() > deadline {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    for c in h.children.iter_mut() {
        if c.proc.is_some() && c.pid > 0 {
            unsafe {
                libc::killpg(c.pid, libc::SIGKILL);
            }
            if let Some(mut p) = c.proc.take() {
                let _ = p.wait();
            }
            crate::e2e::worker::unregister(c.pid);
        }
        if c.running() || c.state == "waiting" {
            c.state = "stopped".into();
        }
    }
    h.write_index();
    let _ = std::fs::remove_dir_all(&h.runtime);
}

impl Hub {
    fn child(&mut self, name: &str) -> Result<&mut Child, String> {
        let names: Vec<String> = self.children.iter().map(|c| c.name.clone()).collect();
        self.children.iter_mut().find(|c| c.name == name).ok_or_else(|| {
            if names.is_empty() {
                format!("no subagent named {name} (none started yet)")
            } else {
                format!("no subagent named {name} (have: {})", names.join(", "))
            }
        })
    }

    fn note(&mut self, text: String) {
        self.notes.push((String::new(), 0, text));
    }

    /// The parent learned about these turns from a reply (`wait`, `result`).
    fn mark_seen(&mut self, names: &[String]) {
        for c in self.children.iter_mut() {
            if names.is_empty() || names.contains(&c.name) {
                c.turns_seen = c.turns;
            }
        }
    }

    /// Notes still worth delivering: a finished turn the parent already saw (it waited for it,
    /// or read its result) is not reported again — that would only wake it to read it twice.
    fn live_notes(&mut self) -> Vec<String> {
        let notes = std::mem::take(&mut self.notes);
        notes
            .into_iter()
            .filter(|(name, turn, _)| name.is_empty() || self.children.iter().find(|c| &c.name == name).map(|c| c.turns_seen < *turn).unwrap_or(false))
            .map(|(_, _, text)| text)
            .collect()
    }

    /// Read new journal lines, notice exits and stalls, refresh the totals and the index.
    fn monitor(&mut self) {
        let stall_s: f64 = env_num("MINI_AGENT_STALL_S", 600.0);
        // Sampling memory is a few small reads per live child: every other tick is plenty.
        self.tick += 1;
        let sample = self.tick % 2 == 0;
        if sample {
            // Drop the bookkeeping of children whose process is gone, then sample the live ones.
            let gone: Vec<String> = self.children.iter().filter(|c| c.proc.is_none()).map(|c| c.name.clone()).collect();
            for n in gone {
                self.usage.drop(&n);
            }
        }
        let mut notes = vec![];
        for c in self.children.iter_mut() {
            for line in read_new(&c.journal, &mut c.offset, &mut c.partial) {
                c.last_activity = now();
                match line.get("t").and_then(Value::as_str) {
                    Some("msg") => {
                        let m = &line["m"];
                        if c.replaying {
                            if m.pointer("/extra/interrupt_type").and_then(Value::as_str) == Some("UserNewTask") && m.get("role").and_then(Value::as_str) == Some("user") && line_is_last_task(m, &c.resume_task) {
                                c.replaying = false;
                                c.state = "running".into();
                            }
                            continue;
                        }
                        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
                        let content = content_text(m);
                        match role {
                            "assistant" => {
                                c.steps += 1;
                                if !content.trim().is_empty() {
                                    c.last_text = content;
                                }
                                if let Some(cmd) = m.pointer("/extra/actions").and_then(Value::as_array).and_then(|a| a.last()).and_then(|a| a.get("command")).and_then(Value::as_str) {
                                    c.last_command = cmd.to_string();
                                }
                                if c.state != "stopped" {
                                    c.state = "running".into();
                                }
                            }
                            "user" => {
                                if m.pointer("/extra/interrupt_type").and_then(Value::as_str) == Some("UserNewTask") {
                                    c.state = "running".into();
                                    c.stall_reported = false;
                                }
                            }
                            "exit" => {
                                c.turns += 1;
                                c.exit_status = m.pointer("/extra/exit_status").and_then(Value::as_str).unwrap_or("").to_string();
                                c.submission = m.pointer("/extra/submission").and_then(Value::as_str).unwrap_or("").to_string();
                                // A failed turn's exit message carries the reason (an HTTP error, a traceback).
                                c.exit_text = content.clone();
                                let was_stop = c.stop_requested;
                                c.state = if was_stop { "stopped".into() } else { "waiting".into() };
                                c.stop_requested = false;
                                if !was_stop {
                                    notes.push((c.name.clone(), c.turns, finished_note(c)));
                                }
                            }
                            _ => {}
                        }
                    }
                    Some("info") => {
                        let i = &line["i"];
                        if let Some(n) = i.pointer("/model_stats/api_calls").and_then(Value::as_i64) {
                            c.calls = n;
                        }
                        if let Some(x) = i.pointer("/model_stats/instance_cost").and_then(Value::as_f64) {
                            c.cost = x;
                        }
                    }
                    _ => {}
                }
            }
            if let Some(p) = c.proc.as_mut() {
                if let Ok(Some(status)) = p.try_wait() {
                    c.proc = None;
                    crate::e2e::worker::unregister(c.pid);
                    let code = status.code().unwrap_or(-1);
                    c.exit_code = Some(code);
                    let quiet = c.stop_requested || c.state == "stopped" || !ACTIVE.load(Ordering::SeqCst);
                    if c.state == "waiting" || c.state == "stopped" {
                        c.state = if c.state == "stopped" || c.stop_requested { "stopped".into() } else { "exited".into() };
                    } else {
                        c.state = if c.stop_requested { "stopped".into() } else { "exited".into() };
                        if !quiet {
                            let log = std::fs::read_to_string(&c.log).unwrap_or_default();
                            notes.push((String::new(), 0, format!(
                                "[subagent {}] stopped unexpectedly (exit code {code}) after {} steps.\n{}\n`agent send {} \"…\"` restarts it from its saved conversation.",
                                c.name,
                                c.steps,
                                tail_chars(&log, 1200),
                                c.name
                            )));
                        }
                    }
                    c.stop_requested = false;
                }
            }
            if sample && c.proc.is_some() && c.pid > 0 && c.running() {
                c.mem_rss = self.usage.observe(&c.name, c.pid, now() - c.started_at).rss_mb;
            }
            if c.running() && !c.stall_reported && stall_s > 0.0 && now() - c.last_activity > stall_s {
                c.stall_reported = true;
                notes.push((String::new(), 0, format!(
                    "[subagent {}] has written nothing for {}s (last command: {}). `agent tail {}` shows where it is; `agent send` corrects it, `agent stop` stops it.",
                    c.name,
                    (now() - c.last_activity) as i64,
                    first_line(&c.last_command, 160),
                    c.name
                )));
            }
        }
        self.notes.extend(notes);
        let total: f64 = self.children.iter().map(Child::total_cost).sum();
        CHILD_COST.store(total.to_bits(), Ordering::SeqCst);
        self.tick_plan();
        self.write_index();
    }

    fn write_index(&mut self) {
        if self.children.is_empty() {
            return;
        }
        // Nothing a UI shows has changed since the last tick: skip building and serializing the
        // whole roster (100 children = 100 JSON objects) four times a second for nothing.
        let key = self.roster_key();
        if self.index_key == key {
            return;
        }
        self.index_key = key;
        let mut v = json!({
            "parent_pid": std::process::id(),
            "socket": self.socket.display().to_string(),
            "children": self.children.iter().map(Child::summary).collect::<Vec<_>>(),
        });
        if let Some(plan) = &self.plan {
            v["plan"] = json!({ "tasks": plan.tasks.iter().map(|t| t.to_value()).collect::<Vec<_>>() });
        }
        v["updated_at"] = json!(now());
        let _ = std::fs::create_dir_all(&self.dir);
        let path = self.dir.join("index.json");
        let tmp = self.dir.join("index.json.tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap()).is_ok() {
            let _ = std::fs::rename(&tmp, &path);
        }
    }

    fn launch(&mut self, req: &Value) -> Result<String, String> {
        let name = s(req, "name");
        if !valid_name(&name) {
            return Err(format!("invalid subagent name {name:?}: letters, digits, '.', '_' or '-'"));
        }
        let max_depth: u32 = env_num("MINI_AGENT_MAX_DEPTH", 2);
        if self.depth >= max_depth {
            return Err(format!("subagents may not start subagents beyond depth {max_depth}: do this task yourself"));
        }
        let max_live: usize = env_num("MINI_AGENT_MAX_SUBAGENTS", 100).min(100);
        let live = self.children.iter().filter(|c| c.proc.is_some()).count();
        if live >= max_live {
            return Err(format!("{live} subagents are already alive (limit {max_live}): `agent stop` one you no longer need"));
        }
        // The OOM guard: the same calculus `agent resources` reports, enforced at the gate. A batch
        // that would not fit is refused here, and the session keeps running (exit 1, a message).
        let fits = self.fanout_left();
        if live as u64 >= fits {
            let r = self.resources_report();
            let b = &r.budget;
            return Err(format!(
                "refusing subagent: {live} are alive and the box has room for {fits} more.\n  memory {} free, the session keeps {} for itself, a subagent costs {} on average ({}).\n  `agent resources` shows the numbers; `agent stop` one that is done, then spawn again.",
                crate::resources::gb_g(b.available_mb), crate::resources::gb_g(b.reserve_mb), crate::resources::gb_g(b.per_child_mb()), crate::resources::gb_g(b.avg_child_mb)
            ));
        }
        if let Some(i) = self.children.iter().position(|c| c.name == name) {
            if self.children[i].running() {
                return Err(format!("a subagent named {name} already exists ({}): `agent send {name} …` continues it", self.children[i].state));
            }
            if !req.get("force").and_then(Value::as_bool).unwrap_or(false) {
                return Err(format!("{name} was used before ({}): `agent send {name} …` continues it, or pick another name", self.children[i].state));
            }
            // A finished child holds its process (and its context) at its exit: forced reuse of
            // the name lets that process go first, so nothing keeps running behind the new child.
            let old_child = &mut self.children[i];
            if old_child.proc.is_some() {
                if old_child.pid > 0 {
                    unsafe {
                        libc::killpg(old_child.pid, libc::SIGINT);
                    }
                }
                let deadline = now() + 2.0;
                while old_child.proc.as_mut().map(|p| matches!(p.try_wait(), Ok(None))).unwrap_or(false) && now() < deadline {
                    std::thread::sleep(Duration::from_millis(50));
                }
                old_child.proc = None;
                crate::e2e::worker::unregister(old_child.pid);
            }
            self.children.remove(i);
        }
        let raw_task = s(req, "task");
        if raw_task.trim().is_empty() {
            return Err("spawn needs a task".into());
        }
        // Fork (F4 · plan Fase 5): the child continues a compacted conversation -- this session's own, or a
        // sibling's (`--from`) -- instead of starting cold and re-discovering what its source knew.
        let fork = if req.get("fork").and_then(Value::as_bool).unwrap_or(false) {
            let from = s(req, "from");
            let (journal, label) = if from.is_empty() {
                (self.journal.clone(), "this session".to_string())
            } else {
                let c = self.child(&from)?;
                (c.journal.clone(), c.name.clone())
            };
            let msgs = read_messages(&journal);
            if msgs.is_empty() {
                return Err(format!("--fork: {label} has no conversation to fork yet ({})", journal.display()));
            }
            let k = match req.get("fork_k").and_then(Value::as_i64) {
                Some(n) if n < 0 => return Err("--fork-k needs a number of messages (0 or more)".into()),
                Some(n) => n as usize,
                None => env_num::<usize>("MINI_AGENT_FORK_K", 12),
            };
            Some((msgs, label, k))
        } else {
            None
        };
        // Context the child starts with instead of re-discovering it (Fase 1): files handed over
        // (`--context-file`), the parent's brief (`--brief`), and the shared state on disk note.
        let context_max: usize = env_num("MINI_AGENT_CONTEXT_MAX", 32 * 1024);
        let mut context_blocks = String::new();
        for f in req.get("context_files").and_then(Value::as_array).cloned().unwrap_or_default() {
            let path = f.as_str().unwrap_or("");
            let body = std::fs::read_to_string(crate::config::expand_user(path)).map_err(|e| format!("--context-file {path}: {e}"))?;
            if body.chars().count() > context_max {
                return Err(format!("--context-file {path} is {} chars, over the {} char cap: trim it or leave the detail in the shared context/ folder", body.chars().count(), context_max));
            }
            context_blocks.push_str(&format!("<context name=\"{path}\">\n{}\n</context>\n\n", body.trim()));
        }
        if context_blocks.chars().count() > context_max {
            return Err(format!("the --context-file blocks are {} chars together, over the {} char cap: pass fewer or shorter files", context_blocks.chars().count(), context_max));
        }
        let brief_block = if req.get("brief").and_then(Value::as_bool).unwrap_or(false) {
            format!("{}\n\n", wrap_brief(&raw_task)?)
        } else {
            String::new()
        };
        if raw_task.chars().count() > context_max {
            return Err(format!("the task is {} chars, over the {} char cap: put the detail in --context-file or the shared context/ folder, or `agent send` it in parts", raw_task.chars().count(), context_max));
        }
        let shared_note = shared_context_note(&self.context_dir);
        let skills: Vec<String> = req.get("skills").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
        let (task, used, missing) = expand_skills(&raw_task, &skills, &[]);
        if !missing.is_empty() {
            return Err(format!("unknown skill{}: {}", if missing.len() > 1 { "s" } else { "" }, missing.join(", ")));
        }
        let cwd = {
            let c = s(req, "cwd");
            if c.is_empty() { std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default() } else { c }
        };
        if !Path::new(&cwd).is_dir() {
            return Err(format!("--cwd {cwd} is not a folder"));
        }
        let max_steps = req.get("max_steps").and_then(Value::as_i64).unwrap_or(DEFAULT_MAX_STEPS);
        let mut cost_limit = req.get("cost_limit").and_then(Value::as_f64).unwrap_or(DEFAULT_COST_LIMIT);
        let mut capped = String::new();
        if self.parent_limit > 0.0 {
            let left = self.parent_limit - self.parent_cost - self.children.iter().map(Child::total_cost).sum::<f64>();
            if left <= 0.0 {
                return Err(format!("this session's cost limit (${:.2}) is spent, subagents included", self.parent_limit));
            }
            if cost_limit <= 0.0 || cost_limit > left {
                cost_limit = left;
                capped = format!(" (budget capped to the ${left:.2} this session has left)");
            }
        }
        let mut model = s(req, "model");
        if model.is_empty() {
            model = self.parent_model.clone();
        }
        let dir = self.dir.join(&name);
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        let mut child = Child {
            name: name.clone(),
            task: raw_task.clone(),
            cwd: cwd.clone(),
            model: model.clone(),
            skills: used.clone(),
            traj: dir.join("traj.json"),
            journal: dir.join("traj.jsonl"),
            control: dir.join("control"),
            log: dir.join("agent.log"),
            dir,
            proc: None,
            pid: 0,
            state: "starting".into(),
            exit_status: String::new(),
            submission: String::new(),
            exit_text: String::new(),
            last_text: String::new(),
            last_command: String::new(),
            steps: 0,
            calls: 0,
            cost: 0.0,
            cost_before: 0.0,
            turns: 0,
            started_at: now(),
            last_activity: now(),
            max_steps,
            cost_limit,
            offset: 0,
            partial: String::new(),
            stall_reported: false,
            stop_requested: false,
            exit_code: None,
            replaying: false,
            resume_task: String::new(),
            turns_seen: 0,
            mem_rss: 0,
            mem_avg: 0,
            mem_peak: 0,
        };
        let full_task = format!("{context_blocks}{brief_block}{task}\n\n{shared_note}");
        // The assembled message has a cap of its own: pieces capped one by one could still add up.
        if full_task.chars().count() > 2 * context_max {
            return Err(format!(
                "the child's message is {} chars together, over the {} char cap (2 x MINI_AGENT_CONTEXT_MAX): trim the context files or the task",
                full_task.chars().count(),
                2 * context_max
            ));
        }
        let fork_label = fork.as_ref().map(|(_, l, _)| l.clone());
        let mut resume = None;
        if let Some((msgs, label, k)) = fork {
            // Like the `send` restart: the seeded history is replayed into the child's own journal,
            // so every later turn continues it with everything in between.
            let path = child.dir.join("fork.json");
            let seeded = json!({ "messages": fork_messages(&label, &msgs, k, 2 * context_max) });
            std::fs::write(&path, serde_json::to_string(&seeded).unwrap()).map_err(|e| format!("{}: {e}", path.display()))?;
            child.replaying = true;
            child.resume_task = full_task.clone();
            resume = Some(path);
        }
        self.launcher().exec(&mut child, &full_task, resume.as_deref())?;
        let pid = child.pid;
        self.children.push(child);
        self.write_index();
        let skills_note = if used.is_empty() { String::new() } else { format!(" · skills: {}", used.join(", ")) };
        let fork_note = fork_label.map(|l| format!(" · forked from {l}")).unwrap_or_default();
        Ok(format!("started subagent {name} (pid {pid}) in {cwd}{skills_note}{fork_note}{capped}\nYou will be told when it finishes; meanwhile keep working, or `agent wait {name}`."))
    }

    /// A short fingerprint of everything a UI shows about the children, `idle_s` left out (it moves
    /// every tick). Two identical keys mean the roster on disk is already current.
    fn roster_key(&self) -> String {
        let mut key = String::with_capacity(64 * self.children.len());
        if let Some(plan) = &self.plan {
            for t in &plan.tasks {
                use std::fmt::Write as _;
                let _ = write!(key, "{}|{}|", t.id, t.status);
            }
        }
        for c in self.children.iter() {
            use std::fmt::Write as _;
            let _ = write!(
                key,
                "{}|{}|{}|{}|{:.4}|{}|{}|{}|{}|{}|{}|",
                c.name,
                c.state,
                c.exit_status,
                c.steps,
                c.total_cost(),
                c.calls,
                c.turns,
                c.pid,
                c.mem_rss,
                c.mem_avg,
                c.mem_peak,
            );
        }
        key
    }

    fn launcher(&self) -> Launcher {
        Launcher { exe: self.exe.clone(), configs: self.configs.clone(), socket: self.socket.clone(), depth: self.depth, context_dir: self.context_dir.clone() }
    }

    /// Live subagents: the ones a new spawn would have to share memory with.
    fn live_count(&self) -> u64 {
        self.children.iter().filter(|c| c.proc.is_some()).count() as u64
    }

    /// The resource report `agent resources` shows, and the calculation `spawn` enforces.
    fn resources_report(&mut self) -> resources::Report {
        let (avail, total) = resources::meminfo().unwrap_or((0, 0));
        let (l1, _, _) = resources::loadavg();
        let live = self.live_count();
        let report = resources::snapshot(Some(avail), Some(total), resources::cpu_count(), l1, &self.usage, live);
        // Carry the per-child averages onto the children the UIs list.
        for c in self.children.iter_mut() {
            if let Some(u) = self.usage.get(&c.name) {
                c.mem_avg = u.avg_rss_mb;
                c.mem_peak = u.peak_rss_mb;
            }
        }
        report
    }

    /// How many more subagents may start now, by the reserve-memory and CPU calculus.
    fn fanout_left(&mut self) -> u64 {
        self.resources_report().max_fanout
    }
}

/// What starting a child needs from the hub (cloned, so a child can be borrowed mutably).
struct Launcher {
    exe: PathBuf,
    configs: Vec<String>,
    socket: PathBuf,
    depth: u32,
    /// The run tree's shared state dir, passed down so grandchildren share it too.
    context_dir: PathBuf,
}

impl Launcher {
    /// Start (or restart from its saved conversation) a child's process.
    fn exec(&self, c: &mut Child, task: &str, resume: Option<&Path>) -> Result<(), String> {
        use std::os::unix::process::CommandExt;
        std::fs::write(&c.control, "").map_err(|e| e.to_string())?;
        let log = std::fs::OpenOptions::new().create(true).append(true).open(&c.log).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&self.exe);
        cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(&c.traj);
        for spec in &self.configs {
            cmd.arg("-c").arg(spec);
        }
        // Tests (and power users) can give children a config of their own.
        if let Ok(extra) = std::env::var("MINI_AGENT_CHILD_CONFIG") {
            for spec in extra.split(':').filter(|s| !s.is_empty()) {
                let named = spec.replace("{name}", &c.name);
                if Path::new(&named).exists() || named.contains('=') {
                    cmd.arg("-c").arg(named);
                }
            }
        }
        cmd.arg("-c").arg(format!("agent.step_limit={}", c.max_steps));
        if c.cost_limit > 0.0 {
            cmd.arg("-l").arg(format!("{}", c.cost_limit));
        }
        if !c.model.is_empty() {
            cmd.arg("-m").arg(&c.model);
        }
        if let Some(r) = resume {
            cmd.arg("--resume").arg(r);
        }
        cmd.arg("-t").arg(task);
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("MSWEA_CONTROL_FILE", &c.control)
            .env("MSWEA_SILENT_STARTUP", "1")
            .env("MINI_AGENT_PARENT_SOCKET", &self.socket)
            .env("MINI_AGENT_NAME", &c.name)
            .env("MINI_AGENT_DEPTH", (self.depth + 1).to_string())
            .env("MINI_AGENT_CONTEXT_DIR", &self.context_dir)
            .env("PATH", path)
            .env_remove("MINI_AGENT_SOCKET")
            .current_dir(&c.cwd)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .process_group(0);
        let proc = cmd.spawn().map_err(|e| format!("could not start the subagent: {e}"))?;
        c.pid = proc.id() as i32;
        crate::e2e::worker::register(c.pid);
        c.proc = Some(proc);
        c.state = "starting".into();
        c.exit_code = None;
        c.stall_reported = false;
        c.last_activity = now();
        Ok(())
    }
}

impl Hub {
    fn send(&mut self, req: &Value) -> Result<String, String> {
        let name = s(req, "name");
        let text = s(req, "text");
        if text.trim().is_empty() {
            return Err("send needs a message".into());
        }
        let steps = req.get("steps").and_then(Value::as_i64);
        let cost = req.get("cost").and_then(Value::as_f64);
        let parent_left = if self.parent_limit > 0.0 {
            Some(self.parent_limit - self.parent_cost - self.children.iter().map(Child::total_cost).sum::<f64>())
        } else {
            None
        };
        let launcher = self.launcher();
        let c = self.child(&name)?;
        let (expanded, used, _) = expand_skills(&text, &[], &c.skills);
        c.skills.extend(used);
        // After LimitsExceeded the child would stop again at once: give it another turn's budget.
        let limited = (c.exit_status == "LimitsExceeded" || c.exit_status == "TimeExceeded") && !c.running();
        let add_steps = steps.or(if limited { Some(c.max_steps) } else { None });
        let mut add_cost = cost.or(if limited { Some(c.cost_limit) } else { None });
        if let (Some(x), Some(left)) = (add_cost, parent_left) {
            if left <= 0.0 {
                return Err("this session's cost limit is spent, subagents included".into());
            }
            add_cost = Some(x.min(left));
        }
        if c.proc.is_none() {
            // Its process is gone (stopped, crashed, or the session restarted): continue it from
            // its own saved conversation, under the same name.
            let messages = read_messages(&c.journal);
            if messages.is_empty() {
                return Err(format!("{name} saved no conversation to continue: spawn it again with --force"));
            }
            let resume = c.dir.join("resume.json");
            std::fs::write(&resume, json!({"messages": messages}).to_string()).map_err(|e| e.to_string())?;
            // The new process rewrites the journal from the replayed messages. Reading on from the
            // old file's end could land mid-way through the new one and miss its new task: start
            // from an empty file instead (the conversation is in resume.json and replayed).
            let _ = std::fs::remove_file(&c.journal);
            c.cost_before += c.cost;
            c.cost = 0.0;
            c.offset = 0;
            c.partial.clear();
            c.exit_status.clear();
            c.submission.clear();
            c.replaying = true;
            c.resume_task = expanded.clone();
            if let Some(n) = add_steps {
                c.max_steps = n.max(1);
            }
            if let Some(x) = add_cost {
                c.cost_limit = x;
            }
            launcher.exec(c, &expanded, Some(&resume))?;
            c.state = "running".into();
            return Ok(format!("{name} had exited: restarted it on its saved conversation, with your message"));
        }
        if let Some(n) = add_steps {
            c.control_line(&format!("STEPS {n}"))?;
        }
        if let Some(x) = add_cost {
            c.control_line(&format!("COST {x}"))?;
        }
        c.control_line(&format!("MESSAGE {}", serde_json::to_string(&expanded).unwrap()))?;
        let was = c.state.clone();
        c.state = "running".into();
        c.stall_reported = false;
        c.last_activity = now();
        Ok(if was == "waiting" {
            format!("sent: {name} continues with its full context")
        } else {
            format!("sent: {name} reads it before its next step")
        })
    }

}

/// Is `m` the new-task message for `task` (the agent prefixes it)?
fn line_is_last_task(m: &Value, task: &str) -> bool {
    content_text(m).ends_with(task.trim_end()) || task.is_empty()
}

fn finished_note(c: &Child) -> String {
    let answer = if !c.submission.trim().is_empty() { c.submission.clone() } else if !c.exit_text.trim().is_empty() { c.exit_text.clone() } else { c.last_text.clone() };
    let head = format!(
        "[subagent {}] finished its turn: {} · {} steps · ${:.4}",
        c.name,
        if c.exit_status.is_empty() { "done" } else { &c.exit_status },
        c.steps,
        c.total_cost()
    );
    let hint = match c.exit_status.as_str() {
        "ProviderAbortError" | "AuthenticationError" | "PermissionDeniedError" => format!(
            "The provider refused the call: retrying will not help. Fix the account or key, or continue it on another model: `agent model {} <model>` then `agent send {} \"continue\"`.",
            c.name, c.name
        ),
        "LimitsExceeded" | "TimeExceeded" => format!("It hit its limits before finishing. `agent send {} \"continue\"` gives it another budget with its full context.", c.name),
        "Submitted" | "" => format!("It holds its context: `agent send {} \"…\"` continues it.", c.name),
        _ => format!("`agent tail {}` shows what happened; `agent send {} \"…\"` continues it.", c.name, c.name),
    };
    format!("{head}\n{}\n{hint}", head_chars(&answer, 3000))
}

fn s(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

fn content_text(m: &Value) -> String {
    match m.get("content") {
        Some(Value::String(t)) => t.clone(),
        Some(Value::Array(parts)) => parts.iter().filter_map(|p| p.get("text").and_then(Value::as_str)).collect::<Vec<_>>().join("\n"),
        _ => String::new(),
    }
}

fn read_new(journal: &Path, offset: &mut u64, partial: &mut String) -> Vec<Value> {
    let Ok(mut f) = std::fs::File::open(journal) else { return vec![] };
    let len = f.metadata().map(|m| m.len()).unwrap_or(0);
    if len < *offset {
        *offset = 0;
        partial.clear();
    }
    if len == *offset || f.seek(SeekFrom::Start(*offset)).is_err() {
        return vec![];
    }
    let mut buf = Vec::new();
    let n = f.read_to_end(&mut buf).unwrap_or(0);
    *offset += n as u64;
    partial.push_str(&String::from_utf8_lossy(&buf));
    let mut out = vec![];
    while let Some(i) = partial.find('\n') {
        let line: String = partial.drain(..=i).collect();
        if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
            out.push(v);
        }
    }
    out
}

/// The conversation in a journal (the messages a resumed run starts from; exits dropped).
fn read_messages(journal: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(journal) else { return vec![] };
    let mut msgs = vec![];
    for line in text.lines() {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            match v.get("t").and_then(Value::as_str) {
                Some("meta") => msgs.clear(), // a rewrite starts over
                Some("msg") => msgs.push(v["m"].clone()),
                _ => {}
            }
        }
    }
    msgs.retain(|m| m.get("role").and_then(Value::as_str) != Some("exit"));
    msgs
}

// ---- the plan scheduler (Fase 2) ----------------------------------------------------------

/// The plan of a previous run of this session (`<traj dir>/subagents/plan.json`), if valid.
fn load_plan(dir: &Path) -> Option<Plan> {
    let text = std::fs::read_to_string(dir.join("plan.json")).ok()?;
    let v: Value = serde_json::from_str(&text).ok()?;
    Plan::parse(&v).ok()
}

impl Hub {
    fn write_plan(&mut self) {
        let Some(plan) = &self.plan else { return };
        let v = json!({
            "tasks": plan.tasks.iter().map(|t| t.to_value()).collect::<Vec<_>>(),
            "updated_at": now(),
        });
        let _ = std::fs::create_dir_all(&self.dir);
        let tmp = self.dir.join("plan.json.tmp");
        if std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap()).is_ok() {
            let _ = std::fs::rename(&tmp, self.dir.join("plan.json"));
        }
    }

    /// The scheduler: advance task states from what the children did, then launch whatever is
    /// ready. It runs on every monitor tick, so a successor starts the moment its deps are
    /// satisfied — even while the parent is in another turn or asleep.
    fn tick_plan(&mut self) {
        if self.plan.is_none() {
            return;
        }
        let mut notes: Vec<String> = vec![];
        // 1. A running task whose child ended: review (a finished turn) or failed.
        let mut transitions: Vec<(String, String, String)> = vec![];
        {
            let plan = self.plan.as_ref().unwrap();
            for t in plan.tasks.iter().filter(|t| t.status == "running") {
                let Some(c) = self.children.iter().find(|c| c.name == t.id) else {
                    // A running task without a child: the session restarted from a plan.json left
                    // behind. Fail it (its dependents block) so `plan retry` can recover it.
                    transitions.push((t.id.clone(), "failed".into(), "its subagent is gone (was the session restarted?)".into()));
                    continue;
                };
                if c.running() {
                    continue;
                }
                if c.turns < 1 {
                    if c.state == "exited" || c.state == "stopped" {
                        transitions.push((t.id.clone(), "failed".into(), "it ended before finishing a turn".into()));
                    }
                    continue;
                }
                let answer = if !c.submission.trim().is_empty() {
                    c.submission.clone()
                } else if !c.exit_text.trim().is_empty() {
                    c.exit_text.clone()
                } else {
                    c.last_text.clone()
                };
                match (c.state.as_str(), c.exit_status.as_str()) {
                    ("waiting", "Submitted") => transitions.push((t.id.clone(), "review".into(), answer)),
                    ("waiting", status) => transitions.push((t.id.clone(), "failed".into(), format!("{status}: {answer}"))),
                    ("stopped", _) => transitions.push((t.id.clone(), "failed".into(), "stopped by the session".into())),
                    _ => transitions.push((t.id.clone(), "failed".into(), "its process ended unexpectedly".into())),
                }
            }
        }
        for (id, status, result) in transitions {
            let succ = self.plan.as_ref().unwrap().successors(&id);
            if let Some(t) = self.plan.as_mut().unwrap().get_mut(&id) {
                t.status = status.clone();
                t.result = result.clone();
                if status == "failed" {
                    t.error = result.clone();
                }
            }
            if status == "review" {
                let next = if succ.is_empty() { String::new() } else { format!(" -> launching {}", succ.join(", ")) };
                notes.push(format!("[plan] {id} finished (review){next} · {}", head_chars(&result, 400)));
            } else {
                notes.push(format!("[plan] {id} failed: {} · its dependents are blocked. `agent plan retry {id}` or re-plan (`agent plan add`).", head_chars(&result, 400)));
            }
        }
        // 2. A pending task whose dep failed or is blocked goes blocked (once).
        let mut blocked: Vec<String> = vec![];
        {
            let plan = self.plan.as_ref().unwrap();
            for t in plan.tasks.iter().filter(|t| t.status == "pending") {
                let dead = |d: &str| plan.get(d).map(|x| matches!(x.status.as_str(), "failed" | "blocked")).unwrap_or(false);
                if t.deps.iter().any(|d| dead(d)) {
                    blocked.push(t.id.clone());
                }
            }
        }
        for id in &blocked {
            if let Some(t) = self.plan.as_mut().unwrap().get_mut(id) {
                t.status = "blocked".into();
                t.error = "a dependency failed".into();
            }
        }
        // 3. Launch every ready task while there is room: the queue waits, it is not a failure.
        loop {
            let ready = self.plan.as_ref().unwrap().ready();
            let Some(id) = ready.first().cloned() else { break };
            if self.children.iter().any(|c| c.name == id && c.running()) {
                break; // a child of that name is still working on a turn; retry next tick
            }
            let max_live = env_num("MINI_AGENT_MAX_SUBAGENTS", 100).min(100);
            let live = self.children.iter().filter(|c| c.proc.is_some()).count();
            if live >= max_live || self.fanout_left() == 0 {
                break; // no room now: the ready queue keeps them, retried on the next tick
            }
            let t = self.plan.as_ref().unwrap().get(&id).cloned().unwrap();
            let req = self.plan_spawn_req(&t);
            match self.launch(&req) {
                Ok(_) => {
                    if let Some(t) = self.plan.as_mut().unwrap().get_mut(&id) {
                        t.status = "running".into();
                    }
                    let why = if t.deps.is_empty() { String::new() } else { format!(" (deps satisfied: {})", t.deps.join(", ")) };
                    notes.push(format!("[plan] {id} launched{why}"));
                }
                Err(e) => {
                    // Room problems stay in the queue; anything else is the task's own error.
                    if e.contains("refusing subagent") || e.contains("already alive") || e.contains("cost limit") {
                        break;
                    }
                    if let Some(t) = self.plan.as_mut().unwrap().get_mut(&id) {
                        t.status = "failed".into();
                        t.error = e.clone();
                    }
                    notes.push(format!("[plan] {id} could not start: {e}"));
                }
            }
        }
        self.notes.extend(notes.into_iter().map(|t| (String::new(), 0, t)));
        if self.plan.is_some() {
            self.write_plan();
        }
    }

    /// The spawn request of a plan task: its text plus the handoff of its deps (results and the
    /// artifacts they committed to), under the task's own budget.
    fn plan_spawn_req(&self, t: &Task) -> Value {
        let cap: usize = env_num("MINI_AGENT_CONTEXT_MAX", 32 * 1024);
        let mut handoff = String::new();
        for d in &t.deps {
            let Some(dep) = self.plan.as_ref().and_then(|p| p.get(d)) else { continue };
            handoff.push_str(&format!("<handoff from=\"{d}\" status=\"{}\">\n", dep.status));
            if !dep.result.is_empty() {
                handoff.push_str(&format!("{}\u{2019}s result:\n{}\n", d, head_chars(&dep.result, 2000)));
            }
            for a in &dep.artifacts {
                let raw = Path::new(a);
                let path = if raw.is_absolute() { raw.to_path_buf() } else { std::env::current_dir().unwrap_or_default().join(raw) };
                match std::fs::read_to_string(&path) {
                    Ok(body) => handoff.push_str(&format!("artifact {a}:\n<file>\n{}\n</file>\n", head_chars(&body, cap))),
                    Err(e) => handoff.push_str(&format!("artifact {a}: not readable ({e})\n")),
                }
            }
            handoff.push_str("</handoff>\n\n");
        }
        let task = if handoff.is_empty() { t.task.clone() } else { format!("{handoff}{}", t.task) };
        let mut req = json!({"cmd": "spawn", "name": t.id, "task": task, "force": true});
        if t.steps > 0 {
            req["max_steps"] = json!(t.steps);
        }
        if t.cost > 0.0 {
            req["cost_limit"] = json!(t.cost);
        }
        req
    }

    /// `agent plan …`: submit a DAG, re-plan in flight, inspect, review, retry.
    fn plan_cmd(&mut self, req: &Value) -> Result<Value, String> {
        let action = s(req, "action");
        let mut changed = false;
        let out = match action.as_str() {
            "submit" => {
                let v = req.get("plan").cloned().ok_or("plan submit needs --file plan.json")?;
                let plan = Plan::parse(&v)?;
                if let Some(cur) = &self.plan {
                    if cur.tasks.iter().any(|t| matches!(t.status.as_str(), "pending" | "running" | "review")) {
                        return Err("a plan is already active (`agent plan show`); `agent plan rm` what is left or let it finish".into());
                    }
                }
                let n = plan.tasks.len();
                self.plan = Some(plan);
                changed = true;
                ok(format!("plan accepted: {n} tasks. The hub launches each one the moment its deps are satisfied; you review the results (`agent plan review`)."), json!(null))
            }
            "add" => {
                let id = s(req, "id");
                if id.is_empty() {
                    return Err("plan add needs a task id".into());
                }
                let task = s(req, "task");
                if task.trim().is_empty() {
                    return Err(format!("plan add {id}: needs a task (text or --task-file)"));
                }
                let mut item = json!({"id": id, "task": task});
                let title = s(req, "title");
                if !title.is_empty() {
                    item["title"] = json!(title);
                }
                let group = s(req, "group");
                if !group.is_empty() {
                    item["group"] = json!(group);
                }
                if let Some(p) = req.get("priority").and_then(Value::as_i64) {
                    item["priority"] = json!(p);
                }
                let mut budget = json!({});
                if let Some(n) = req.get("steps").and_then(Value::as_i64) {
                    budget["steps"] = json!(n);
                }
                if let Some(c) = req.get("cost").and_then(Value::as_f64) {
                    budget["cost"] = json!(c);
                }
                if budget.as_object().map(|o| !o.is_empty()).unwrap_or(false) {
                    item["budget"] = budget;
                }
                if let Some(a) = req.get("artifacts").and_then(Value::as_array) {
                    item["artifacts"] = json!(a);
                }
                item["deps"] = json!(csv_list(&s(req, "deps")));
                let mut tasks: Vec<Value> = self.plan.as_ref().map(|p| p.tasks.iter().map(|t| t.to_value()).collect()).unwrap_or_default();
                if tasks.iter().any(|t| t["id"] == item["id"]) {
                    return Err(format!("a task named {id} already exists (`agent plan rm {id}` first)"));
                }
                tasks.push(item);
                self.plan = Some(Plan::parse(&json!({"tasks": tasks}))?);
                changed = true;
                ok(format!("task {id} added"), json!(null))
            }
            "rm" => {
                let ids: Vec<String> = req.get("ids").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
                if ids.is_empty() {
                    return Err("plan rm needs task ids".into());
                }
                let plan = self.plan.as_mut().ok_or("there is no plan")?;
                for id in &ids {
                    let t = plan.get(id).ok_or(format!("no task {id}"))?;
                    if t.status == "running" {
                        return Err(format!("{id} is running (`agent stop {id}` first)"));
                    }
                    let dependents = plan.successors(id);
                    if !dependents.is_empty() {
                        return Err(format!("cannot rm {id}: {} depends on it (rm those first, or `agent plan dep <id> {id} --rm`)", dependents.join(", ")));
                    }
                }
                plan.tasks.retain(|t| !ids.contains(&t.id));
                if plan.tasks.is_empty() {
                    self.plan = None;
                    let _ = std::fs::remove_file(self.dir.join("plan.json"));
                } else {
                    self.plan = Some(plan.clone());
                }
                changed = self.plan.is_some();
                ok(format!("removed {}", ids.join(", ")), json!(null))
            }
            "dep" => {
                let id = s(req, "id");
                let deps: Vec<String> = req.get("deps").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
                let mut tasks: Vec<Value> = self.plan.as_ref().map(|p| p.tasks.iter().map(|t| t.to_value()).collect()).ok_or("there is no plan")?;
                for item in tasks.iter_mut() {
                    if item["id"] != id {
                        continue;
                    }
                    let mut have: Vec<String> = item["deps"].as_array().map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
                    if req.get("rm").and_then(Value::as_bool).unwrap_or(false) {
                        have.retain(|d| !deps.contains(d));
                    } else {
                        for d in &deps {
                            if !have.contains(d) {
                                have.push(d.clone());
                            }
                        }
                    }
                    item["deps"] = json!(have);
                }
                if !tasks.iter().any(|t| t["id"] == id) {
                    return Err(format!("no task {id}"));
                }
                self.plan = Some(Plan::parse(&json!({"tasks": tasks}))?);
                changed = true;
                ok(format!("dependencies of {id} updated"), json!(null))
            }
            "review" => {
                let id = s(req, "id");
                let verdict = s(req, "verdict");
                let reason = s(req, "reason");
                let plan = self.plan.as_mut().ok_or("there is no plan")?;
                let t = plan.get_mut(&id).ok_or(format!("no task {id}"))?;
                match verdict.as_str() {
                    "ok" => {
                        if !SATISFIED.contains(&t.status.as_str()) {
                            return Err(format!("{id} is {status}: only a finished task can be reviewed (`agent plan show`)", status = t.status));
                        }
                        t.status = "done".into();
                        changed = true;
                        ok(format!("{id}: done"), json!(null))
                    }
                    "fail" => {
                        if t.status == "running" {
                            return Err(format!("{id} is running: `agent stop {id}` first, then review fail"));
                        }
                        t.status = "failed".into();
                        t.error = if reason.is_empty() { "the review rejected it".into() } else { reason };
                        changed = true;
                        ok(format!("{id}: failed, dependents are blocked"), json!(null))
                    }
                    other => return Err(format!("plan review needs ok or fail (got {other:?})")),
                }
            }
            "retry" => {
                let id = s(req, "id");
                let plan = self.plan.as_mut().ok_or("there is no plan")?;
                let t = plan.get_mut(&id).ok_or(format!("no task {id}"))?;
                if !matches!(t.status.as_str(), "failed" | "blocked") {
                    return Err(format!("{id} is {} (only failed/blocked tasks can be retried)", t.status));
                }
                t.status = "pending".into();
                t.error.clear();
                t.result.clear();
                changed = true;
                ok(format!("{id}: back to pending; it launches when its deps allow"), json!(null))
            }
            "show" => {
                let plan = self.plan.as_ref().ok_or("there is no plan (`agent plan submit --file plan.json`")?;
                let ready = plan.ready();
                let mut out = String::new();
                for t in &plan.tasks {
                    out.push_str(&format!("{:<10} {:<9} deps={} · {}\n", t.id, t.status, if t.deps.is_empty() { "-".into() } else { t.deps.join(",") }, first_line(&t.title, 60)));
                    if !t.result.is_empty() {
                        out.push_str(&format!("    result: {}\n", first_line(&t.result, 120)));
                    }
                    if !t.error.is_empty() {
                        out.push_str(&format!("    error: {}\n", first_line(&t.error, 120)));
                    }
                }
                out.push_str(&format!("ready queue: {}\n", if ready.is_empty() { "(empty)".into() } else { ready.join(", ") }));
                let v = json!({"tasks": plan.tasks.iter().map(|t| t.to_value()).collect::<Vec<_>>(), "ready": ready});
                ok(out, v)
            }
            "graph" => {
                let plan = self.plan.as_ref().ok_or("there is no plan")?;
                ok(plan.graph(), json!({"edges": plan.tasks.iter().flat_map(|t| t.deps.iter().map(|d| json!({"from": d, "to": t.id})).collect::<Vec<_>>()).collect::<Vec<_>>()}))
            }
            other => return Err(format!("plan {other:?}: submit/add/rm/dep/show/graph/review/retry")),
        };
        if changed {
            self.write_plan();
        }
        Ok(out)
    }
}

/// `"a, b ,c"` -> `["a","b","c"]`.
fn csv_list(s: &str) -> Vec<String> {
    s.split(',').map(|x| x.trim().to_string()).filter(|x| !x.is_empty()).collect()
}

// ---- the socket ------------------------------------------------------------------------

fn serve(hub: Arc<Mutex<Hub>>, stream: UnixStream) {
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    let mut line = String::new();
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let req: Value = serde_json::from_str(&line).unwrap_or(json!({}));
    let reply = handle(&hub, &req);
    let mut stream = stream;
    let _ = writeln!(stream, "{}", reply);
}

fn ok(output: String, data: Value) -> Value {
    json!({"ok": true, "output": output, "data": data})
}

fn handle(hub: &Arc<Mutex<Hub>>, req: &Value) -> Value {
    let cmd = s(req, "cmd");
    if cmd == "wait" {
        return wait(hub, req);
    }
    let Ok(mut h) = hub.lock() else { return json!({"ok": false, "output": "the hub is unavailable"}) };
    h.monitor();
    let r: Result<Value, String> = match cmd.as_str() {
        "spawn" => h.launch(req).map(|o| ok(o, json!(null))),
        "plan" => h.plan_cmd(req),
        "send" => h.send(req).map(|o| ok(o, json!(null))),
        "model" => {
            let model = s(req, "model");
            h.child(&s(req, "name")).and_then(|c| {
                if c.proc.is_none() {
                    c.model = model.clone();
                    return Ok(ok(format!("{} will run on {model} when it continues", c.name), json!(null)));
                }
                c.control_line(&format!("MODEL {model}"))?;
                c.model = model.clone();
                Ok(ok(format!("{} switches to {model} from its next step", c.name), json!(null)))
            })
        }
        "ls" => {
            let rows: Vec<Value> = h.children.iter().map(Child::summary).collect();
            Ok(ok(table(&h.children), Value::Array(rows)))
        }
        // The numbers a fan-out must be planned around: free memory, the average cost of a running
        // subagent, and how many more may start (memory, then CPU, then the cap of 100).
        "resources" => {
            let r = h.resources_report();
            Ok(if req.get("json").and_then(Value::as_bool).unwrap_or(false) {
                ok(String::new(), r.to_value())
            } else {
                ok(r.text(), r.to_value())
            })
        }
        // A plan that asks for N children at once takes all of them or none: reserve N.
        "can-spawn" => {
            let n = req.get("n").and_then(Value::as_u64).unwrap_or(1).max(1);
            let free = h.fanout_left();
            let live = h.live_count();
            let r = h.resources_report();
            let head = if free >= n { format!("room for {n} more: {free} fit in the free memory now") } else {
                format!("room for {free} more, {n} asked: spawn {free} now and the rest as these finish")
            };
            Ok(ok(head, json!({"fits": free >= n, "max_fanout": free, "requested": n, "live": live, "resources": r.to_value()})))
        }
        "status" => h.child(&s(req, "name")).map(|c| {
            let v = c.summary();
            let mut out = serde_json::to_string_pretty(&v).unwrap();
            if !c.submission.is_empty() {
                out.push_str(&format!("\n\nresult:\n{}", head_chars(&c.submission, 4000)));
            }
            ok(out, v)
        }),
        "result" => {
            let name = s(req, "name");
            let r = h.child(&name).and_then(|c| {
                if c.turns == 0 {
                    return Err(format!("{} has not finished a turn yet ({}): `agent wait {}`", c.name, c.state, c.name));
                }
                let answer = if !c.submission.trim().is_empty() { c.submission.clone() } else if !c.exit_text.trim().is_empty() && c.exit_status != "Submitted" { format!("{}: {}", c.exit_status, c.exit_text) } else { c.last_text.clone() };
                Ok(ok(answer, json!({"exit_status": c.exit_status, "state": c.state})))
            });
            if r.is_ok() && !h.child(&name).map(|c| c.running()).unwrap_or(true) {
                h.mark_seen(&[name]);
            }
            r
        }
        "tail" => h.child(&s(req, "name")).map(|c| {
            let n = req.get("n").and_then(Value::as_u64).unwrap_or(10) as usize;
            ok(tail(&c.journal, n), json!(null))
        }),
        "stop" => {
            let names: Vec<String> = if req.get("all").and_then(Value::as_bool).unwrap_or(false) {
                h.children.iter().map(|c| c.name.clone()).collect()
            } else {
                req.get("names").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default()
            };
            if names.is_empty() {
                Err("stop needs subagent names or --all".into())
            } else {
                let mut out = vec![];
                let mut err = None;
                for n in names {
                    match h.child(&n) {
                        Ok(c) => {
                            if c.proc.is_some() && c.running() {
                                c.stop_requested = true;
                                unsafe {
                                    libc::killpg(c.pid, libc::SIGINT);
                                }
                                out.push(format!("{n}: interrupted (it saves; `agent send {n} …` continues it)"));
                            } else if c.proc.is_some() {
                                // Waiting at its exit: let its process go, its conversation is saved.
                                c.stop_requested = true;
                                unsafe {
                                    libc::killpg(c.pid, libc::SIGINT);
                                }
                                out.push(format!("{n}: released (it was waiting)"));
                            } else {
                                out.push(format!("{n}: already {}", c.state));
                            }
                        }
                        Err(e) => err = Some(e),
                    }
                }
                match err {
                    Some(e) if out.is_empty() => Err(e),
                    _ => Ok(ok(out.join("\n"), json!(null))),
                }
            }
        }
        "note" => {
            let from = s(req, "from");
            let text = s(req, "text");
            h.note(format!("[subagent {from}] says: {}", head_chars(&text, 4000)));
            Ok(ok("delivered: the session that started you reads it before its next step".into(), json!(null)))
        }
        "" => Err("empty request".into()),
        other => Err(format!("unknown command {other:?}\n\n{HELP}")),
    };
    match r {
        Ok(v) => v,
        Err(e) => json!({"ok": false, "output": e}),
    }
}

fn wait(hub: &Arc<Mutex<Hub>>, req: &Value) -> Value {
    let names: Vec<String> = req.get("names").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
    let any = req.get("any").and_then(Value::as_bool).unwrap_or(false);
    let timeout = req.get("timeout").and_then(Value::as_f64).unwrap_or(20.0);
    let deadline = now() + timeout;
    loop {
        {
            let Ok(mut h) = hub.lock() else { return json!({"ok": false, "output": "the hub is unavailable"}) };
            h.monitor();
            let chosen: Vec<&Child> = if names.is_empty() { h.children.iter().collect() } else { h.children.iter().filter(|c| names.contains(&c.name)).collect() };
            if let Some(missing) = names.iter().find(|n| !h.children.iter().any(|c| &c.name == *n)) {
                return json!({"ok": false, "output": format!("no subagent named {missing}")});
            }
            if chosen.is_empty() {
                return json!({"ok": false, "output": "no subagents to wait for"});
            }
            let done = chosen.iter().filter(|c| !c.running()).count();
            let finished = if any { done > 0 } else { done == chosen.len() };
            if finished || now() >= deadline {
                let rows: Vec<String> = chosen
                    .iter()
                    .map(|c| {
                        let why = if !c.exit_status.is_empty() && c.exit_status != "Submitted" && !c.running() && !c.exit_text.trim().is_empty() { format!("\n  {}", head_chars(&c.exit_text, 300)) } else { String::new() };
                        format!("{}: {}{} · {} steps · ${:.4}{why}", c.name, c.state, if c.exit_status.is_empty() { String::new() } else { format!(" ({})", c.exit_status) }, c.steps, c.total_cost())
                    })
                    .collect();
                let head = if finished { "done" } else { "still running (timeout); you will be told when each one finishes" };
                let done_names: Vec<String> = chosen.iter().filter(|c| !c.running()).map(|c| c.name.clone()).collect();
                drop(chosen);
                if !done_names.is_empty() {
                    h.mark_seen(&done_names);
                }
                return json!({"ok": finished, "timeout": !finished, "output": format!("{head}\n{}", rows.join("\n"))});
            }
        }
        std::thread::sleep(Duration::from_millis(150));
    }
}

fn table(children: &[Child]) -> String {
    if children.is_empty() {
        return "no subagents".into();
    }
    let mut out = format!("{:<18} {:<9} {:>5} {:>8} {:>6}  {}\n", "NAME", "STATE", "STEPS", "COST", "IDLE", "LAST");
    for c in children {
        let state = if c.exit_status.is_empty() || c.running() { c.state.clone() } else { format!("{}*", c.state) };
        out.push_str(&format!(
            "{:<18} {:<9} {:>5} {:>8} {:>5}s  {}\n",
            first_line(&c.name, 18),
            state,
            c.steps,
            format!("${:.3}", c.total_cost()),
            (now() - c.last_activity).max(0.0) as i64,
            if c.running() { first_line(&c.last_command, 60) } else { first_line(if c.submission.is_empty() { &c.last_text } else { &c.submission }, 60) }
        ));
    }
    out.push_str("(* = its turn ended: see `agent result <name>`)");
    out
}

fn tail(journal: &Path, n: usize) -> String {
    let msgs = read_messages(journal);
    let mut lines = vec![];
    for m in msgs.iter().skip(1) {
        let role = m.get("role").and_then(Value::as_str).unwrap_or("");
        let text = content_text(m);
        match role {
            "assistant" => {
                if !text.trim().is_empty() {
                    lines.push(format!("assistant: {}", head_chars(&text, 400)));
                }
                for a in m.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default() {
                    if let Some(c) = a.get("command").and_then(Value::as_str) {
                        lines.push(format!("$ {}", head_chars(c, 300)));
                    }
                }
            }
            "tool" | "user" => {
                let rc = m.pointer("/extra/returncode").map(|v| format!(" [rc {v}]")).unwrap_or_default();
                lines.push(format!("{role}{rc}: {}", head_chars(&text, 300)));
            }
            _ => {}
        }
    }
    let start = lines.len().saturating_sub(n.max(1) * 2);
    if lines.is_empty() {
        "nothing yet".into()
    } else {
        lines[start..].join("\n")
    }
}

// ---- the client: `mini-agent-rs agent …` ---------------------------------------------------

fn request(socket: &str, req: &Value, timeout_s: u64) -> Result<Value, String> {
    let mut stream = UnixStream::connect(socket).map_err(|e| format!("cannot reach the session's agent ({socket}): {e}"))?;
    let _ = stream.set_read_timeout(Some(Duration::from_secs(timeout_s)));
    writeln!(stream, "{req}").map_err(|e| e.to_string())?;
    let mut line = String::new();
    BufReader::new(stream).read_line(&mut line).map_err(|e| e.to_string())?;
    serde_json::from_str(&line).map_err(|_| "no reply from the session's agent".to_string())
}

pub fn client(args: &[String]) -> i32 {
    let Some(cmd) = args.first().map(String::as_str) else {
        println!("{HELP}");
        return 0;
    };
    if matches!(cmd, "help" | "-h" | "--help") {
        println!("{HELP}");
        return 0;
    }
    // `orch` verbs keep working.
    let cmd = match cmd {
        "start" => "spawn",
        "followup" => "send",
        c => c,
    };
    let rest = &args[1..];
    let mut json_out = false;
    let mut req = json!({"cmd": cmd});
    let mut positional: Vec<String> = vec![];
    let mut skills: Vec<String> = vec![];
    let mut i = 0;
    let value = |i: &mut usize| -> Result<String, String> {
        *i += 1;
        rest.get(*i).cloned().ok_or_else(|| format!("{} needs a value", rest[*i - 1]))
    };
    let parsed: Result<(), String> = (|| {
        while i < rest.len() {
            let a = rest[i].as_str();
            match a {
                "--json" => json_out = true,
                "--any" => req["any"] = json!(true),
                "--all" => req["all"] = json!(true),
                "--force" => req["force"] = json!(true),
                "--cwd" => req["cwd"] = json!(std::fs::canonicalize(crate::config::expand_user(&value(&mut i)?)).map(|p| p.display().to_string()).map_err(|e| format!("--cwd: {e}"))?),
                "-m" | "--model" => req["model_opt"] = json!(value(&mut i)?),
                "--max-steps" | "--steps" => req[if a == "--steps" { "steps" } else { "max_steps" }] = json!(value(&mut i)?.parse::<i64>().map_err(|_| format!("{a} needs a number"))?),
                "--cost-limit" | "--cost" => req[if a == "--cost" { "cost" } else { "cost_limit" }] = json!(value(&mut i)?.parse::<f64>().map_err(|_| format!("{a} needs a number"))?),
                "--timeout" => req["timeout"] = json!(value(&mut i)?.parse::<f64>().map_err(|_| "--timeout needs seconds".to_string())?),
                "-n" => req["n"] = json!(value(&mut i)?.parse::<u64>().map_err(|_| "-n needs a number".to_string())?),
                "--skill" => skills.push(value(&mut i)?.trim_start_matches('$').to_string()),
                "--file" => req["file"] = json!(value(&mut i)?),
                "--deps" => req["deps"] = json!(value(&mut i)?),
                "--group" => req["group"] = json!(value(&mut i)?),
                "--title" => req["title"] = json!(value(&mut i)?),
                "--priority" => req["priority"] = json!(value(&mut i)?.parse::<i64>().map_err(|_| "--priority needs a number".to_string())?),
                "--artifact" => {
                    let a = value(&mut i)?;
                    match req.get("artifacts").and_then(Value::as_array) {
                        Some(v) => { let mut v = v.clone(); v.push(json!(a)); req["artifacts"] = json!(v); }
                        None => req["artifacts"] = json!([a]),
                    }
                }
                "--rm" => req["rm"] = json!(true),
                "--context-file" => {
                    let f = value(&mut i)?;
                    let canon = std::fs::canonicalize(crate::config::expand_user(&f)).map(|p| p.display().to_string()).map_err(|e| format!("--context-file {f}: {e}"))?;
                    match req.get("context_files").and_then(Value::as_array) {
                        Some(a) => { let mut a = a.clone(); a.push(json!(canon)); req["context_files"] = json!(a); }
                        None => req["context_files"] = json!([canon]),
                    }
                }
                "--brief" => req["brief"] = json!(true),
                "--fork" => req["fork"] = json!(true),
                "--fork-k" => req["fork_k"] = json!(value(&mut i)?.parse::<i64>().map_err(|_| "--fork-k needs a number".to_string())?),
                "--from" => {
                    req["from"] = json!(value(&mut i)?);
                    req["fork"] = json!(true); // naming a source implies the fork
                }
                "--prompt-file" | "--task-file" => {
                    let f = value(&mut i)?;
                    let text = if f == "-" {
                        let mut s = String::new();
                        std::io::stdin().read_to_string(&mut s).map_err(|e| e.to_string())?;
                        s
                    } else {
                        std::fs::read_to_string(crate::config::expand_user(&f)).map_err(|e| format!("{f}: {e}"))?
                    };
                    req["text_file"] = json!(text);
                }
                "--" => {
                    positional.extend(rest[i + 1..].iter().cloned());
                    break;
                }
                _ if a.starts_with("--") => return Err(format!("unknown option {a}")),
                _ => positional.push(a.to_string()),
            }
            i += 1;
        }
        Ok(())
    })();
    if let Err(e) = parsed {
        eprintln!("error: {e}\n\n{HELP}");
        return 2;
    }
    let file_text = req.get("text_file").and_then(Value::as_str).map(String::from);
    let joined = |from: usize| -> String { file_text.clone().unwrap_or_else(|| positional.get(from..).map(|p| p.join(" ")).unwrap_or_default()) };
    let need_name = |what: &str| -> Result<String, String> { positional.first().cloned().ok_or_else(|| format!("{what} needs a subagent name")) };
    let built: Result<(), String> = (|| {
        match cmd {
            "spawn" => {
                req["name"] = json!(need_name("spawn")?);
                req["task"] = json!(joined(1));
                req["skills"] = json!(skills);
                if let Some(m) = req.get("model_opt").cloned() {
                    req["model"] = m;
                }
            }
            "send" => {
                req["name"] = json!(need_name("send")?);
                req["text"] = json!(joined(1));
            }
            "model" => {
                req["name"] = json!(need_name("model")?);
                req["model"] = json!(positional.get(1).cloned().or_else(|| req.get("model_opt").and_then(Value::as_str).map(String::from)).ok_or("model needs a model name")?);
            }
            "status" | "result" | "tail" => req["name"] = json!(need_name(cmd)?),
            "plan" => {
                let action = positional.first().cloned().ok_or("plan needs an action: submit/add/rm/dep/show/graph/review/retry")?;
                req["action"] = json!(action.clone());
                match action.as_str() {
                    "submit" => {
                        let f = req.get("file").and_then(Value::as_str).map(String::from).ok_or("plan submit needs --file plan.json (or '-' for stdin)")?;
                        let text = if f == "-" {
                            let mut t = String::new();
                            std::io::stdin().read_to_string(&mut t).map_err(|e| e.to_string())?;
                            t
                        } else {
                            std::fs::read_to_string(crate::config::expand_user(&f)).map_err(|e| format!("{f}: {e}"))?
                        };
                        req["plan"] = serde_json::from_str(&text).map_err(|e| format!("{f}: {e}"))?;
                    }
                    "add" => {
                        req["id"] = json!(positional.get(1).cloned().ok_or("plan add needs a task id")?);
                        req["task"] = json!(file_text.clone().unwrap_or_else(|| positional.get(2..).map(|p| p.join(" ")).unwrap_or_default()));
                    }
                    "rm" => req["ids"] = json!(positional.get(1..).map(|p| p.to_vec()).unwrap_or_default()),
                    "retry" => req["id"] = json!(positional.get(1).cloned().ok_or("plan retry needs a task id")?),
                    "dep" => {
                        req["id"] = json!(positional.get(1).cloned().ok_or("plan dep needs a task id")?);
                        req["deps"] = json!(positional.get(2..).map(|p| p.to_vec()).unwrap_or_default());
                    }
                    "review" => {
                        req["id"] = json!(positional.get(1).cloned().ok_or("plan review needs a task id")?);
                        req["verdict"] = json!(positional.get(2).cloned().unwrap_or_default());
                        req["reason"] = json!(positional.get(3..).map(|p| p.join(" ")).unwrap_or_default());
                    }
                    "show" | "graph" => {}
                    other => return Err(format!("plan {other:?}: submit/add/rm/dep/show/graph/review/retry")),
                }
            }
            "wait" | "stop" => req["names"] = json!(positional),
            "ask" => {
                req["cmd"] = json!("note");
                req["from"] = json!(std::env::var("MINI_AGENT_NAME").unwrap_or_else(|_| "?".into()));
                req["text"] = json!(joined(0));
                if joined(0).trim().is_empty() {
                    return Err("ask needs a message".into());
                }
            }
            "ls" => {}
            "resources" => {
                if let Some(n) = rest.iter().position(|a| a == "--json") { req["json"] = json!(true); let _ = n; }
                if let Some(v) = positional.first() {
                    return Err(format!("resources takes no argument (got {v:?})"));
                }
            }
            "can-spawn" => {
                let n = positional.first().cloned().ok_or("can-spawn needs a number of subagents")?;
                req["n"] = json!(n.parse::<u64>().map_err(|_| "can-spawn needs a number")?);
            }
            other => return Err(format!("unknown command {other:?}")),
        }
        Ok(())
    })();
    if let Err(e) = built {
        eprintln!("error: {e}\n\n{HELP}");
        return 2;
    }
    let socket_var = if cmd == "ask" { "MINI_AGENT_PARENT_SOCKET" } else { "MINI_AGENT_SOCKET" };
    let Some(socket) = std::env::var(socket_var).ok().filter(|s| !s.is_empty()) else {
        if cmd == "ask" {
            eprintln!("error: `agent ask` only works inside a subagent (no session started this one)");
        } else {
            eprintln!("error: no session agent to talk to (MINI_AGENT_SOCKET is not set). `agent` commands run from the bash tool of a mini-agent-rs session; the Python agent has no subagents (use orch).");
        }
        return 2;
    };
    let wait_s = req.get("timeout").and_then(Value::as_f64).unwrap_or(20.0) as u64 + 10;
    match request(&socket, &req, wait_s.max(30)) {
        Ok(v) => {
            let out = v.get("output").and_then(Value::as_str).unwrap_or("");
            if json_out {
                println!("{}", v.get("data").filter(|d| !d.is_null()).cloned().unwrap_or(v.clone()));
            } else if !out.is_empty() {
                println!("{out}");
            }
            if v.get("ok").and_then(Value::as_bool) == Some(true) {
                0
            } else if v.get("timeout").and_then(Value::as_bool) == Some(true) {
                3
            } else {
                if json_out {
                    eprintln!("error: {out}");
                }
                1
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            2
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn skill_tokens() {
        assert_eq!(skill_refs("use $pr-body and $e2e, not a$b; ($x)"), vec!["pr-body", "e2e", "x"]);
    }

    #[test]
    fn briefs_are_structured() {
        let ok = wrap_brief("## Goal\nfix the bug\n## Key paths\nsrc/a.rs\n## Conventions\nno new deps\n## Searches done\ngrep auth: 3 hits\n## Decisions\nuse the hub").unwrap();
        assert!(ok.starts_with("<brief>"));
        assert!(ok.contains("fix the bug"));
        // Spanish headings work too, and 3 sections with goal is the minimum.
        assert!(wrap_brief("objetivo: x\nrutas clave: y\ndecisiones: z").is_ok());
        let err = wrap_brief("just do the thing").unwrap_err();
        assert!(err.contains("missing:"), "{err}");
        assert!(wrap_brief("## Key paths\nonly paths\n## Conventions\nno\n## Decisions\nyes").is_err());
    }

    #[test]
    fn names() {
        assert!(valid_name("fix-auth.2"));
        assert!(!valid_name("../x"));
        assert!(!valid_name(""));
    }
}
