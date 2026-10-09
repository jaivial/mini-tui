//! Execution environments: `local` (a shell on this machine, the one mini-tui uses) and
//! `docker` (commands in a long-lived container). Same results as the Python classes:
//! `{output, returncode, exception_info}` with stderr merged into stdout, the whole process
//! group killed on timeout, and `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` ending the run.

use crate::util::{get, Obj};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::Read;
use std::os::unix::process::CommandExt;
use std::process::{Command, Stdio};
use std::time::{Duration, Instant};

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
    reader: Option<std::thread::JoinHandle<Vec<u8>>>,
}

/// The marker that ends a run. Shared with `check_finished`, which looks for it in *output*;
/// here we only need it as a cheap pre-check on the command itself (the authoritative check is
/// on the output, after the command runs).
pub const SUBMIT_MARKER: &str = "COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT";

fn run(argv: &[String], cwd: Option<&str>, env: Option<&BTreeMap<String, String>>, timeout: u64, label: &str) -> Result<(String, i64), (String, String, String)> {
    use std::sync::atomic::Ordering;
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
    let reader_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut r = reader;
        let _ = r.read_to_end(&mut buf);
        buf
    });
    Ok(Child { pid, process: child, reader: Some(reader_thread) })
}

impl Child {
    /// Kill the whole process group without waiting (a stop signal: `wait_collect` is skipped).
    fn kill_group(&mut self) {
        unsafe { libc::killpg(self.pid, libc::SIGKILL) };
        let _ = self.process.kill();
        let _ = self.process.wait();
    }

    /// Drain the reader thread's buffer (killing the group first is the caller's job).
    fn take_output(&mut self) -> String {
        String::from_utf8_lossy(&self.reader.take().and_then(|r| r.join().ok()).unwrap_or_default()).into_owned()
    }

    /// Wait for the command (bounded by `timeout`), kill its group on timeout or stop, and
    /// collect its merged output. The command's own children may still hold the pipe open:
    /// Python's `communicate()` waits for EOF too, so do the same (bounded by the deadline).
    fn wait_collect(&mut self, label: &str, timeout: u64) -> Result<(String, i64), (String, String, String)> {
        use crate::agent::STOP;
        use std::sync::atomic::Ordering;
        let deadline = Instant::now() + Duration::from_secs(timeout.max(1));
        let status = loop {
            match self.process.try_wait() {
                Ok(Some(status)) => break Some(status),
                Ok(None) => {}
                Err(_) => break None,
            }
            if STOP.load(Ordering::SeqCst) {
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
                let _ = self.process.wait();
                let _ = self.reader.take().map(|r| r.join());
                return Err((String::new(), "Stopped".into(), String::new()));
            }
            if Instant::now() >= deadline {
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
                let _ = self.process.wait();
                let out = self.take_output();
                return Err((out, "TimeoutExpired".into(), format!("Command '{label}' timed out after {timeout} seconds")));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let bytes = loop {
            if self.reader.as_ref().is_some_and(|r| r.is_finished()) {
                break self.reader.take().and_then(|r| r.join().ok()).unwrap_or_default();
            }
            if Instant::now() >= deadline {
                unsafe { libc::killpg(self.pid, libc::SIGKILL) };
                let out = self.take_output();
                return Err((out, "TimeoutExpired".into(), format!("Command '{label}' timed out after {timeout} seconds")));
            }
            std::thread::sleep(Duration::from_millis(5));
        };
        let code = status.map(|s| {
            use std::os::unix::process::ExitStatusExt;
            s.code().map(|c| c as i64).unwrap_or_else(|| -(s.signal().unwrap_or(0) as i64))
        });
        Ok((String::from_utf8_lossy(&bytes).into_owned(), code.unwrap_or(-1)))
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

/// The argv of one bash-tool command. A dispatched child with a lane (`MINI_AGENT_LANE`, one
/// path per line, set by the hub) runs it in a bubblewrap mount namespace where the lane root
/// (`MINI_AGENT_LANE_ROOT`, its work tree) is READ-ONLY except the lane paths, which stay
/// writable. Everything outside the work tree is untouched (`--dev-bind / /`): /tmp, the shared
/// store, the toolchains. Measured 2026-10-07: children issued 5-19 commands each into the
/// sibling's repo; a lane turns the expensive version of that (editing a sibling's file, which
/// the sibling then has to re-read or fight) into an immediate `Read-only file system`.
/// No bwrap on PATH, or no lane: the command runs as before.
pub fn lane_argv(command: &str) -> Vec<String> {
    let plain = vec!["/bin/sh".to_string(), "-c".to_string(), command.to_string()];
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
    argv.extend(["--".into(), "/bin/sh".into(), "-c".into(), command.to_string()]);
    argv
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
    fn execute(&mut self, command: &str) -> Outcome {
        let cwd = if self.cwd.is_empty() { std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default() } else { self.cwd.clone() };
        let mut env: BTreeMap<String, String> = std::env::vars().collect();
        env.extend(self.env.clone());
        // subprocess.Popen(shell=True) runs `/bin/sh -c`.
        let argv = lane_argv(command);
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
        use std::sync::atomic::Ordering;
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
                match spawn(&lane_argv(&commands[next]), Some(&cwd), Some(&env)) {
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
}
