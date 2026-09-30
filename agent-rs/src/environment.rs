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

/// Run `argv` in its own session with merged stdout/stderr, killing the group on timeout.
/// Returns (output, returncode) or (partial output, error text) on timeout/spawn failure.
fn run(argv: &[String], cwd: Option<&str>, env: Option<&BTreeMap<String, String>>, timeout: u64, label: &str) -> Result<(String, i64), (String, String, String)> {
    use crate::agent::STOP;
    use std::sync::atomic::Ordering;
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
    let mut child = match cmd.spawn() {
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
    crate::agent::CHILD_GROUP.store(pid, Ordering::SeqCst);
    struct Clear;
    impl Drop for Clear {
        fn drop(&mut self) {
            crate::agent::CHILD_GROUP.store(0, std::sync::atomic::Ordering::SeqCst);
        }
    }
    let _clear = Clear;
    let reader_thread = std::thread::spawn(move || {
        let mut buf = Vec::new();
        let mut r = reader;
        let _ = r.read_to_end(&mut buf);
        buf
    });
    let deadline = Instant::now() + Duration::from_secs(timeout.max(1));
    let status = loop {
        match child.try_wait() {
            Ok(Some(status)) => break Some(status),
            Ok(None) => {}
            Err(_) => break None,
        }
        if STOP.load(Ordering::SeqCst) {
            unsafe { libc::killpg(pid, libc::SIGKILL) };
            let _ = child.wait();
            let _ = reader_thread.join();
            return Err((String::new(), "Stopped".into(), String::new()));
        }
        if Instant::now() >= deadline {
            unsafe { libc::killpg(pid, libc::SIGKILL) };
            let _ = child.wait();
            let out = String::from_utf8_lossy(&reader_thread.join().unwrap_or_default()).into_owned();
            return Err((out, "TimeoutExpired".into(), format!("Command '{label}' timed out after {timeout} seconds")));
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    // The command's own children may still hold the pipe open: Python's communicate() waits
    // for EOF too, so do the same (bounded by the same deadline).
    let bytes = loop {
        if reader_thread.is_finished() {
            break reader_thread.join().unwrap_or_default();
        }
        if Instant::now() >= deadline {
            unsafe { libc::killpg(pid, libc::SIGKILL) };
            let out = String::from_utf8_lossy(&reader_thread.join().unwrap_or_default()).into_owned();
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
        let argv = vec!["/bin/sh".to_string(), "-c".to_string(), command.to_string()];
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
