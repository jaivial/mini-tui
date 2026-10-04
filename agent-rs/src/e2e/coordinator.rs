//! The coordinator: runs each test in its own browser, does the exact steps itself, hands
//! `act`/`assert` steps to worker subagents (separate `mini-agent-rs` processes), replays
//! cached actions, logs in, enforces budgets, and writes its own mini trajectory + reports.

use super::browser::{Action, Browser};
use super::project::{Profile, Project, Step, TestCase};
use super::server::{Server, Session, Shared};
use super::worker::{self, Outcome, Spawn, Worker};
use super::{cache, secrets};
use crate::util::{now, py_json};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub struct Options {
    pub worker_model: Option<String>,
    pub judge_model: Option<String>,
    pub escalate_model: Option<String>,
    pub parallel: usize,
    pub use_cache: bool,
    pub update_cache: bool,
    pub fresh_login: bool,
    pub headed: bool,
    pub vision: Option<bool>,
}

/// The run's shared state: its own trajectory (journal + export) and the budget.
pub struct Run {
    pub dir: PathBuf,
    pub traj: PathBuf,
    messages: Mutex<Vec<Value>>,
    journaled: Mutex<usize>,
    pub spent: Mutex<f64>,
    pub cost_limit: f64,
    started: f64,
    pub base_url: String,
}

impl Run {
    fn new(dir: PathBuf, base_url: &str, cost_limit: f64, task: &str) -> Arc<Run> {
        let traj = dir.join("coordinator.traj.json");
        let r = Arc::new(Run { dir, traj, messages: Mutex::new(vec![]), journaled: Mutex::new(0), spent: Mutex::new(0.0), cost_limit, started: now(), base_url: base_url.into() });
        r.push(json!({"role": "system", "content": "mini-agent-rs e2e coordinator", "extra": {"timestamp": now()}}));
        r.push(json!({"role": "user", "content": task, "extra": {"timestamp": now()}}));
        r
    }

    /// Add a message (scrubbed) and journal it.
    fn push(&self, m: Value) {
        let m: Value = serde_json::from_str(&secrets::scrub(&m.to_string())).unwrap_or(m);
        self.messages.lock().unwrap().push(m);
        self.save(false);
    }

    fn note(&self, text: &str) {
        self.push(json!({"role": "user", "content": text, "extra": {"interrupt_type": "E2E", "timestamp": now()}}));
    }

    fn info(&self, exit: &str, submission: &str) -> Value {
        json!({
            "model_stats": {"instance_cost": *self.spent.lock().unwrap(), "api_calls": 0},
            "config": {"agent_type": "mini-agent-rs.e2e.Coordinator", "base_url": self.base_url},
            "mini_version": crate::agent::VERSION,
            "exit_status": exit,
            "submission": submission,
            "elapsed_seconds": (now() - self.started) as i64,
        })
    }

    fn save(&self, force: bool) {
        use std::io::Write;
        let msgs = self.messages.lock().unwrap();
        let mut done = self.journaled.lock().unwrap();
        let journal = crate::agent::journal_path(&self.traj);
        let mut lines = vec![];
        if *done == 0 {
            lines.push(py_json(&json!({"t": "meta", "trajectory_format": "mini-swe-agent-1.1"}), true));
        }
        for m in &msgs[*done..] {
            lines.push(py_json(&json!({"t": "msg", "m": m}), true));
        }
        let fresh = *done == 0;
        *done = msgs.len();
        let last = msgs.last().cloned().unwrap_or(json!({}));
        let (exit, sub) = if last.get("role").and_then(Value::as_str) == Some("exit") {
            (last.pointer("/extra/exit_status").and_then(Value::as_str).unwrap_or("").to_string(), last.pointer("/extra/submission").and_then(Value::as_str).unwrap_or("").to_string())
        } else {
            (String::new(), String::new())
        };
        let info = self.info(&exit, &sub);
        lines.push(py_json(&json!({"t": "info", "i": info}), true));
        let f = if fresh { std::fs::File::create(&journal) } else { std::fs::OpenOptions::new().append(true).open(&journal) };
        if let Ok(mut f) = f {
            let _ = f.write_all((lines.join("\n") + "\n").as_bytes());
        }
        if force || !exit.is_empty() || msgs.len() % 10 == 0 {
            let data = json!({"info": info, "messages": *msgs, "trajectory_format": "mini-swe-agent-1.1"});
            let tmp = self.traj.with_extension("json.tmp");
            if std::fs::write(&tmp, py_json(&data, true)).is_ok() {
                let _ = std::fs::rename(&tmp, &self.traj);
            }
        }
    }

