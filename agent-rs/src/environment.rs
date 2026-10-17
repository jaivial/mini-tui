//! Execution environments: `local` (a shell on this machine, the one mini-tui uses) and
//! `docker` (commands in a long-lived container). Same results as the Python classes:
//! `{output, returncode, exception_info}` with stderr merged into stdout, the whole process
//! group killed on timeout, and `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` ending the run.

use crate::util::{get, Obj};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, Instant};

// The codejs host bridge runs synchronously on this agent thread. Propagate its
// enclosing deadline into subprocess waits without changing other agents or
// setting the process-global STOP flag.
thread_local! {
    static HOST_DEADLINE: std::cell::Cell<Option<Instant>> = const { std::cell::Cell::new(None) };
}

pub(crate) struct HostDeadlineGuard(Option<Instant>);
impl Drop for HostDeadlineGuard {
    fn drop(&mut self) { HOST_DEADLINE.with(|slot| slot.set(self.0)); }
}
pub(crate) fn host_deadline(deadline: Instant) -> HostDeadlineGuard {
    HostDeadlineGuard(HOST_DEADLINE.with(|slot| {
        let old = slot.get();
        slot.set(Some(old.map_or(deadline, |end| end.min(deadline))));
        old
    }))
}

pub enum Outcome {
    Output(Value),
    /// The command printed the submit marker: the run ends with this submission.
    Submitted(String),
    /// The agent was told to stop while the command ran (it was killed).
    Stopped,
}

pub trait Environment {
    fn execute(&mut self, command: &str) -> Outcome;
    fn template_vars(&self) -> Obj;
    fn serialize(&self) -> Value;
    /// Host-native file tools are safe only when the environment explicitly shares this
    /// filesystem. Remote/container environments must implement their own tool bridge first.
    fn host_filesystem_tools(&self) -> bool { false }

    /// The directory a relative path resolves against for the tools that do not shell out (the
    /// `read` tool): the environment's own `cwd`, which is also where its commands run.
    fn working_dir(&self) -> String {
        String::new()
    }

    /// Execute the commands of one model response and return their outcomes **in input order**.
    /// The default is the serial loop; an environment that can overlap work overrides this
    /// (`LocalEnvironment` does, with up to `action_concurrency` commands running at once).
    /// Semantics the serial loop guarantees must hold here too: input order is preserved, a
    /// spawn failure is an observation (not the end of the batch), a submit marker ends the
    /// run with that command's submission, and `STOP` kills whatever is still running.
    fn execute_batch(&mut self, commands: &[String]) -> Vec<Outcome> {
        commands.iter().map(|c| self.execute(c)).collect()
    }
}

/// An ordered string map (YAML order is kept, as pydantic's dict keeps it).
type StrMap = Vec<(String, String)>;

fn str_map(v: Option<&Value>) -> StrMap {
    let mut out = StrMap::new();
    if let Some(Value::Object(o)) = v {
        for (k, v) in o {
            let s = match v {
                Value::String(s) => s.clone(),
                other => other.to_string(),
            };
            out.push((k.clone(), s));
        }
    }
    out
}

fn map_value(m: &StrMap) -> Value {
    Value::Object(m.iter().map(|(k, v)| (k.clone(), json!(v))).collect())
}

fn uname() -> Obj {
    let mut u: libc::utsname = unsafe { std::mem::zeroed() };
    unsafe { libc::uname(&mut u) };
    let s = |a: &[libc::c_char]| unsafe { std::ffi::CStr::from_ptr(a.as_ptr()) }.to_string_lossy().into_owned();
    let mut o = Obj::new();
    let system = s(&u.sysname);
    o.insert("system".into(), json!(system));
    o.insert("node".into(), json!(s(&u.nodename)));
    o.insert("release".into(), json!(s(&u.release)));
    o.insert("version".into(), json!(s(&u.version)));
    o.insert("machine".into(), json!(s(&u.machine)));
    // platform.uname().processor is the machine name on Linux.
    o.insert("processor".into(), json!(s(&u.machine)));
    o
}

/// Process groups of a batch's spawned-but-unwaited commands (async-signal-safe to read from
/// the signal handler, like `e2e::worker::GROUPS`). A serial run has one running command and
/// `CHILD_GROUP` covers it; an overlapped batch has several, so it needs its own registry.
pub static BATCH_GROUPS: [std::sync::atomic::AtomicI32; 128] = [const { std::sync::atomic::AtomicI32::new(0) }; 128];

pub fn register_group(pid: i32) {
    for g in BATCH_GROUPS.iter() {
        if g.compare_exchange(0, pid, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst).is_ok() {
            return;
        }
    }
}

pub fn unregister_group(pid: i32) {
    for g in BATCH_GROUPS.iter() {
        let _ = g.compare_exchange(pid, 0, std::sync::atomic::Ordering::SeqCst, std::sync::atomic::Ordering::SeqCst);
    }
}

/// One running command of a batch: the process group leader plus its output reader.
pub struct Child {
    pid: i32,
    process: std::process::Child,
    reader: Option<Reader>,
}

/// The reader thread of one command, plus the two facts the waiter polls it for.
///
/// The output lives behind an `Arc<Mutex<..>>` instead of being the thread's return value because
/// the waiter may have to walk away from a reader that never finishes: a command that left a
/// background child holding the pipe (`sleep 300 & echo done`) keeps that thread blocked in
/// `read` for as long as the child lives. The thread is then detached instead of joined, and both
/// facts stay readable without it.
struct Reader {
    collected: Arc<Mutex<Collected>>,
    /// The pipe reached EOF: no more bytes can arrive and the thread is about to end.
    eof: Arc<AtomicBool>,
    handle: std::thread::JoinHandle<()>,
}

impl Reader {
    fn new(r: std::fs::File, cap: usize) -> Self {
        let collected = Arc::new(Mutex::new(Collected::new(cap)));
        let eof = Arc::new(AtomicBool::new(false));
        let (c, e) = (Arc::clone(&collected), Arc::clone(&eof));
        let handle = std::thread::spawn(move || {
            collect_bounded(r, c);
            e.store(true, Ordering::SeqCst);
        });
        Reader { collected, eof, handle }
    }

    fn done(&self) -> bool {
        self.eof.load(Ordering::SeqCst)
    }

    /// Bytes collected so far. What the drain window watches for progress.
    fn total(&self) -> usize {
        lock(&self.collected).total
    }

