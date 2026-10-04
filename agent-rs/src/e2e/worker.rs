//! Subagent workers: ordinary `mini-agent-rs` runs, connected to the coordinator by
//! - the command line (task, model, config, cost limit, trajectory path),
//! - `MSWEA_CONTROL_FILE` (`MESSAGE` lines for corrections and retries, `MODEL` for escalation),
//! - their `<traj>.jsonl` journal (live progress, the exit message, cost),
//! - signals (SIGINT: stop and save; SIGKILL after a grace period),
//! - `E2E_BROWSER_SOCKET` (the browser they drive through the `browser` command).

use serde_json::{json, Value};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::sync::atomic::{AtomicI32, Ordering};
use std::time::{Duration, Instant};

/// Process groups of live workers (async-signal-safe to read from the signal handler).
pub static GROUPS: [AtomicI32; 128] = [const { AtomicI32::new(0) }; 128];

pub fn register(pid: i32) {
    for g in GROUPS.iter() {
        if g.compare_exchange(0, pid, Ordering::SeqCst, Ordering::SeqCst).is_ok() {
            return;
        }
    }
}
pub fn unregister(pid: i32) {
    for g in GROUPS.iter() {
        let _ = g.compare_exchange(pid, 0, Ordering::SeqCst, Ordering::SeqCst);
    }
}

pub const MULTIMODAL_REGEX: &str = r"(?s)<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>(.+?)</CONTENT_TYPE>(.+?)</MSWEA_MULTIMODAL_CONTENT>";

/// The worker's agent config (self-contained: `-c` replaces the default mini.yaml).
pub fn worker_config(step_limit: i64, vision: bool) -> String {
    let mm = if vision { format!("  multimodal_regex: {}\n", serde_json::to_string(MULTIMODAL_REGEX).unwrap()) } else { String::new() };
    format!(
        r#"agent:
  max_consecutive_format_errors: 5
  step_limit: {step_limit}
  system_template: |
    You are an end-to-end QA agent. You test a web application through a real browser that you
    drive with the `browser` command, using your bash tool.

    <response_format_rule>
    Every response MUST include exactly one bash tool call, EXCEPT your final one.
    When you are done, reply with plain text and no tool call: exactly one JSON object
    {{"status": "pass" | "fail", "reason": "...", "evidence": "..."}}. That reply ends your run.
    </response_format_rule>

    Rules:
    - Only use `browser ...` commands (run `browser help` for the list). Do not curl, wget or
      script the app, do not read files on this machine, and do not change anything on it.
    - Never print, guess or ask for passwords or tokens. If the app asks you to log in, fill
      the fields with `browser fill-secret <locator> <NAME>` (`browser secrets` lists the names).
    - Stay inside the application; navigation to other sites is blocked.
    - Take a fresh `browser snapshot` whenever the page may have changed: [eN] refs are only
      valid for the latest snapshot. Prefer refs; role=/label=/text= locators also work.
  instance_template: |
    {{{{task}}}}
environment:
  env:
    PAGER: cat
    MANPAGER: cat
    NO_COLOR: '1'
  timeout: 120
model:
{mm}  observation_template: |
    {{%- if output.output | length < 12000 -%}}
    {{"returncode": {{{{ output.returncode }}}}, "output": {{{{ output.output | tojson }}}}{{%- if output.exception_info %}}, "exception_info": {{{{ output.exception_info | tojson }}}}{{% endif %}}}}
    {{%- else -%}}
    {{"returncode": {{{{ output.returncode }}}}, "output_head": {{{{ output.output[:6000] | tojson }}}}, "output_tail": {{{{ output.output[-6000:] | tojson }}}}, "warning": "Output too long."}}
    {{%- endif -%}}
  format_error_template: |
    Tool call error: {{{{error}}}}
    Call the bash tool with {{"command": "browser snapshot"}} (or another `browser` command).
    To finish, reply with only the JSON verdict and no tool call.
  model_kwargs:
    drop_params: true
"#
    )
}

#[derive(Debug, Clone)]
pub enum Outcome {
    /// The worker answered (held at exit for a possible follow-up).
    Answered { status: String, submission: String },
    /// The process ended (crash, fatal model error, killed).
    Exited { status: String, submission: String, code: Option<i32> },
    TimedOut,
    Interrupted,
}

pub struct Worker {
    pub child: Child,
    pub traj: PathBuf,
    pub journal: PathBuf,
    pub control: PathBuf,
    offset: u64,
    partial: String,
    pub cost: f64,
    pub calls: i64,
    pub commands: Vec<String>,
    pub model: String,
}

pub struct Spawn<'a> {
    pub exe: &'a Path,
    pub dir: &'a Path,
    pub name: &'a str,
    pub task: &'a str,
    pub model: Option<&'a str>,
    pub config: &'a Path,
    pub cost_limit: f64,
    pub socket: &'a Path,
    pub bin_dir: &'a Path,
    pub work_dir: &'a Path,
    pub strip_env: &'a [String],
}