    fn remaining(&self) -> f64 {
        if self.cost_limit <= 0.0 {
            return 0.0;
        }
        (self.cost_limit - *self.spent.lock().unwrap()).max(0.0)
    }
}

#[derive(Clone, Debug)]
pub struct StepResult {
    pub label: String,
    pub status: String,
    pub detail: String,
    pub source: String,
    pub seconds: f64,
    pub cost: f64,
    pub subagent: Option<Value>,
}

#[derive(Clone, Debug)]
pub struct TestResult {
    pub name: String,
    pub file: String,
    pub status: String,
    pub reason: String,
    pub profile: String,
    pub seconds: f64,
    pub cost: f64,
    pub steps: Vec<StepResult>,
    pub screenshots: Vec<String>,
}

fn slug(s: &str) -> String {
    let mut out: String = s.chars().map(|c| if c.is_ascii_alphanumeric() { c.to_ascii_lowercase() } else { '-' }).collect();
    while out.contains("--") {
        out = out.replace("--", "-");
    }
    out.trim_matches('-').chars().take(48).collect()
}

/// The context shared by every test of a run.
pub struct Ctx {
    pub project: Project,
    pub opts: Options,
    pub run: Arc<Run>,
    pub exe: PathBuf,
    pub worker_cfg: PathBuf,
    pub worker_cfg_vision: PathBuf,
    pub bin_dir: PathBuf,
}

pub fn model_sees_images(model: &str) -> bool {
    let m = model.to_lowercase();
    ["claude", "gpt-4o", "gpt-4.1", "gpt-5", "gpt-6", "vision", "gemini", "-vl", "qwen-vl", "kimi-k2.6", "mimo-v2.6"].iter().any(|k| m.contains(k))
}

struct Ctl<'a> {
    ctx: &'a Ctx,
    test: &'a TestCase,
    shared: Shared,
    dir: PathBuf,
    socket: PathBuf,
    profile: Option<Profile>,
    deadline: Instant,
    cost: f64,
    pending: Vec<(String, Vec<Action>, String)>,
    screenshots: Vec<String>,
}

impl<'a> Ctl<'a> {
    fn b<R>(&self, f: impl FnOnce(&mut Browser) -> R) -> R {
        let mut s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
        f(&mut s.browser)
    }

    fn shot(&mut self, label: &str) {
        if let Ok((p, _)) = self.b(|b| b.screenshot(label)) {
            self.screenshots.push(p.display().to_string());
        }
    }