    /// Take the page, joining the thread when it is already finished (the normal case). When it is
    /// not, the thread is detached --- it is blocked in `read` on a pipe a loose child still
    /// holds, and waiting for that is the defect being fixed --- and `note` says so in the output.
    fn take(self, note: Option<String>) -> String {
        let finished = self.done();
        if finished {
            let _ = self.handle.join();
        }
        let mut out = lock(&self.collected);
        if !finished {
            out.note = note;
        }
        out.render()
    }
}

fn lock(m: &Mutex<Collected>) -> MutexGuard<'_, Collected> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// The marker that ends a run. Shared with `check_finished`, which looks for it in *output*;
/// here we only need it as a cheap pre-check on the command itself (the authoritative check is
/// on the output, after the command runs).
pub const SUBMIT_MARKER: &str = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

fn run(argv: &[String], cwd: Option<&str>, env: Option<&BTreeMap<String, String>>, timeout: u64, label: &str) -> Result<(String, i64), (String, String, String)> {
    let mut child = spawn(argv, cwd, env)?;
    // The signal handler kills this group on SIGTERM; a batch tracks its own groups instead.
    crate::agent::CHILD_GROUP.store(child.pid, Ordering::SeqCst);
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            crate::agent::CHILD_GROUP.store(0, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _clear = Clear;
    child.wait_collect(label, timeout)
}

/// Spawn `argv` in its own session with merged stdout/stderr, without waiting for it. The
/// caller owns the [`Child`] and must call [`Child::wait_collect`] exactly once.
fn spawn(argv: &[String], cwd: Option<&str>, env: Option<&BTreeMap<String, String>>) -> Result<Child, (String, String, String)> {
    let (reader, writer) = match pipe() {
        Ok(p) => p,
        Err(e) => return Err((String::new(), "OSError".into(), e)),
    };
    let writer2 = match writer.try_clone() {
        Ok(w) => w,
        Err(e) => return Err((String::new(), "OSError".into(), e.to_string())),
    };
    let mut cmd = Command::new(&argv[0]);
    cmd.args(&argv[1..]).stdin(Stdio::null()).stdout(writer).stderr(writer2);
    if let Some(dir) = cwd {
        cmd.current_dir(dir);
    }
    if let Some(env) = env {
        cmd.envs(env);
    }
    unsafe {
        cmd.pre_exec(|| {
            libc::setsid();
            Ok(())
        });
    }
    let child = match cmd.spawn() {
        Ok(c) => c,
        Err(e) => {
            let kind = if e.kind() == std::io::ErrorKind::NotFound { "FileNotFoundError" } else { "OSError" };
            let msg = match e.raw_os_error() {
                Some(code) => format!("[Errno {code}] {}: '{}'", std::io::Error::from_raw_os_error(code).to_string().split(" (os error").next().unwrap_or(""), cwd.unwrap_or(&argv[0])),
                None => e.to_string(),
            };
            return Err((String::new(), kind.into(), msg));
        }
    };
    drop(cmd); // closes our copies of the pipe's write end
    let pid = child.id() as i32;
    let cap = output_max_bytes();
    Ok(Child { pid, process: child, reader: Some(Reader::new(reader, cap)) })
}

impl Child {
    /// Kill the whole process group without waiting (a stop signal: `wait_collect` is skipped).
    fn kill_group(&mut self) {
        unsafe { libc::killpg(self.pid, libc::SIGKILL) };
        let _ = self.process.kill();
        let _ = self.process.wait();
    }

    /// Drain the reader thread's page (killing the group first is the caller's job). The reader
    /// thread already bounded it; `render` adds the marker when the middle was dropped, so the
    /// model is told how much it did not see instead of silently getting a slice.
    /// Wait for the reader to reach EOF, but only while bytes keep arriving or `idle` passes.
    /// The pipe is open for good once that returns, and the rest of the output belongs to whoever
    /// else holds it --- `note` is what the model is told in that case.
    ///
    /// After a `killpg` the pipe is closing no matter what, so this is just the few milliseconds
    /// it takes the reader to see the EOF; without it a killed command's last words could be
    /// dropped on the floor by a race between the SIGKILL landing and the thread being scheduled.
    fn drain(&mut self, idle: Duration, note: Option<String>) -> String {
        let mut total = self.reader.as_ref().map_or(0, Reader::total);
        let mut idle_since = Instant::now();
        while let Some(r) = self.reader.as_ref() {
            if r.done() {
                break;
            }
            let now = Instant::now();
            let seen = r.total();
            if seen != total {
                total = seen;
                idle_since = now;
            }
            if now - idle_since >= idle {
                break;
            }
            std::thread::sleep(Duration::from_millis(5));
        }
        self.reader.take().map_or_else(String::new, |r| r.take(note))
    }

    fn take_output(&mut self, note: Option<String>) -> String {
        self.drain(Duration::from_millis(drain_idle_ms()), note)
    }

    /// Wait for the command (bounded by `timeout`), kill its group on timeout or stop, and
    /// collect its merged output.
    ///
    /// Two waits, and they are not the same wait. The first one is for the process this command
    /// IS; the second is for the pipe it wrote to, which a child it left behind can still be
    /// holding open. Only the first decides whether the command finished --- and it decides it
    /// by itself: once the leader is reaped its exit code is final, so anything that arrives
    /// afterwards belongs to a process the command detached on purpose (`&`, `nohup`, a daemon).
    ///
    /// So the second wait is bounded by its OWN window --- [`DRAIN_IDLE`], which only closes
    /// while no new byte has arrived --- instead of by the rest of the command timeout. Measured
    /// before the fix, `sleep 300 & echo done` took the full 30.002 s and came back as
    /// `returncode -1` / "Command timed out after 30 seconds" for a command that had exited 0
    /// in milliseconds, and the model is told its command hung when it did not (E11). Everything
    /// that changes is that the tail of the output now belongs to the observation whether the
    /// pipe closes in microseconds (it does, when nothing is left running) or in minutes.
    fn wait_collect(&mut self, label: &str, timeout: u64) -> Result<(String, i64), (String, String, String)> {
        use crate::agent::STOP;
        let command_deadline = Instant::now() + Duration::from_secs(timeout.max(1));
        let deadline = HOST_DEADLINE.with(|slot| slot.get().map_or(command_deadline, |end| end.min(command_deadline)));
        let status = loop {
            match self.process.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => break None,
            }
            if STOP.load(Ordering::SeqCst) {
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
                let _ = self.process.wait();
                // Dropped, NOT joined: a detached child may still hold the pipe, and a stop has
                // to get out now.
                drop(self.reader.take());
                return Err((String::new(), "Stopped".into(), String::new()));
            }
            if Instant::now() >= deadline {
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
                let _ = self.process.wait();
                let out = self.take_output(None);
                return Err((out, "TimeoutExpired".into(), format!("Command '{label}' timed out after {timeout} seconds")));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        // The leader is reaped: the command is OVER and its exit code is final. What can still
        // arrive is output from a process it detached on purpose, so this wait ends on silence
        // rather than on the command deadline --- and never turns a finished command into a
        // timeout. `deadline` is deliberately NOT an exit condition here: the command already
        // beat it, and reporting `TimeoutExpired` now would be the same lie in a new place.
        let collected = self.drain(Duration::from_millis(drain_idle_ms()), Some(BACKGROUND_HELD_PIPE.to_string()));
        let code = status.map(|s| {
            use std::os::unix::process::ExitStatusExt;
            s.code().map(|c| c as i64).unwrap_or_else(|| -(s.signal().unwrap_or(0) as i64))
        });
        Ok((collected, code.unwrap_or(-1)))
    }
}

/// How much of one command's output may reach the model, head+tail. The read tool's page budget
/// (`tools::READ_MAX_BYTES`) is the same number on purpose: every tool that can hand the model a
/// big blob of text shares one notion of "too big". The others were already capped (read 50 KB,
/// `code`/`codejs` 60 KB, `computer_use` 30 KB); `bash` --- the tool every run uses, and the one
/// whose output is unbounded by nature --- was the exception: `yes | head -c 20MB` put all
/// 20 000 045 bytes in one observation and cost 200 MB of RSS on the way there (A4, 2026-10-16).
pub const OUTPUT_MAX_BYTES: usize = 50 * 1024;

/// `MINITUI_BASH_OUTPUT_MAX` overrides the budget in bytes; `0` disables it, for an operation
/// that legitimately needs a whole dump (the same convention as `MINI_AGENT_RETRY_BUDGET_S`).
fn output_max_bytes() -> usize {
    match std::env::var("MINITUI_BASH_OUTPUT_MAX") {
        Ok(v) => v.trim().parse().unwrap_or(OUTPUT_MAX_BYTES),
        Err(_) => OUTPUT_MAX_BYTES,
    }
}

/// A command's output, collected under a byte budget *while it is read*: the head is kept whole,
/// the tail is kept in a ring, the middle is dropped and counted. Bounded memory matters as much
/// as the prompt budget: `read_to_end` on `yes` for the 30 s command timeout reached gigabytes
/// before the timeout could fire, and the trajectory stored the text twice.
struct Collected {
    head: Vec<u8>,
    tail: std::collections::VecDeque<u8>,
    total: usize,
    cap: usize,
    /// Agent-added text about the output itself (not command output, so not counted in `total`),
    /// appended after everything: where to look when the command's own bytes are not all here.
    note: Option<String>,
}

impl Collected {
    fn new(cap: usize) -> Self {
        Collected { head: Vec::new(), tail: std::collections::VecDeque::new(), total: 0, cap, note: None }
    }

    fn push(&mut self, chunk: &[u8]) {
        self.total += chunk.len();
        if self.cap == 0 {
            // No budget: the caller asked for the whole thing (`MINITUI_BASH_OUTPUT_MAX=0`).
            self.head.extend_from_slice(chunk);
            return;
        }
        let head_max = self.cap / 2;
        let tail_max = self.cap - head_max;
        let mut rest = chunk;
        if self.head.len() < head_max {
            let take = (head_max - self.head.len()).min(rest.len());
            self.head.extend_from_slice(&rest[..take]);
            rest = &rest[take..];
        }
        if !rest.is_empty() {
            self.tail.extend(rest.iter().copied());
            while self.tail.len() > tail_max {
                self.tail.pop_front();
            }
        }
    }

    /// The bytes the model sees: everything when it fits --- head *and* tail, byte-for-byte, so an
    /// output under the budget is unchanged --- otherwise head + one marker + tail. The head/tail
    /// split is an implementation detail of the ring: it says nothing about what the model gets
    /// when nothing was evicted (an output between `cap/2` and `cap` fills both and is complete).
    fn render(&self) -> String {
        let body = self.body();
        match &self.note {
            Some(n) => format!("{body}\n\n{n}"),
            None => body,
        }
    }

    fn body(&self) -> String {
        if self.cap == 0 || self.total <= self.cap {
            let mut all = self.head.clone();
            all.extend(self.tail.iter().copied());
            return String::from_utf8_lossy(&all).into_owned();
        }
        let tail: Vec<u8> = self.tail.iter().copied().collect();
        let dropped = self.total.saturating_sub(self.head.len() + tail.len());
        format!(
            "{}\n\n[{} bytes of output dropped: the command produced {} and the tool budget is {}. The first and last lines are above; narrow it with head/tail/grep, count with wc, or write it to a file and page it with read. MINITUI_BASH_OUTPUT_MAX=0 lifts the budget.]\n\n{}",
            String::from_utf8_lossy(&self.head),
            dropped,
            format_size(self.total),
            format_size(self.cap),
            String::from_utf8_lossy(&tail)
        )
    }
}

/// Read `r` to EOF, keeping at most `cap` bytes (head + tail) in memory and publishing them as
/// it goes, so a waiter that gives up on the pipe can still take what arrived.
fn collect_bounded(r: impl std::io::Read, into: Arc<Mutex<Collected>>) {
    let mut r = r;
    let mut buf = vec![0u8; 16 * 1024];
    loop {
        match r.read(&mut buf) {
            Ok(0) => break,
            Ok(n) => lock(&into).push(&buf[..n]),
            Err(e) if e.kind() == std::io::ErrorKind::Interrupted => continue,
            Err(_) => break,
        }
    }
}

/// How long the pipe may stay silent AFTER the command's own process exited before the output is
/// taken as it stands. A command that leaves nothing running closes the pipe the moment its last
/// write is read, so this costs it one poll (5 ms); only a detached child can stretch it, and
/// the bytes such a child writes are its own, not the command's. `MINITUI_BASH_DRAIN_IDLE_MS`
/// tunes it; `0` restores the old behaviour of waiting for EOF until the command deadline.
const DRAIN_IDLE: u64 = 500;

fn drain_idle_ms() -> u64 {
    match std::env::var("MINITUI_BASH_DRAIN_IDLE_MS") {
        Ok(v) => v.trim().parse().unwrap_or(DRAIN_IDLE),
        Err(_) => DRAIN_IDLE,
    }
}

/// What the model is told when its command finished but something it started is still holding the
/// output pipe. Without it the observation would silently be missing a tail; with it the model
/// knows its output is complete up to the command's exit and where to look for the rest.
const BACKGROUND_HELD_PIPE: &str = "[this command finished, but a background process it started is still holding its output open, so anything that process writes later is not in the output above. Start background jobs with their own redirect (cmd > /tmp/job.log 2>&1 &) and read that file.]";

fn format_size(bytes: usize) -> String {
    if bytes < 1024 {
        format!("{bytes}B")
    } else if bytes < 1024 * 1024 {
        format!("{:.1}KB", bytes as f64 / 1024.0)
    } else {
        format!("{:.1}MB", bytes as f64 / (1024.0 * 1024.0))
    }
}

fn pipe() -> Result<(std::fs::File, std::fs::File), String> {
    use std::os::fd::FromRawFd;
    let mut fds = [0i32; 2];
    if unsafe { libc::pipe2(fds.as_mut_ptr(), libc::O_CLOEXEC) } != 0 {
        return Err(std::io::Error::last_os_error().to_string());
    }
    Ok(unsafe { (std::fs::File::from_raw_fd(fds[0]), std::fs::File::from_raw_fd(fds[1])) })
}

fn is_stopped(r: &Result<(String, i64), (String, String, String)>) -> bool {
    matches!(r, Err((_, kind, _)) if kind == "Stopped")
}

fn result_value(r: Result<(String, i64), (String, String, String)>) -> Value {
    match r {
        Ok((output, code)) => json!({"output": output, "returncode": code, "exception_info": ""}),
        Err((output, kind, msg)) => json!({
            "output": output,
            "returncode": -1,
            "exception_info": format!("An error occurred while executing the command: {msg}"),
            "extra": {"exception_type": kind, "exception": msg},
        }),
    }
}

/// The argv of one bash-tool command: `/bin/sh -c <fixed string>`, the command itself riding in
/// the environment (`shell_command_env`). A dispatched child with a lane (`MINI_AGENT_LANE`, one
/// path per line, set by the hub) runs it in a bubblewrap mount namespace where the lane root
/// (`MINI_AGENT_LANE_ROOT`, its work tree) is READ-ONLY except the lane paths, which stay
/// writable. Everything outside the work tree is untouched (`--dev-bind / /`): /tmp, the shared
/// store, the toolchains. Measured 2026-10-07: children issued 5-19 commands each into the
/// sibling's repo; a lane turns the expensive version of that (editing a sibling's file, which
/// the sibling then has to re-read or fight) into an immediate `Read-only file system`.
/// No bwrap on PATH, or no lane: the command runs as before.
pub fn lane_argv() -> Vec<String> {
    let plain = vec!["/bin/sh".to_string(), "-c".to_string(), SHELL_EVAL.to_string()];
    let lane = std::env::var("MINI_AGENT_LANE").unwrap_or_default();
    let root = std::env::var("MINI_AGENT_LANE_ROOT").unwrap_or_default();
    if lane.trim().is_empty() || root.is_empty() {
        return plain;
    }
    let bwrap = ["/usr/bin/bwrap", "/bin/bwrap", "/usr/local/bin/bwrap"].into_iter().find(|p| std::path::Path::new(p).exists());
    let Some(bwrap) = bwrap else { return plain };
    let mut argv: Vec<String> = vec![bwrap.into(), "--dev-bind".into(), "/".into(), "/".into(), "--ro-bind".into(), root.clone(), root.clone()];
    for l in lane.lines().map(str::trim).filter(|l| !l.is_empty()) {
        let p = std::path::Path::new(l);
        // A lane file that does not exist yet is a file the child will create: open its folder.
        let target = if p.exists() { p.to_path_buf() } else { p.parent().map(|d| d.to_path_buf()).unwrap_or_else(|| p.to_path_buf()) };
        if target.exists() && target.starts_with(&root) {
            let t = target.display().to_string();
            argv.extend(["--bind".into(), t.clone(), t]);
        }
    }
    argv.extend(["--".into(), "/bin/sh".into(), "-c".into(), SHELL_EVAL.to_string()]);
    argv
}

/// The command text, carried in the environment instead of on argv. See [`shell_command_env`].
pub const SHELL_COMMAND_VAR: &str = "MINI_TUI_SHELL_COMMAND";

/// What actually goes on argv in place of the command: a fixed string with no model text in it.
const SHELL_EVAL: &str = "eval \"$MINI_TUI_SHELL_COMMAND\"";

/// The env entry that carries one command's text into the shell.
///
/// `sh -c "<command>"` puts the whole command in the shell's own `argv`, and `/proc/<pid>/cmdline`
/// is exactly that. So a `pgrep -f`/`pkill -f` whose pattern appears anywhere in the command
/// matches the shell that is running it -- the agent's own command kills the agent's own command,
/// with no output and no explanation: measured, `pkill -f <marker>; echo REACHED` returns exit -15
/// and an EMPTY observation, the shell SIGTERMed before the `echo` ever ran.
/// Moving the text to the environment puts it in `/proc/<pid>/environ`, which `pgrep -f` does not
/// match, while `eval` keeps every other shell semantic identical: `$0` is still `/bin/sh`, exit
/// codes, positional parameters, multi-line text, quoting and stdin all behave as before.
fn shell_command_env(command: &str) -> impl Iterator<Item = (String, String)> {
    std::iter::once((SHELL_COMMAND_VAR.to_string(), command.to_string()))
}

/// `_check_finished`: the first line of the output (after leading whitespace) is the marker.
fn check_finished(output: &Value) -> Option<String> {
    let text = get(output, "output").and_then(Value::as_str).unwrap_or("");
    let trimmed = text.trim_start();
    if trimmed.is_empty() || get(output, "returncode").and_then(Value::as_i64) != Some(0) {
        return None;
    }
    let (first, rest) = split_first_line(trimmed);
    if first.trim() == "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT" {
        return Some(rest.to_string());
    }
    None
}

/// First line (with Python's `splitlines` line breaks) and everything after it.
fn split_first_line(s: &str) -> (&str, &str) {
    let mut it = s.char_indices().peekable();
    while let Some((i, c)) = it.next() {
        let br = matches!(c, '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}');
        if br {
            let mut end = i + c.len_utf8();
            if c == '\r' {
                if let Some(&(_, '\n')) = it.peek() {
                    end += 1;
                }
            }
            return (&s[..i], &s[end..]);
        }
    }
    (s, "")
}

/// A spawn failure inside a batch: the failing command's error, everything before it already
/// collected by the caller, everything after it not run — the shape the serial loop produces.
pub struct LocalEnvironment {
    config: Obj,
    cwd: String,
    env: StrMap,
    timeout: u64,
}

impl LocalEnvironment {
    pub fn new(config: &Obj) -> Self {
        let mut c = Obj::new();
        let cwd = config.get("cwd").and_then(Value::as_str).unwrap_or("").to_string();
        let env = str_map(config.get("env"));
        let timeout = config.get("timeout").and_then(Value::as_u64).unwrap_or(30);
        c.insert("cwd".into(), json!(cwd));
        c.insert("env".into(), map_value(&env));
        c.insert("timeout".into(), json!(timeout));
        LocalEnvironment { config: c, cwd, env, timeout }
    }
}

impl Environment for LocalEnvironment {
    fn host_filesystem_tools(&self) -> bool { true }
    fn execute(&mut self, command: &str) -> Outcome {
        let cwd = if self.cwd.is_empty() { std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default() } else { self.cwd.clone() };
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.extend(self.env.clone());
        // subprocess.Popen(shell=True) runs `/bin/sh -c` -- but with the command in the
        // environment, not on argv, so `pgrep -f`/`pkill -f` cannot match the shell running it.
        // See `shell_command_env`.
        env.extend(shell_command_env(command));
        let argv = lane_argv();
        let r = run(&argv, Some(&cwd), Some(&env), self.timeout, command);
        if is_stopped(&r) {
            return Outcome::Stopped;
        }
        let out = result_value(r);
        match check_finished(&out) {
            Some(s) => Outcome::Submitted(s),
            None => Outcome::Output(out),
        }
    }

    /// The commands of one model response, overlapped: every process is spawned first, then
    /// waited for. Two independent commands therefore cost the slower of the two rather than
    /// the sum — pi's `executeToolCallsParallel` does the same for a tool batch — while the
    /// *results* stay in input order and each command still runs in its own subshell, so the
    /// observation messages are byte-identical to the serial path's.
    ///
    /// Ordering caveats the serial loop does not have, both deliberate and both visible to the
    /// model rather than hidden from it: the commands may *write* in an interleaved way when
    /// they touch the same file (the prompt tells the model to batch only independent commands),
    /// and a timeout kills only its own process group. `STOP` kills every group, as before.
    /// A command's timeout is measured from when it is *waited for* (as Python's would be from
    /// when it starts in a serial run), so the step's total budget is bounded by the serial
    /// sum, never above it; a command that hangs may simply have produced more output by the
    /// time it is killed. Symmetrically, a submit marker discovered only in a command's
    /// *output* (not in its text) can let up to `concurrency - 1` later commands run that the
    /// serial loop would not have — the commands were issued together, which is what the
    /// prompt reserves for independent work, and pi runs the whole batch unconditionally.
    fn execute_batch(&mut self, commands: &[String]) -> Vec<Outcome> {
        use crate::agent::STOP;
        let cwd = if self.cwd.is_empty() { std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default() } else { self.cwd.clone() };
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.extend(self.env.clone());
        // Spawned-but-unwaited commands of the current batch, in input order. The SIGTERM
        // handler kills these (a serial run has exactly one running command, and
        // `CHILD_GROUP` covers it; a batch has several, so it needs its own registry).
        let mut batch_groups: Vec<(usize, Child)> = Vec::with_capacity(commands.len());
        let mut slots: Vec<Option<Value>> = (0..commands.len()).map(|_| None).collect();
        // The serial loop's shape: spawn+wait one at a time, in order; a stop stops the run.
        // Overlap: keep at most `concurrency` commands running at once, so a batch costs
        // its slowest lane and never more wall time than the serial sum.
        let concurrency = crate::agent::action_concurrency(commands.len());
        let mut next = 0usize;
        let mut stopped = false;
        let mut stopped_at: Option<usize> = None;
        loop {
            while !stopped && next < commands.len() && batch_groups.len() < concurrency {
                if STOP.load(Ordering::SeqCst) {
                    stopped = true;
                    break;
                }
                let mut batch_env = env.clone();
                batch_env.extend(shell_command_env(&commands[next]));
                match spawn(&lane_argv(), Some(&cwd), Some(&batch_env)) {
                    Ok(child) => {
                        register_group(child.pid);
                        batch_groups.push((next, child));
                    }
                    // A failed spawn is a normal observation, not the end of the batch: the
                    // serial loop reports it and moves on to the next command.
                    Err((out, kind, msg)) => slots[next] = Some(result_value(Err((out, kind, msg)))),
                }
                next += 1;
                // A submit marker in the command itself ends the run here: the serial loop
                // would not run any later command either, so stop spawning for good (a plain
                // `break` would only leave this `while`; the outer loop would come back).
                // `check_finished` (on the output) stays authoritative; this is a conservative
                // pre-check — a command that merely mentions the marker stops the batch one
                // command early, which the model sees as "action was not executed" and redo.
                if slots[next - 1].is_none() && commands[next - 1].contains(SUBMIT_MARKER) {
                    next = commands.len();
                    break;
                }
            }
            if batch_groups.is_empty() {
                break;
            }
            // Wait in input order for the head of the batch to finish, then slot its result.
            // A stop while it runs is `wait_collect`'s own `Err(Stopped)`: the head ends the
            // step with `Outcome::Stopped` (no observation messages), exactly as the serial
            // loop does — and whatever is still running is killed by the cleanup below.
            let (i, mut child) = batch_groups.remove(0);
            unregister_group(child.pid);
            let r = child.wait_collect(&commands[i], self.timeout);
            if is_stopped(&r) {
                stopped_at = Some(i);
                break;
            }
            slots[i] = Some(result_value(r));
        }
        // Cleanup: kill whatever is still running (stop or a submit cut the batch short).
        for (_, mut child) in batch_groups {
            child.kill_group();
        }
        let mut outcomes = Vec::with_capacity(commands.len());
        for (i, slot) in slots.into_iter().enumerate() {
            if stopped_at == Some(i) {
                outcomes.push(Outcome::Stopped);
                continue;
            }
            let out = match slot {
                Some(v) => v,
                // Never started (a stop between commands, or a submit marker cut the batch
                // short): the observation renderer reports these as "action was not
                // executed", the same padding the serial loop's short `outputs` gets.
                None => crate::models::shapes::not_executed(),
            };
            match check_finished(&out) {
                Some(s) => outcomes.push(Outcome::Submitted(s)),
                None => outcomes.push(Outcome::Output(out)),
            }
        }
        outcomes
    }

    fn template_vars(&self) -> Obj {
        let mut vars = self.config.clone();
        crate::util::merge_into(&mut vars, &uname());
        // The directory the agent's commands already run in, as `cwd`. `config.cwd` is empty when
        // the run was not given one, in which case the shell inherits the process directory: the
        // prompt names it so the model does not spend turns on `pwd`/`ls`/`find` to find out where
        // it is (it was 2-3 calls per task on the round-2 benchmark).
        vars.insert("cwd".into(), json!(self.working_dir()));
        let mut env = Obj::new();
        for (k, v) in std::env::vars() {
            env.insert(k, json!(v));
        }
        crate::util::merge_into(&mut vars, &env);
        vars
    }

    fn serialize(&self) -> Value {
        json!({"info": {"config": {"environment": self.config, "environment_type": "minisweagent.environments.local.LocalEnvironment"}}})
    }

    fn working_dir(&self) -> String {
        if self.cwd.is_empty() {
            std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default()
        } else {
            self.cwd.clone()
        }
    }
}

pub struct DockerEnvironment {
    config: Obj,
    image: String,
    cwd: String,
    env: StrMap,
    forward_env: Vec<String>,
    timeout: u64,
    executable: String,
    interpreter: Vec<String>,
    container_id: Option<String>,
}

impl DockerEnvironment {
    pub fn new(config: &Obj) -> Result<Self, String> {
        let image = config.get("image").and_then(Value::as_str).ok_or("docker environment needs `image`")?.to_string();
        let strs = |k: &str, d: Vec<&str>| -> Vec<String> {
            config.get(k).and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_else(|| d.into_iter().map(String::from).collect())
        };
        let executable = config.get("executable").and_then(Value::as_str).map(String::from).unwrap_or_else(|| crate::config::env_or("MSWEA_DOCKER_EXECUTABLE", "docker"));
        let mut env = DockerEnvironment {
            image: image.clone(),
            cwd: config.get("cwd").and_then(Value::as_str).unwrap_or("/").to_string(),
            env: str_map(config.get("env")),
            forward_env: strs("forward_env", vec![]),
            timeout: config.get("timeout").and_then(Value::as_u64).unwrap_or(30),
            executable: executable.clone(),
            interpreter: strs("interpreter", vec!["bash", "-lc"]),
            container_id: None,
            config: Obj::new(),
        };
        let run_args = strs("run_args", vec!["--rm"]);
        let container_timeout = config.get("container_timeout").and_then(Value::as_str).unwrap_or("2h").to_string();
        let pull_timeout = config.get("pull_timeout").and_then(Value::as_u64).unwrap_or(120);
        env.config = serde_json::from_value(json!({
            "image": image, "cwd": env.cwd, "env": map_value(&env.env), "forward_env": env.forward_env, "timeout": env.timeout,
            "executable": executable, "run_args": run_args, "container_timeout": container_timeout,
            "pull_timeout": pull_timeout, "interpreter": env.interpreter,
        })).unwrap();
        let name = format!("minisweagent-{}", &crate::util_hex(8));
        let mut argv = vec![env.executable.clone(), "run".into(), "-d".into(), "--name".into(), name, "-w".into(), env.cwd.clone()];
        argv.extend(run_args);
        argv.extend([env.image.clone(), "sleep".into(), container_timeout]);
        match run(&argv, None, None, pull_timeout, &argv.join(" ")) {
            Ok((out, 0)) => env.container_id = Some(out.trim().to_string()),
            Ok((out, code)) => return Err(format!("docker run failed ({code}): {out}")),
            Err((_, _, msg)) => return Err(msg),
        }
        Ok(env)
    }
}

impl Environment for DockerEnvironment {
    fn working_dir(&self) -> String { self.cwd.clone() }
    fn execute(&mut self, command: &str) -> Outcome {
        let id = self.container_id.clone().unwrap_or_default();
        let mut argv = vec![self.executable.clone(), "exec".into(), "-w".into(), self.cwd.clone()];
        for key in &self.forward_env {
            if let Ok(v) = std::env::var(key) {
                argv.extend(["-e".into(), format!("{key}={v}")]);
            }
        }
        for (k, v) in &self.env {
            argv.extend(["-e".into(), format!("{k}={v}")]);
        }
        argv.push(id);
        argv.extend(self.interpreter.clone());
        argv.push(command.to_string());
        let label = argv.join(" ");
        let r = run(&argv, None, None, self.timeout, &label);
        if is_stopped(&r) {
            return Outcome::Stopped;
        }
        let out = result_value(r);
        match check_finished(&out) {
            Some(s) => Outcome::Submitted(s),
            None => Outcome::Output(out),
        }
    }

    fn template_vars(&self) -> Obj {
        let mut vars = self.config.clone();
        crate::util::merge_into(&mut vars, &uname());
        // Same `cwd` contract as `LocalEnvironment`: the instance prompt names the directory the
        // commands run in, so it must be defined here too (the container path, else the image's).
        vars.insert("cwd".into(), json!(self.config.get("cwd").and_then(Value::as_str).unwrap_or("/")));
        vars
    }

    fn serialize(&self) -> Value {
        json!({"info": {"config": {"environment": self.config, "environment_type": "minisweagent.environments.docker.DockerEnvironment"}}})
    }

}

impl Drop for DockerEnvironment {
    fn drop(&mut self) {
        if let Some(id) = &self.container_id {
            let exe = &self.executable;
            let _ = Command::new("/bin/sh")
                .arg("-c")
                .arg(format!("(timeout 60 {exe} stop {id} || {exe} rm -f {id}) >/dev/null 2>&1 &"))
                .stdin(Stdio::null())
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .spawn();
        }
    }
}

pub fn get_environment(config: &Obj) -> Result<Box<dyn Environment>, String> {
    let mut config = config.clone();
    let class = config.shift_remove("environment_class").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "local".into());
    match class.as_str() {
        "local" | "minisweagent.environments.local.LocalEnvironment" => Ok(Box::new(LocalEnvironment::new(&config))),
        "docker" | "minisweagent.environments.docker.DockerEnvironment" => Ok(Box::new(DockerEnvironment::new(&config)?)),
        other => Err(format!("Unknown environment type: {other} (the Rust agent supports: local, docker)")),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn local() -> LocalEnvironment {
        LocalEnvironment::new(&Obj::new())
    }

    #[test]
    fn runs_and_merges_stderr() {
        match local().execute("echo out; echo err 1>&2; exit 3") {
            Outcome::Output(v) => {
                assert_eq!(v["output"], "out\nerr\n");
                assert_eq!(v["returncode"], 3);
                assert_eq!(v["exception_info"], "");
            }
            _ => panic!("expected output"),
        }
    }

    #[test]
    fn submit_marker() {
        match local().execute("printf '  COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT\\nthe answer\\nline 2\\n'") {
            Outcome::Submitted(s) => assert_eq!(s, "the answer\nline 2\n"),
            _ => panic!("expected submission"),
        }
    }

    #[test]
    fn timeout_kills_group() {
        let mut o = Obj::new();
        o.insert("timeout".into(), json!(1));
        let start = Instant::now();
        match LocalEnvironment::new(&o).execute("echo partial; sleep 30 & sleep 30") {
            Outcome::Output(v) => {
                assert_eq!(v["returncode"], -1);
                assert_eq!(v["output"], "partial\n");
                assert!(v["exception_info"].as_str().unwrap().contains("timed out after 1 seconds"));
                assert_eq!(v["extra"]["exception_type"], "TimeoutExpired");
            }
            _ => panic!(),
        }
        assert!(start.elapsed() < Duration::from_secs(5));
    }


    /// E6: a `pkill -f`/`pgrep -f` in the agent's own command used to match the shell RUNNING it
    /// (`/proc/<pid>/cmdline` of `sh -c <command>` is the command), so the agent killed its own
    /// command and got an empty observation back -- or, with a background job holding the pipe,
    /// a bogus 30 s "timed out". The marker is assembled at runtime so it cannot appear in the
    /// test binary's own argv, which would make the test kill the runner (measured: it does).
    fn marker(tag: &str) -> String {
        // One token, no whitespace: `pgrep -f` splits its pattern on blanks, so a marker with a
        // space in it would be two patterns. Assembled at runtime so it cannot appear verbatim in
        // the test binary's argv.
        format!("mini{}e6{}", "tui", tag)
    }

    fn out_of(command: &str) -> String {
        match local().execute(command) {
            Outcome::Output(v) => {
                assert_eq!(v["exception_info"], "", "unexpected exception: {}", v["exception_info"]);
                assert_eq!(v["returncode"], 0, "unexpected rc: {} out={:?}", v["returncode"], v["output"].as_str());
                v["output"].as_str().unwrap_or_default().to_string()
            }
            Outcome::Stopped => panic!("stopped"),
            Outcome::Submitted(s) => s,
        }
    }

    #[test]
    fn pkill_f_does_not_kill_the_shell_running_it() {
        let m = marker("alpha");
        // The old code never reached the echo: the shell matched its own pattern and was SIGTERMed.
        assert_eq!(out_of(&format!("pkill -f {m}; echo REACHED")), "REACHED\n");
    }

    #[test]
    fn pgrep_f_does_not_report_the_shell_running_it() {
        let m = marker("charlie");
        // `pgrep -f` used to answer with the agent's own shell pid (and nothing else).
        assert_eq!(out_of(&format!("pgrep -f {m}; echo done")), "done\n");
    }

    /// A process that really carries the marker on ITS argv, kept short-lived and cleaned up:
    /// a leaked `sleep 120` from an earlier run would be counted by the next run's `pgrep -f`,
    /// which is how this test failed the second time it ran in the full suite.
    fn real_target(m: &str) -> String {
        let start = Instant::now();
        let out = out_of(&format!(
            "bash -c 'exec -a {m} sleep 30' >/dev/null 2>&1 & bg=$!; sleep 1; \
             echo target=$(pgrep -f {m} | grep -v $$ | wc -l); kill $bg 2>/dev/null; echo cleaned=$?",
        ));
        assert!(start.elapsed() < Duration::from_secs(10), "took {:?}", start.elapsed());
        out
    }

    #[test]
    fn pgrep_f_still_finds_a_real_target() {
        // The fix must not break the thing the command was FOR: a real process whose own argv
        // carries the marker is still found. One per run, and it dies with the test.
        let out = real_target(&marker("delta"));
        assert!(out.contains("target=1"), "{out:?}");
        assert!(out.contains("cleaned=0"), "the target outlived the test: {out:?}");
    }

    #[test]
    fn pgrep_f_can_kill_a_real_target_without_touching_the_shell() {
        let m = marker("echo");
        let out = out_of(&format!(
            "bash -c 'exec -a {m} sleep 30' >/dev/null 2>&1 & bg=$!; sleep 1; \
             before=$(pgrep -f {m} | grep -v $$ | wc -l); pkill -f {m}; sleep 1; \
             after=$(pgrep -f {m} | grep -v $$ | wc -l); echo before=$before after=$after; \
             kill $bg 2>/dev/null; true",
        ));
        assert!(out.contains("before=1"), "{out:?}");
        assert!(out.contains("after=0"), "the real target survived: {out:?}");
    }

    /// E11: a background job holds the command's output pipe open, and the wait for it was the
    /// wait for the COMMAND. `sleep 300 & echo done` runs in milliseconds and exits 0, but the
    /// pipe stays open until the `sleep` dies, so the whole 30 s timeout was burned and the
    /// model was told its command had hung --- a lie that costs a turn and makes a working
    /// background launch look broken.
    ///
    /// These run the real command through the real environment, so they measure wall time and
    /// the shape of the observation rather than a helper's return value.
    const BG: &str = "sleep 300 &";

    fn obs_of(command: &str) -> (String, i64, String) {
        match local().execute(command) {
            Outcome::Output(v) => (
                v["output"].as_str().unwrap_or_default().to_string(),
                v["returncode"].as_i64().unwrap_or(-99),
                v["exception_info"].as_str().unwrap_or_default().to_string(),
            ),
            Outcome::Stopped => panic!("stopped"),
            Outcome::Submitted(s) => ("<submitted>".into(), 0, s),
        }
    }

    #[test]
    fn a_background_job_does_not_make_a_finished_command_time_out() {
        let start = Instant::now();
        let (out, rc, exc) = obs_of(&format!("{BG} echo done"));
        let took = start.elapsed();
        assert!(!exc.contains("timed out"), "reported as a timeout: {exc:?} out={out:?}");
        assert_eq!(rc, 0, "the command exited 0; out={out:?}");
        assert!(out.starts_with("done\n"), "out={out:?}");
        // The old code needed the full timeout for this; anything near it is the defect.
        assert!(took < Duration::from_secs(5), "took {took:?}");
    }

    #[test]
    fn a_background_job_still_gets_its_output_and_its_exit_code() {
        // The fix must not trade "no timeout" for "no output" or "wrong code": the command's own
        // bytes and its own status are what the model asked for.
        let (out, rc, exc) = obs_of(&format!("{BG} echo first; echo second; exit 7"));
        assert_eq!(rc, 7, "out={out:?}");
        assert_eq!(exc, "", "out={out:?}");
        assert!(out.starts_with("first\nsecond\n"), "out={out:?}");
    }

    #[test]
    fn output_a_background_job_writes_later_is_declared_missing_not_hidden() {
        // The bytes the detached process writes are NOT the command's output, and pretending
        // otherwise is the other half of the lie. The observation must say so --- otherwise the
        // model cannot tell a complete command from a truncated one.
        let (out, rc, _) = obs_of(&format!("{BG} echo done"));
        assert_eq!(rc, 0);
        assert!(out.contains("background process"), "no note about the held pipe: {out:?}");
        assert!(out.contains("2>&1"), "the note does not say how to avoid it: {out:?}");
    }

    #[test]
    fn a_command_that_really_does_time_out_still_times_out() {
        // The other half of the contract: a command that does NOT finish must still be killed at
        // its timeout and reported as such. The drain window is not a way to hang forever.
        let mut o = Obj::new();
        o.insert("timeout".into(), json!(1));
        let start = Instant::now();
        match LocalEnvironment::new(&o).execute("echo partial; sleep 30") {
            Outcome::Output(v) => {
                assert_eq!(v["returncode"], -1);
                assert_eq!(v["output"], "partial\n");
                assert!(v["exception_info"].as_str().unwrap().contains("timed out after 1 seconds"));
            }
            _ => panic!("expected a timeout"),
        }
        assert!(start.elapsed() < Duration::from_secs(5), "took {:?}", start.elapsed());
    }

    #[test]
    fn a_command_that_leaves_nothing_running_is_untouched() {
        // The common case must be byte-for-byte what it was, note included: no note, no wait.
        let start = Instant::now();
        assert_eq!(out_of("echo plain"), "plain\n");
        let (out, rc, exc) = obs_of("echo a; echo b 1>&2; exit 3");
        assert_eq!((out.as_str(), rc, exc.as_str()), ("a\nb\n", 3, ""));
        assert!(start.elapsed() < Duration::from_secs(2), "took {:?}", start.elapsed());
    }

    #[test]
    fn a_background_job_does_not_stall_a_batch_either() {
        // The batch path (`execute_batch`) waits the same way, so the same defect would have hit
        // every command the model batches --- and a batch is where a `&` is most tempting.
        let cmds = vec![format!("{BG} echo one").to_string(), "echo two".to_string()];
        let start = Instant::now();
        let out = local().execute_batch(&cmds);
        let took = start.elapsed();
        assert_eq!(out.len(), 2);
        assert!(took < Duration::from_secs(5), "took {took:?}");
        match &out[0] {
            Outcome::Output(v) => {
                assert!(v["output"].as_str().unwrap().starts_with("one\n"), "{v}");
                assert_eq!(v["returncode"], 0, "{v}");
            }
            _ => panic!("expected output"),
        }
    }

    /// What the fix must NOT break: the pipe is shared with children, and a command whose
    /// children all exit still gets its full output, head and tail, byte for byte.
    #[test]
    fn a_command_with_a_short_lived_child_still_gets_all_of_its_output() {
        let out = out_of("echo head; (sleep 0.2; echo from-child) & echo tail; wait");
        assert!(out.contains("head") && out.contains("tail") && out.contains("from-child"), "{out:?}");
    }

    #[test]
    fn the_command_is_not_on_the_argv_of_its_own_shell() {
        // The root cause itself, asserted directly: the argv the tool builds must not carry any
        // of the model's text. (A pattern-based kill cannot match a shell that does not hold it.)
        let argv = lane_argv();
        assert!(!argv.iter().any(|a| a.contains("pkill") || a.contains("pgrep")), "{argv:?}");
        assert_eq!(argv, vec!["/bin/sh".to_string(), "-c".to_string(), "eval \"$MINI_TUI_SHELL_COMMAND\"".to_string()]);
    }

    #[test]
    fn shell_semantics_survive_the_env_carry() {
        // The env-and-eval rewrite must not change what a command MEANS: `$0`, exit status,
        // positional parameters, multi-line text, quoting, stderr merge and cwd all as before.
        assert_eq!(out_of("echo zero=$0"), "zero=/bin/sh\n");
        match local().execute("exit 7") {
            Outcome::Output(v) => assert_eq!(v["returncode"], 7),
            _ => panic!(),
        }
        assert_eq!(out_of("echo one\necho two"), "one\ntwo\n");
        assert_eq!(out_of("echo out; echo err 1>&2"), "out\nerr\n");
        assert_eq!(out_of("echo 'a b' | tr ' ' '_'; echo $(echo sub); echo $HOME"), format!("a_b\nsub\n{}\n", std::env::var("HOME").unwrap_or_default()));
    }

    #[test]
    fn a_command_can_still_use_its_own_name_without_tripping_over_itself() {
        // The eval indirection must not leak a variable the command could collide with in a way
        // that changes its meaning: a command that reads the var sees its own text, like `$0`.
        let out = out_of("echo self=[$MINI_TUI_SHELL_COMMAND]");
        assert_eq!(out, "self=[echo self=[$MINI_TUI_SHELL_COMMAND]]\n");
    }

}