impl Worker {
    pub fn spawn(s: Spawn) -> Result<Worker, String> {
        use std::os::unix::process::CommandExt;
        std::fs::create_dir_all(s.dir).map_err(|e| e.to_string())?;
        let traj = s.dir.join(format!("{}.traj.json", s.name));
        let journal = crate::agent::journal_path(&traj);
        let control = s.dir.join(format!("{}.control", s.name));
        std::fs::write(&control, "").map_err(|e| e.to_string())?;
        let log = std::fs::File::create(s.dir.join(format!("{}.log", s.name))).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(s.exe);
        cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(&traj).arg("-c").arg(s.config);
        // Tests: layer a scripted model config per step kind (`<dir>/<kind>.yaml`, else `any.yaml`).
        if let Ok(dir) = std::env::var("E2E_TEST_WORKER_CONFIGS") {
            let kind = s.name.rsplit('-').next().unwrap_or("");
            for c in [format!("{dir}/{}.yaml", s.name), format!("{dir}/{kind}.yaml"), format!("{dir}/any.yaml")] {
                if Path::new(&c).exists() {
                    cmd.arg("-c").arg(c);
                    break;
                }
            }
        }
        if let Some(m) = s.model {
            cmd.arg("-m").arg(m);
        }
        if s.cost_limit > 0.0 {
            cmd.arg("-l").arg(format!("{}", s.cost_limit));
        }
        cmd.arg("-t").arg(s.task);
        // The worker's environment: no secret material (credentials reach the browser server
        // only), the browser socket, its own control file, `browser` on PATH.
        for (k, _) in std::env::vars() {
            if (k.starts_with("E2E_") && k != "E2E_BROWSER_SOCKET" && k != "E2E_TEST_WORKER_CONFIGS") || s.strip_env.contains(&k) {
                cmd.env_remove(&k);
            }
        }
        let path = std::env::var("PATH").unwrap_or_default();
        cmd.env("PATH", format!("{}:{path}", s.bin_dir.display()))
            .env("E2E_BROWSER_SOCKET", s.socket)
            .env("MSWEA_CONTROL_FILE", &control)
            .env("MSWEA_SILENT_STARTUP", "1")
            .current_dir(s.work_dir)
            .stdin(Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log)
            .process_group(0);
        let child = cmd.spawn().map_err(|e| format!("could not start worker: {e}"))?;
        register(child.id() as i32);
        let model = s.model.map(String::from).unwrap_or_else(|| std::env::var("MSWEA_MODEL_NAME").unwrap_or_default());
        Ok(Worker { child, traj, journal, control, offset: 0, partial: String::new(), cost: 0.0, calls: 0, commands: vec![], model })
    }