    /// Log in with the profile (saved state first, then the form), verifying the success check.
    fn login(&mut self, name: Option<&str>) -> Result<String, String> {
        let profile = match name {
            Some(n) => self.ctx.project.profile(Some(n))?,
            None => self.profile.clone(),
        };
        let Some(p) = profile else { return Ok("no login (profile none)".into()) };
        let Some(form) = p.form.clone() else { return Ok(format!("profile {}: HTTP auth only", p.name)) };
        let origin = super::cdp::origin_of(&self.ctx.run.base_url);
        let state_path = cache::auth_state_path(&self.ctx.project.cache_dir, &p.name, &origin);
        let success = form.success.clone();
        if !self.ctx.opts.fresh_login {
            if let Some(state) = cache::read_private_json(&state_path) {
                let target = success.get("check_url").and_then(Value::as_str).unwrap_or("/").to_string();
                self.b(|b| b.open("/")).ok();
                if self.b(|b| b.import_state(&state)).is_ok() && self.b(|b| b.open(&target)).is_ok() && self.check_success(&success).is_ok() {
                    self.b(|b| b.log.clear());
                    return Ok(format!("logged in as {} (saved session)", p.name));
                }
            }
        }
        let fd = |s: &str, d: &str| if s.is_empty() { d.to_string() } else { s.to_string() };
        let user = secrets::resolve(&form.user, self.ctx.project.secrets_file.as_deref())?;
        let pass = secrets::resolve(&form.password, self.ctx.project.secrets_file.as_deref())?;
        self.b(|b| -> Result<(), String> {
            b.open(&form.url)?;
            b.secrets.insert("__login_user".into(), user.clone());
            b.secrets.insert("__login_password".into(), pass.clone());
            b.fill_secret(&fd(&form.user_field, "css=input[type=email],input[name*=user],input[name*=email],input[type=text]"), "__login_user")?;
            b.fill_secret(&fd(&form.password_field, "css=input[type=password]"), "__login_password")?;
            Ok(())
        })?;
        if let Some(t) = &form.totp {
            let secret = secrets::resolve(t, self.ctx.project.secrets_file.as_deref())?;
            let code = secrets::totp(&secret, now() as u64)?;
            secrets::register("TOTP_CODE", &code);
            let field = form.totp_field.clone().unwrap_or_else(|| "css=input[autocomplete=one-time-code],input[name*=otp],input[name*=code]".into());
            self.b(|b| -> Result<(), String> {
                if b.count(&field).unwrap_or(0) == 0 {
                    // Two-step forms: submit the password first.
                    if !form.submit.is_empty() {
                        b.click(&form.submit)?;
                    } else {
                        b.press("Enter")?;
                    }
                    b.wait_for(&field, Duration::from_secs(15))?;
                }
                b.secrets.insert("__login_totp".into(), code.clone());
                b.fill_secret(&field, "__login_totp")?;
                Ok(())
            })?;
        }
        self.b(|b| if form.submit.is_empty() { b.press("Enter") } else { b.click(&form.submit) })?;
        self.b(|b| {
            for k in ["__login_user", "__login_password", "__login_totp"] {
                b.secrets.remove(k);
            }
        });
        self.check_success(&success).map_err(|e| format!("login as {} failed: {e}", p.name))?;
        if let Ok(state) = self.b(|b| b.export_state()) {
            let _ = cache::write_private_json(&state_path, &state);
        }
        // Login actions are not part of any step's cached replay.
        self.b(|b| b.log.clear());
        Ok(format!("logged in as {} (form)", p.name))
    }

    fn check_success(&mut self, success: &Value) -> Result<(), String> {
        let deadline = Instant::now() + Duration::from_secs(15);
        loop {
            let r = self.b(|b| -> Result<bool, String> {
                if success.is_null() {
                    // Default: no password field is visible any more.
                    return Ok(b.count("css=input[type=password]")? == 0);
                }
                let url = b.url();
                if let Some(u) = success.get("url_not_contains").and_then(Value::as_str) {
                    if url.contains(u) {
                        return Ok(false);
                    }
                }
                if let Some(u) = success.get("url_contains").and_then(Value::as_str) {
                    if !url.contains(u) {
                        return Ok(false);
                    }
                }
                if let Some(l) = success.get("visible").and_then(Value::as_str) {
                    if b.count(l)? == 0 {
                        return Ok(false);
                    }
                }
                Ok(true)
            })?;
            if r {
                return Ok(());
            }
            if Instant::now() > deadline {
                let url = self.b(|b| b.url());
                return Err(format!("the success check {} did not hold (at {url})", success));
            }
            std::thread::sleep(Duration::from_millis(400));
        }
    }

    /// Exact expectations: no model.
    fn expect(&mut self, e: &Value) -> Result<String, String> {
        let timeout = Duration::from_secs(e.get("timeout").and_then(Value::as_u64).unwrap_or(10));
        let deadline = Instant::now() + timeout;
        loop {
            let r = self.b(|b| -> Result<(), String> {
                let url = b.url();
                if let Some(u) = e.get("url_contains").and_then(Value::as_str) {
                    if !url.contains(u) {
                        return Err(format!("URL {url} does not contain {u:?}"));
                    }
                }
                if let Some(u) = e.get("url_not_contains").and_then(Value::as_str) {
                    if url.contains(u) {
                        return Err(format!("URL {url} contains {u:?}"));
                    }
                }
                if let Some(u) = e.get("url").and_then(Value::as_str) {
                    let want = b.resolve_url(u);
                    if url.trim_end_matches('/') != want.trim_end_matches('/') {
                        return Err(format!("URL is {url}, expected {want}"));
                    }
                }
                if let Some(t) = e.get("title_contains").and_then(Value::as_str) {
                    let title = b.eval("document.title").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                    if !title.to_lowercase().contains(&t.to_lowercase()) {
                        return Err(format!("title {title:?} does not contain {t:?}"));
                    }
                }
                if let Some(t) = e.get("page_contains").and_then(Value::as_str) {
                    let text = b.eval("document.body ? document.body.innerText : ''").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
                    if !text.contains(t) {
                        return Err(format!("the page does not contain {t:?}"));
                    }
                }
                if let Some(l) = e.get("locator").or_else(|| e.get("visible")).and_then(Value::as_str) {
                    let n = b.count(l)?;
                    if let Some(want) = e.get("count").and_then(Value::as_i64) {
                        if n != want {
                            return Err(format!("{l} matches {n} elements, expected {want}"));
                        }
                    } else if n == 0 {
                        return Err(format!("nothing matches {l}"));
                    }
                    if let Some(t) = e.get("to_contain_text").or_else(|| e.get("toContainText")).and_then(Value::as_str) {
                        let got = b.text_of(l)?;
                        if !got.contains(t) {
                            return Err(format!("{l} has text {got:?}, which does not contain {t:?}"));
                        }
                    }
                    if let Some(t) = e.get("to_have_text").and_then(Value::as_str) {
                        let got = b.text_of(l)?;
                        if got.trim() != t.trim() {
                            return Err(format!("{l} has text {got:?}, expected {t:?}"));
                        }
                    }
                }
                if let Some(l) = e.get("hidden").or_else(|| e.get("not_visible")).and_then(Value::as_str) {
                    if b.count(l)? > 0 {
                        return Err(format!("{l} is still on the page"));
                    }
                }
                Ok(())
            });
            match r {
                Ok(()) => return Ok("expectation holds".into()),
                Err(err) if Instant::now() < deadline && !err.contains("invalid locator") => std::thread::sleep(Duration::from_millis(300)),
                Err(err) => return Err(err),
            }
        }
    }