    /// Append a control line (`MESSAGE "…"` / `MODEL name`).
    pub fn control(&self, line: &str) {
        use std::io::Write;
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&self.control) {
            let _ = writeln!(f, "{line}");
        }
    }

    pub fn message(&self, text: &str) {
        self.control(&format!("MESSAGE {}", serde_json::to_string(text).unwrap()));
    }

    pub fn switch_model(&mut self, model: &str) {
        self.control(&format!("MODEL {model}"));
        self.model = model.to_string();
    }

    /// New journal lines since the last read.
    fn read_new(&mut self) -> Vec<Value> {
        let Ok(mut f) = std::fs::File::open(&self.journal) else { return vec![] };
        let len = f.metadata().map(|m| m.len()).unwrap_or(0);
        if len < self.offset {
            self.offset = 0; // rewritten
            self.partial.clear();
        }
        if f.seek(SeekFrom::Start(self.offset)).is_err() {
            return vec![];
        }
        let mut buf = String::new();
        let n = f.read_to_string(&mut buf).unwrap_or(0);
        self.offset += n as u64;
        self.partial.push_str(&buf);
        let mut out = vec![];
        while let Some(i) = self.partial.find('\n') {
            let line: String = self.partial.drain(..=i).collect();
            if let Ok(v) = serde_json::from_str::<Value>(line.trim()) {
                out.push(v);
            }
        }
        out
    }

    /// Wait for the worker's next answer. `progress` gets each command it runs.
    pub fn wait(&mut self, deadline: Instant, progress: &mut dyn FnMut(&str)) -> Outcome {
        loop {
            let mut exit: Option<(String, String)> = None;
            for v in self.read_new() {
                match v.get("t").and_then(Value::as_str) {
                    Some("msg") => {
                        let m = &v["m"];
                        match m.get("role").and_then(Value::as_str) {
                            Some("assistant") => {
                                for a in m.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default() {
                                    if let Some(c) = a.get("command").and_then(Value::as_str) {
                                        self.commands.push(c.to_string());
                                        progress(c);
                                    }
                                }
                            }
                            Some("exit") => {
                                let st = m.pointer("/extra/exit_status").and_then(Value::as_str).unwrap_or("").to_string();
                                let sub = m.pointer("/extra/submission").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| m.get("content").and_then(Value::as_str)).unwrap_or("").to_string();
                                exit = Some((st, sub));
                            }
                            _ => {}
                        }
                    }
                    Some("info") => {
                        self.cost = v.pointer("/i/model_stats/instance_cost").and_then(Value::as_f64).unwrap_or(self.cost);
                        self.calls = v.pointer("/i/model_stats/api_calls").and_then(Value::as_i64).unwrap_or(self.calls);
                    }
                    _ => {}
                }
            }
            if let Some((status, submission)) = exit {
                return Outcome::Answered { status, submission };
            }
            if let Ok(Some(st)) = self.child.try_wait() {
                // Drain what it wrote last.
                let mut last = (String::new(), String::new());
                for v in self.read_new() {
                    if v.get("t").and_then(Value::as_str) == Some("msg") && v.pointer("/m/role").and_then(Value::as_str) == Some("exit") {
                        last = (v.pointer("/m/extra/exit_status").and_then(Value::as_str).unwrap_or("").into(), v.pointer("/m/extra/submission").and_then(Value::as_str).unwrap_or("").into());
                    }
                    if v.get("t").and_then(Value::as_str) == Some("info") {
                        self.cost = v.pointer("/i/model_stats/instance_cost").and_then(Value::as_f64).unwrap_or(self.cost);
                    }
                }
                unregister(self.child.id() as i32);
                return Outcome::Exited { status: last.0, submission: last.1, code: st.code() };
            }
            if crate::agent::STOP.load(Ordering::SeqCst) {
                self.stop();
                return Outcome::Interrupted;
            }
            if Instant::now() > deadline {
                self.stop();
                return Outcome::TimedOut;
            }
            std::thread::sleep(Duration::from_millis(150));
        }
    }

    /// SIGINT (the worker stops its command and saves), SIGKILL after a grace period.
    pub fn stop(&mut self) {
        let pid = self.child.id() as i32;
        if let Ok(Some(_)) = self.child.try_wait() {
            unregister(pid);
            return;
        }
        unsafe {
            libc::kill(pid, libc::SIGINT);
        }
        let deadline = Instant::now() + Duration::from_secs(8);
        let mut termed = false;
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                unregister(pid);
                return;
            }
            // Still there after 5 s: SIGTERM (its handler kills its command's process group).
            if !termed && deadline - Instant::now() < Duration::from_secs(3) {
                termed = true;
                unsafe {
                    libc::kill(pid, libc::SIGTERM);
                }
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::killpg(pid, libc::SIGKILL);
        }
        let _ = self.child.wait();
        unregister(pid);
    }
}

impl Drop for Worker {
    fn drop(&mut self) {
        self.stop();
    }
}

/// The JSON verdict in a worker's final answer: the last object with a `status` key.
pub fn parse_verdict(text: &str) -> Option<(String, String, String)> {
    let mut found = None;
    for (i, _) in text.match_indices('{') {
        let mut it = serde_json::Deserializer::from_str(&text[i..]).into_iter::<Value>();
        if let Some(Ok(v)) = it.next() {
            if let Some(st) = v.get("status").and_then(Value::as_str) {
                let st = st.trim().to_lowercase();
                let st = match st.as_str() {
                    "pass" | "passed" | "true" | "ok" | "success" => "pass",
                    "fail" | "failed" | "false" | "error" => "fail",
                    _ => continue,
                };
                let s = |k: &str| v.get(k).map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).unwrap_or_default();
                found = Some((st.to_string(), s("reason"), s("evidence")));
            }
        }
    }
    found
}

pub fn browser_wrapper(bin_dir: &Path, exe: &Path) -> Result<(), String> {
    use std::os::unix::fs::PermissionsExt;
    std::fs::create_dir_all(bin_dir).map_err(|e| e.to_string())?;
    let p = bin_dir.join("browser");
    let script = format!("#!/bin/sh\nexec {} browser \"$@\"\n", shell_quote(&exe.display().to_string()));
    std::fs::write(&p, script).map_err(|e| e.to_string())?;
    std::fs::set_permissions(&p, std::fs::Permissions::from_mode(0o755)).map_err(|e| e.to_string())?;
    Ok(())
}

pub fn shell_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

pub fn summary_json(w: &Worker) -> Value {
    json!({"trajectory": w.traj.display().to_string(), "model": w.model, "cost": w.cost, "api_calls": w.calls, "commands": w.commands.len()})
}

#[cfg(test)]
mod tests {
    use super::parse_verdict;
    #[test]
    fn verdicts() {
        assert_eq!(parse_verdict("done {\"status\": \"pass\", \"reason\": \"ok\"}").unwrap().0, "pass");
        assert_eq!(parse_verdict("```json\n{\"status\":\"FAILED\",\"reason\":\"no button\"}\n```").unwrap().1, "no button");
        assert!(parse_verdict("I think it passed").is_none());
        assert_eq!(parse_verdict("{\"status\":\"pass\"} then {\"status\":\"fail\"}").unwrap().0, "fail");
    }
}