    /// One worker subagent for an act/assert step; retries once, then escalates the model.
    fn delegate(&mut self, kind: &str, text: &str, idx: usize) -> (String, String, Option<Value>, f64) {
        let is_assert = kind == "assert";
        let model = if is_assert { self.ctx.opts.judge_model.clone().or(self.ctx.opts.worker_model.clone()) } else { self.ctx.opts.worker_model.clone() };
        let model_name = model.clone().unwrap_or_else(|| std::env::var("MSWEA_MODEL_NAME").unwrap_or_default());
        let vision = self.ctx.opts.vision.unwrap_or_else(|| model_sees_images(&model_name));
        let snapshot = self.b(|b| b.snapshot(3000).unwrap_or_default());
        let secret_names: Vec<String> = self.b(|b| b.secrets.keys().cloned().collect());
        let profile = self.profile.as_ref().map(|p| p.name.clone()).unwrap_or_else(|| "none (logged out)".into());
        let task = if is_assert {
            format!(
                "Check whether this claim about the web application is TRUE right now:\n\n  {text}\n\nOnly observe: snapshot, text, count, scroll, wait, url{}. Do not click, type or navigate (those commands are disabled). Then reply with only {{\"status\": \"pass\" if the claim holds else \"fail\", \"reason\": \"why\", \"evidence\": \"what you saw\"}}.\n\nApp: {}\nLogged in as profile: {profile}\nCurrent page:\n{snapshot}",
                if vision { ", screenshot" } else { "" },
                self.ctx.run.base_url
            )
        } else {
            format!(
                "Reach this goal in the web application:\n\n  {text}\n\nUse the browser commands (`browser help`). When the goal is reached reply with only {{\"status\": \"pass\", \"reason\": \"what you did\", \"evidence\": \"what shows it worked\"}}; if it cannot be reached reply with {{\"status\": \"fail\", ...}}. Do only what the goal needs.\n\nApp: {}\nLogged in as profile: {profile}\nSecrets you may fill by name: {}\nCurrent page:\n{snapshot}",
                self.ctx.run.base_url,
                if secret_names.is_empty() { "none".into() } else { secret_names.join(", ") }
            )
        };
        let name = format!("{:02}-{kind}", idx + 1);
        {
            let mut s = self.shared.lock().unwrap_or_else(|p| p.into_inner());
            s.vision = vision;
            s.commands = 0;
            s.browser.read_only = is_assert;
        }
        let budget = self.ctx.run.remaining();
        if self.ctx.run.cost_limit > 0.0 && budget <= 0.0 {
            return ("fail".into(), "the run's cost limit is used up".into(), None, 0.0);
        }
        let per_worker = if budget > 0.0 { budget } else { 0.0 };
        let spawn = Worker::spawn(Spawn {
            exe: &self.ctx.exe,
            dir: &self.dir,
            name: &name,
            task: &task,
            model: model.as_deref(),
            config: if vision { &self.ctx.worker_cfg_vision } else { &self.ctx.worker_cfg },
            cost_limit: per_worker,
            socket: &self.socket,
            bin_dir: &self.ctx.bin_dir,
            work_dir: &self.dir,
            strip_env: &secrets::referenced_env_names(),
        });
        let mut w = match spawn {
            Ok(w) => w,
            Err(e) => return ("error".into(), e, None, 0.0),
        };
        self.ctx.run.push(json!({"role": "assistant", "content": format!("[{}] {kind} → subagent {name} ({model_name}): {text}", self.test.name), "extra": {"subagent": {"name": name, "trajectory": w.traj.display().to_string(), "model": model_name, "status": "running", "test": self.test.name}, "timestamp": now()}}));
        let test_name = self.test.name.clone();
        let mut attempts = 0;
        let (status, detail) = loop {
            let run = self.ctx.run.clone();
            let mut progress = |c: &str| {
                let short: String = c.chars().take(160).collect();
                eprintln!("    [{test_name}] {name}: {short}");
                let _ = &run;
            };
            let outcome = w.wait(self.deadline, &mut progress);
            match outcome {
                Outcome::Answered { status, submission } | Outcome::Exited { status, submission, .. } if !status.is_empty() && status != "Submitted" => {
                    let what: String = submission.chars().take(300).collect();
                    break ("error".into(), format!("the subagent's run ended with {status}{}", if what.is_empty() { String::new() } else { format!(": {what}") }));
                }
                Outcome::Answered { status, submission } | Outcome::Exited { status, submission, .. } if !submission.is_empty() || status == "Submitted" => {
                    match worker::parse_verdict(&submission) {
                        Some((v, reason, evidence)) => {
                            let detail = if evidence.is_empty() { reason } else { format!("{reason} (evidence: {evidence})") };
                            // A failed act gets one more try with a stronger model, when configured.
                            if v == "fail" && !is_assert && attempts == 0 && self.ctx.opts.escalate_model.is_some() && w.child.try_wait().ok().flatten().is_none() {
                                attempts += 1;
                                let m = self.ctx.opts.escalate_model.clone().unwrap();
                                w.switch_model(&m);
                                self.ctx.run.note(&format!("[{}] {name} failed ({detail}); escalating to {m}", self.test.name));
                                w.message(&format!("Your previous attempt failed: {detail}. Try again carefully from the current page (take a snapshot first). Reply with the JSON verdict when done."));
                                continue;
                            }
                            break (v, detail);
                        }
                        None if attempts < 2 && w.child.try_wait().ok().flatten().is_none() => {
                            attempts += 1;
                            w.message("Your final answer must be exactly one JSON object: {\"status\": \"pass\" or \"fail\", \"reason\": \"...\", \"evidence\": \"...\"}. Reply with it now, no tool call.");
                            continue;
                        }
                        None => break ("error".into(), format!("the subagent gave no verdict: {}", submission.chars().take(300).collect::<String>())),
                    }
                }
                Outcome::Answered { status, .. } => break ("error".into(), format!("the subagent ended with {status}")),
                Outcome::Exited { status, code, .. } => break ("error".into(), format!("the subagent exited ({}, code {:?}); see {}", if status.is_empty() { "no exit message" } else { &status }, code, w.traj.display())),
                Outcome::TimedOut => break ("fail".into(), "the test timed out while the subagent was working".into()),
                Outcome::Interrupted => break ("error".into(), "interrupted".into()),
            }
        };
        let session_cmds = self.shared.lock().map(|s| s.commands).unwrap_or(0);
        w.stop();
        let cost = w.cost;
        *self.ctx.run.spent.lock().unwrap() += cost;
        self.cost += cost;
        let leaked = secrets::scrub_file(&w.traj) | secrets::scrub_file(&w.journal);
        let mut summary = worker::summary_json(&w);
        summary["status"] = json!(status);
        summary["browser_commands"] = json!(session_cmds);
        if leaked {
            summary["warning"] = json!("a secret appeared in the subagent's trajectory and was scrubbed");
        }
        self.ctx.run.push(json!({"role": "tool", "content": format!("[{}] subagent {name}: {status}: {detail}", self.test.name), "extra": {"subagent": summary, "timestamp": now()}}));
        self.shared.lock().unwrap_or_else(|p| p.into_inner()).browser.read_only = false;
        (status, detail, Some(summary), cost)
    }

    fn run_steps(&mut self) -> (String, String, Vec<StepResult>) {
        let mut results: Vec<StepResult> = vec![];
        let steps = self.test.steps.clone();
        let base_path = super::project::Step::label(&Step::Open(self.test.start.clone().unwrap_or("/".into())));
        let mut fail: Option<String> = None;
        let mut cache_key_prev = cache::chain_seed(&self.ctx.run.base_url, &base_path);
        for (i, step) in steps.iter().enumerate() {
            if crate::agent::STOP.load(Ordering::SeqCst) {
                fail = Some("interrupted".into());
                break;
            }
            if Instant::now() > self.deadline {
                fail = Some(format!("timed out after {} s", self.test.timeout));
                break;
            }
            let t0 = now();
            let label = step.label();
            eprintln!("  [{}] {}", self.test.name, label);
            let mut source = "exact".to_string();
            let mut subagent = None;
            let mut cost = 0.0;
            let key = cache::step_key(&cache_key_prev, &label);
            cache_key_prev = key.clone();
            let res: Result<String, String> = match step {
                Step::Open(u) => self.b(|b| b.open(u)),
                Step::Login(p) => self.login(p.as_deref()),
                Step::Wait(w) => self.b(|b| b.wait_for(w, Duration::from_secs(30))),
                Step::Do(op, target, value) => {
                    let a = Action { op: op.clone(), target: target.clone(), value: value.clone() };
                    let r = self.b(|b| b.replay(&a));
                    self.b(|b| b.log.clear());
                    r
                }
                Step::Screenshot(l) => {
                    self.shot(l);
                    Ok("screenshot saved".into())
                }
                Step::Expect(e) => {
                    let r = self.expect(e);
                    if r.is_ok() {
                        self.commit_pending();
                    } else {
                        self.drop_pending();
                    }
                    r
                }
                Step::Act(goal) => {
                    let cached = if self.ctx.opts.use_cache && !self.ctx.opts.update_cache { cache::load(&self.ctx.project.cache_dir, &key) } else { None };
                    let mut replayed = None;
                    if let Some(actions) = cached {
                        source = "cache".into();
                        self.b(|b| b.log.clear());
                        let r: Result<(), String> = actions.iter().try_for_each(|a| self.b(|b| b.replay(a)).map(|_| ()));
                        match r {
                            Ok(()) => replayed = Some(Ok(format!("replayed {} cached actions", actions.len()))),
                            Err(e) => {
                                self.ctx.run.note(&format!("[{}] cached actions for {label:?} no longer replay ({e}); asking a subagent", self.test.name));
                                cache::remove(&self.ctx.project.cache_dir, &key);
                                source = "agent (cache miss)".into();
                            }
                        }
                    }
                    match replayed {
                        Some(r) => {
                            let log = self.b(|b| std::mem::take(&mut b.log));
                            self.pending.push((key.clone(), log, label.clone()));
                            r
                        }
                        None => {
                            if source == "exact" {
                                source = "agent".into();
                            }
                            self.b(|b| b.log.clear());
                            let (st, detail, sa, c) = self.delegate("act", goal, i);
                            let detail = if st == "error" { format!("error: {detail}") } else { detail };
                            subagent = sa;
                            cost = c;
                            let log = self.b(|b| std::mem::take(&mut b.log));
                            if st == "pass" {
                                if !log.is_empty() {
                                    self.pending.push((key.clone(), log, label.clone()));
                                }
                                Ok(detail)
                            } else {
                                Err(detail)
                            }
                        }
                    }
                }
                Step::Assert(claim) => {
                    source = "agent".into();
                    let (st, detail, sa, c) = self.delegate("assert", claim, i);
                    let detail = if st == "error" { format!("error: {detail}") } else { detail };
                    subagent = sa;
                    cost = c;
                    if st == "pass" {
                        self.commit_pending();
                        Ok(detail)
                    } else {
                        self.drop_pending();
                        Err(detail)
                    }
                }
            };
            let (status, detail) = match res {
                Ok(d) => ("pass".to_string(), d),
                Err(e) => ("fail".to_string(), e),
            };
            let detail = secrets::scrub(&detail);
            eprintln!("    → {status}: {}", detail.chars().take(200).collect::<String>());
            if step.is_agent() || status != "pass" {
                self.ctx.run.note(&format!("[{}] step {}: {label} — {status} ({source}): {detail}", self.test.name, i + 1));
            }
            results.push(StepResult { label, status: status.clone(), detail: detail.clone(), source, seconds: ((now() - t0) * 10.0).round() / 10.0, cost, subagent });
            if status != "pass" {
                self.shot(&format!("fail-step-{}", i + 1));
                fail = Some(format!("step {} failed: {detail}", i + 1));
                break;
            }
        }
        // Steps never verified by a later check are not cached (and stale entries go).
        self.drop_pending();
        match fail {
            Some(r) if r == "interrupted" => ("error".into(), r, results),
            Some(r) => ("fail".into(), r, results),
            None => ("pass".into(), String::new(), results),
        }
    }

    fn commit_pending(&mut self) {
        for (key, actions, label) in std::mem::take(&mut self.pending) {
            if self.ctx.opts.use_cache || self.ctx.opts.update_cache {
                let _ = cache::store(&self.ctx.project.cache_dir, &key, &label, &actions);
            }
        }
    }

    fn drop_pending(&mut self) {
        for (key, _, _) in std::mem::take(&mut self.pending) {
            // A replay a later check refuted must not be trusted again.
            cache::remove(&self.ctx.project.cache_dir, &key);
        }
    }
}

pub fn run_test(ctx: &Ctx, test: &TestCase, index: usize) -> TestResult {
    let t0 = now();
    let dir = ctx.run.dir.join(format!("{:02}-{}", index + 1, slug(&test.name)));
    let _ = std::fs::create_dir_all(&dir);
    let mut result = TestResult { name: test.name.clone(), file: test.file.display().to_string(), status: "error".into(), reason: String::new(), profile: String::new(), seconds: 0.0, cost: 0.0, steps: vec![], screenshots: vec![] };
    let profile = match ctx.project.profile(test.profile.as_deref()) {
        Ok(p) => p,
        Err(e) => {
            result.reason = e;
            return result;
        }
    };
    result.profile = profile.as_ref().map(|p| p.name.clone()).unwrap_or_else(|| "none".into());
    let base_url = test.base_url.clone().unwrap_or_else(|| ctx.run.base_url.clone());
    let mut browser = match Browser::launch(&base_url, ctx.opts.headed, &dir.join("screenshots")) {
        Ok(b) => b,
        Err(e) => {
            result.reason = e;
            return result;
        }
    };
    for o in &ctx.project.allowed_origins {
        browser.allow_origin(o);
    }
    let sf = ctx.project.secrets_file.as_deref();
    if let Some((u, pw)) = ctx.project.basic_for(profile.as_ref()) {
        match (secrets::resolve(&u, sf), secrets::resolve(&pw, sf)) {
            (Ok(u), Ok(pw)) => browser.set_basic_auth(u, pw),
            (Err(e), _) | (_, Err(e)) => {
                result.reason = format!("HTTP auth for profile {}: {e}", result.profile);
                return result;
            }
        }
    }
    if let Some(p) = &profile {
        for (name, r) in &p.secrets {
            match secrets::resolve(r, sf) {
                Ok(v) => {
                    secrets::register(name, &v);
                    browser.secrets.insert(name.clone(), v);
                }
                Err(e) => {
                    result.reason = format!("profile {}: {e}", p.name);
                    return result;
                }
            }
        }
    }
    // A private directory for the socket (0700): only this user's processes can drive it.
    let sock_dir = std::env::temp_dir().join(format!("mini-e2e-{}-{}", std::process::id(), crate::util_hex(6)));
    {
        use std::os::unix::fs::DirBuilderExt;
        let _ = std::fs::DirBuilder::new().mode(0o700).recursive(true).create(&sock_dir);
    }
    let socket = sock_dir.join("browser.sock");
    let shared: Shared = Arc::new(Mutex::new(Session { browser, vision: false, commands: 0 }));
    let server = match Server::start(&socket, shared.clone()) {
        Ok(s) => s,
        Err(e) => {
            result.reason = e;
            return result;
        }
    };
    let mut ctl = Ctl { ctx, test, shared: shared.clone(), dir: dir.clone(), socket, profile: profile.clone(), deadline: Instant::now() + Duration::from_secs(test.timeout), cost: 0.0, pending: vec![], screenshots: vec![] };
    ctx.run.note(&format!("[{}] starting ({}; profile {})", test.name, test.file.display(), result.profile));
    let setup: Result<(), String> = (|| {
        if profile.as_ref().is_some_and(|p| p.form.is_some()) && !test.steps.iter().any(|s| matches!(s, Step::Login(_))) {
            let m = ctl.login(None)?;
            eprintln!("  [{}] {m}", test.name);
        }
        if let Some(s) = &test.start {
            ctl.b(|b| b.open(s))?;
        }
        Ok(())
    })();
    let (status, reason, steps) = match setup {
        Ok(()) => ctl.run_steps(),
        Err(e) => ("fail".into(), format!("setup: {e}"), vec![]),
    };
    if status == "pass" {
        ctl.shot("final");
    }
    result.status = status;
    result.reason = reason;
    result.steps = steps;
    result.cost = ctl.cost;
    result.screenshots = ctl.screenshots.clone();
    result.seconds = ((now() - t0) * 10.0).round() / 10.0;
    drop(ctl);
    drop(server);
    drop(shared);
    let _ = std::fs::remove_dir_all(&sock_dir);
    ctx.run.note(&format!("[{}] {} in {:.1} s{}", test.name, result.status.to_uppercase(), result.seconds, if result.reason.is_empty() { String::new() } else { format!(": {}", result.reason) }));
    result
}

/// Run every test (`parallel` at a time). Returns the results in test order.
pub fn run_all(ctx: Arc<Ctx>, tests: Vec<TestCase>) -> Vec<TestResult> {
    let n = tests.len();
    let queue = Arc::new(Mutex::new((0..n).collect::<Vec<_>>()));
    let tests = Arc::new(tests);
    let out: Arc<Mutex<Vec<Option<TestResult>>>> = Arc::new(Mutex::new(vec![None; n]));
    let mut handles = vec![];
    for _ in 0..ctx.opts.parallel.max(1).min(n.max(1)) {
        let (q, t, o, c) = (queue.clone(), tests.clone(), out.clone(), ctx.clone());
        handles.push(std::thread::spawn(move || loop {
            let next = {
                let mut q = q.lock().unwrap();
                if q.is_empty() {
                    None
                } else {
                    Some(q.remove(0))
                }
            };
            let Some(i) = next else { break };
            let r = if crate::agent::STOP.load(Ordering::SeqCst) {
                TestResult { name: t[i].name.clone(), file: t[i].file.display().to_string(), status: "skipped".into(), reason: "interrupted".into(), profile: String::new(), seconds: 0.0, cost: 0.0, steps: vec![], screenshots: vec![] }
            } else {
                run_test(&c, &t[i], i)
            };
            o.lock().unwrap()[i] = Some(r);
        }));
    }
    for h in handles {
        let _ = h.join();
    }
    let v = out.lock().unwrap().clone();
    v.into_iter().flatten().collect()
}

pub fn finish(run: &Run, results: &[TestResult]) {
    let passed = results.iter().filter(|r| r.status == "pass").count();
    let summary = format!("{passed}/{} tests passed", results.len());
    let status = if passed == results.len() { "Submitted" } else { "TestsFailed" };
    run.push(json!({"role": "exit", "content": summary, "extra": {"exit_status": status, "submission": summary, "timestamp": now()}}));
    run.save(true);
}

pub fn new_run(project: &Project, base_url: &str, cost_limit: f64, task: &str) -> Arc<Run> {
    let stamp = {
        let t = now() as i64;
        let out = std::process::Command::new("date").arg("-d").arg(format!("@{t}")).arg("+%Y-%m-%dT%H-%M-%S").output().ok().map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string()).unwrap_or_default();
        if out.is_empty() {
            t.to_string()
        } else {
            out
        }
    };
    let dir = project.out_dir.join(format!("{stamp}-{}", crate::util_hex(4)));
    let _ = std::fs::create_dir_all(&dir);
    Run::new(dir, base_url, cost_limit, task)
}

pub fn write_worker_configs(dir: &Path, step_limit: i64) -> Result<(PathBuf, PathBuf), String> {
    let a = dir.join("worker.yaml");
    let b = dir.join("worker-vision.yaml");
    std::fs::write(&a, worker::worker_config(step_limit, false)).map_err(|e| e.to_string())?;
    std::fs::write(&b, worker::worker_config(step_limit, true)).map_err(|e| e.to_string())?;
    Ok((a, b))
}
