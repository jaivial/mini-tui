//! The agent loop (`agents/default.py::DefaultAgent`): query, execute, observe; limits,
//! format errors, the control file (`MODEL`/`MESSAGE`/`COMPACT`), holding at exit for a
//! follow-up, context compaction, and the journal + atomic export mini-tui reads.

use crate::compaction as cmp;
use crate::environment::{Environment, Outcome};
use crate::models::{get_model, Model, ModelError, Reply};
use crate::templates::render;
use crate::util::{extra, get, has_extra_key, merge_into, now, py_json, role, round1, Obj};
use serde_json::{json, Value};
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

pub const VERSION: &str = "2.4.6";

/// Set by the SIGINT/SIGTERM handler; checked between steps, while waiting and while a
/// command runs (which is then killed with its whole process group).
pub static STOP: AtomicBool = AtomicBool::new(false);
/// Sleep that a stop signal cuts short (Python's `time.sleep` is interrupted the same way).
/// Returns false when it was interrupted.
pub fn interruptible_sleep(d: std::time::Duration) -> bool {
    let end = std::time::Instant::now() + d;
    while std::time::Instant::now() < end {
        if STOP.load(Ordering::SeqCst) {
            return false;
        }
        std::thread::sleep((end - std::time::Instant::now()).min(std::time::Duration::from_millis(20)));
    }
    !STOP.load(Ordering::SeqCst)
}

/// Process group of the command running now (0 = none), killed with us on SIGTERM.
pub static CHILD_GROUP: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

/// The signal that stopped us (re-raised on exit, so the parent sees the same status).
pub static SIGNAL: std::sync::atomic::AtomicI32 = std::sync::atomic::AtomicI32::new(0);

pub struct AgentConfig {
    pub system_template: String,
    pub instance_template: String,
    pub step_limit: i64,
    pub cost_limit: f64,
    pub wall_time_limit_seconds: i64,
    pub max_consecutive_format_errors: i64,
    pub output_path: Option<PathBuf>,
    pub compaction_enabled: bool,
    pub threshold: f64,
    pub max_context_tokens: i64,
    pub reserve_tokens: i64,
    pub keep_recent_tokens: i64,
}

fn num(o: &Obj, k: &str) -> Option<f64> {
    o.get(k).and_then(Value::as_f64)
}

impl AgentConfig {
    pub fn from(o: &Obj) -> Result<Self, String> {
        let s = |k: &str| o.get(k).and_then(Value::as_str).map(String::from).ok_or(format!("agent config is missing `{k}`"));
        let comp = o.get("compaction").and_then(Value::as_object).cloned().unwrap_or_default();
        let env_f = |k: &str, d: &str| std::env::var(k).unwrap_or_else(|_| d.into());
        Ok(AgentConfig {
            system_template: s("system_template")?,
            instance_template: s("instance_template")?,
            step_limit: num(o, "step_limit").unwrap_or(0.0) as i64,
            cost_limit: num(o, "cost_limit").unwrap_or(0.0), // Jaime 2026-10-09: no default cost limit
            wall_time_limit_seconds: num(o, "wall_time_limit_seconds").unwrap_or(0.0) as i64,
            max_consecutive_format_errors: num(o, "max_consecutive_format_errors").unwrap_or(3.0) as i64,
            output_path: o.get("output_path").and_then(Value::as_str).map(PathBuf::from),
            compaction_enabled: comp.get("enabled").and_then(Value::as_bool).unwrap_or(env_f("MSWEA_AUTO_COMPACT", "1") != "0"),
            threshold: num(&comp, "threshold").unwrap_or(env_f("MSWEA_COMPACT_THRESHOLD", "0.8").parse().unwrap_or(0.8)),
            max_context_tokens: num(&comp, "max_context_tokens").map(|x| x as i64).unwrap_or(env_f("MSWEA_COMPACT_MAX_TOKENS", "0").parse().unwrap_or(0)),
            reserve_tokens: num(&comp, "reserve_tokens").unwrap_or(32000.0) as i64,
            keep_recent_tokens: num(&comp, "keep_recent_tokens").unwrap_or(0.0) as i64,
        })
    }

    /// pydantic's `model_dump(mode="json")`: declared fields only, in declaration order.
    pub fn dump(&self) -> Obj {
        let v = json!({
            "system_template": self.system_template,
            "instance_template": self.instance_template,
            "step_limit": self.step_limit,
            "cost_limit": self.cost_limit,
            "wall_time_limit_seconds": self.wall_time_limit_seconds,
            "max_consecutive_format_errors": self.max_consecutive_format_errors,
            "output_path": self.output_path.as_ref().map(|p| p.display().to_string()),
            "compaction": {
                "enabled": self.compaction_enabled,
                "threshold": self.threshold,
                "max_context_tokens": self.max_context_tokens,
                "reserve_tokens": self.reserve_tokens,
                "keep_recent_tokens": self.keep_recent_tokens,
            },
        });
        v.as_object().cloned().unwrap()
    }
}

/// How a step ended when it did not simply add messages.
enum Flow {
    /// Messages to add (an exit message among them ends the run).
    Interrupt(Vec<Value>),
    FormatError(Vec<Value>),
    Fatal(ModelError),
}

pub struct Agent {
    pub config: AgentConfig,
    pub messages: Vec<Value>,
    model: Box<dyn Model>,
    env: Box<dyn Environment>,
    extra_vars: Obj,
    cost: f64,
    n_calls: i64,
    format_errors: i64,
    start: f64,
    journal_path: Option<PathBuf>,
    journaled: usize,
    export_messages: usize,
    export_at: f64,
    compact_requested: bool,
    compacting: Option<String>,
    control_model: Option<String>,
    calibration: Option<f64>,
    /// The model name as asked for (`-m`, the config, then `MODEL` switches): routable, unlike the
    /// client's own id (which drops the provider prefix). Subagents start on it.
    pub requested_model: String,
    /// Run-wide timing totals (plan item 6): harness milliseconds vs model milliseconds.
    harness_ms: f64,
    model_ms: f64,
    /// The context-view build and the model call of the step in flight (ms), handed from
    /// `query_model` / `query` to the stamping that happens after the observations render.
    last_view_ms: f64,
    last_model_ms: f64,
    last_save_ms: f64,
    /// The prompt-cache warmer (plan item 5), ticking from the idle waits.
    warmer: crate::cache_warmer::Warmer,
    /// The fast path (`src/intent.rs`) already produced this run's answer: `run`'s loop breaks
    /// at its first turn instead of opening. False for every run that went through the normal
    /// loop, and for a fast path that declined or failed.
    fastpath_answered: bool,
}

impl Agent {
    pub fn new(model: Box<dyn Model>, env: Box<dyn Environment>, config: AgentConfig) -> Self {
        Agent {
            config,
            messages: vec![],
            model,
            env,
            extra_vars: Obj::new(),
            cost: 0.0,
            n_calls: 0,
            format_errors: 0,
            start: now(),
            journal_path: None,
            journaled: 0,
            export_messages: 0,
            export_at: 0.0,
            compact_requested: false,
            compacting: None,
            control_model: None,
            calibration: None,
            requested_model: String::new(),
            harness_ms: 0.0,
            model_ms: 0.0,
            last_view_ms: 0.0,
            last_model_ms: 0.0,
            last_save_ms: 0.0,
            warmer: crate::cache_warmer::Warmer::new(),
            fastpath_answered: false,
        }
    }

    fn template_vars(&self) -> Value {
        let mut vars = self.config.dump();
        merge_into(&mut vars, &self.env.template_vars());
        merge_into(&mut vars, &self.model.template_vars());
        let mut live = Obj::new();
        live.insert("n_model_calls".into(), json!(self.n_calls));
        live.insert("model_cost".into(), json!(self.cost));
        live.insert("elapsed_seconds".into(), json!((now() - self.start) as i64));
        merge_into(&mut vars, &live);
        merge_into(&mut vars, &self.extra_vars);
        Value::Object(vars)
    }

    fn tool_call_ids(m: &Value) -> Vec<String> {
        get(m, "tool_calls")
            .and_then(Value::as_array)
            .map(|a| {
                a.iter()
                    .filter(|c| !c.is_null())
                    .filter_map(|c| c.get("id"))
                    .filter(|id| !id.is_null() && id.as_str() != Some(""))
                    .map(|id| id.as_str().map(String::from).unwrap_or_else(|| id.to_string()))
                    .collect()
            })
            .unwrap_or_default()
    }

    fn synthetic_results(pending: &std::collections::BTreeSet<String>) -> Vec<Value> {
        pending
            .iter()
            .map(|id| {
                json!({
                    "role": "tool",
                    "tool_call_id": id,
                    "content": "Tool call was interrupted before execution; no result was available.",
                    "extra": {"raw_output": "", "returncode": -1, "exception_info": "action was not executed", "interrupted": true},
                })
            })
            .collect()
    }

    pub(crate) fn repair_tool_call_history(messages: Vec<Value>) -> Vec<Value> {
        let mut out = Vec::new();
        let mut pending = std::collections::BTreeSet::new();
        for m in messages {
            if !m.is_object() {
                continue;
            }
            match role(&m) {
                "assistant" => {
                    if !pending.is_empty() {
                        out.extend(Self::synthetic_results(&pending));
                    }
                    pending = Self::tool_call_ids(&m).into_iter().collect();
                    out.push(m);
                }
                "tool" => {
                    let id = get(&m, "tool_call_id").map(|v| v.as_str().map(String::from).unwrap_or_else(|| v.to_string())).unwrap_or_default();
                    pending.remove(&id);
                    out.push(m);
                }
                _ => {
                    if !pending.is_empty() {
                        out.extend(Self::synthetic_results(&pending));
                        pending.clear();
                    }
                    out.push(m);
                }
            }
        }
        if !pending.is_empty() {
            out.extend(Self::synthetic_results(&pending));
        }
        out
    }

    pub fn add_messages(&mut self, msgs: Vec<Value>) {
        if let (Some(last), Some(first)) = (self.messages.last(), msgs.first()) {
            if role(first) == "user" && role(last) == "assistant" {
                let pending: std::collections::BTreeSet<String> = Self::tool_call_ids(last).into_iter().collect();
                if !pending.is_empty() {
                    let closers = Self::synthetic_results(&pending);
                    self.messages.extend(closers);
                }
            }
        }
        self.messages.extend(msgs);
    }

    fn user_task_message(text: &str) -> Value {
        json!({"role": "user", "content": format!("The user added a new task: {text}"), "extra": {"interrupt_type": "UserNewTask"}})
    }

    fn exit_message(status: &str, content: &str, submission: &str) -> Value {
        json!({"role": "exit", "content": content, "extra": {"exit_status": status, "submission": submission}})
    }

    // ---- control channel -------------------------------------------------------------

    fn control_file() -> Option<String> {
        std::env::var("MSWEA_CONTROL_FILE").ok().filter(|s| !s.is_empty())
    }

    /// Whether anyone can send this run a follow-up: the cache warmer only makes sense for a run
    /// that can still be continued (`MINI_AGENT_CACHE_WARMER=auto`, the default).
    pub fn control_file_exists() -> bool {
        Self::control_file().is_some()
    }

    fn drain_control(&mut self) -> (Option<String>, Vec<String>) {
        let Some(path) = Self::control_file() else { return (None, vec![]) };
        let Ok(raw) = std::fs::read_to_string(&path) else { return (None, vec![]) };
        if raw.trim().is_empty() {
            return (None, vec![]);
        }
        let _ = std::fs::write(&path, "");
        let mut model = None;
        let mut messages = Vec::new();
        for line in py_splitlines(&raw) {
            let line = line.trim();
            if line == "COMPACT" {
                self.compact_requested = true;
            } else if let Some(n) = line.strip_prefix("STEPS ") {
                // A parent extending this subagent's budget: N more model calls from now.
                if let Ok(n) = n.trim().parse::<i64>() {
                    self.config.step_limit = self.n_calls + n.max(1);
                }
            } else if let Some(x) = line.strip_prefix("COST ") {
                if let Ok(x) = x.trim().parse::<f64>() {
                    self.config.cost_limit = self.cost + x.max(0.0);
                }
            } else if let Some(name) = line.strip_prefix("MODEL ") {
                let n = name.trim();
                model = if n.is_empty() { None } else { Some(n.to_string()) };
            } else if let Some(payload) = line.strip_prefix("MESSAGE ") {
                let payload = payload.trim();
                let text = if payload.starts_with('"') {
                    match serde_json::from_str::<Value>(payload) {
                        Ok(Value::String(s)) => s,
                        Ok(other) => py_str(&other),
                        Err(_) => payload.to_string(),
                    }
                } else {
                    payload.to_string()
                };
                if !text.is_empty() {
                    messages.push(text);
                }
            }
        }
        (model, messages)
    }

    fn parent_model_name(&self) -> String {
        if self.requested_model.is_empty() { self.model.model_name() } else { self.requested_model.clone() }
    }

    fn apply_model_switch(&mut self, name: Option<String>) {
        let Some(name) = name else { return };
        if self.control_model.as_deref() == Some(name.as_str()) {
            return;
        }
        self.control_model = Some(name.clone());
        match get_model(Some(&name), &Obj::new()) {
            Ok(m) => {
                self.model = m;
                self.requested_model = name.clone();
            }
            Err(e) => eprintln!("WARNING: could not switch to model {name}: {e}"),
        }
    }

    fn apply_control_commands(&mut self) {
        let (model, messages) = self.drain_control();
        self.apply_model_switch(model);
        self.apply_pending_compaction();
        let mut any = !messages.is_empty();
        for text in messages {
            self.add_messages(vec![Self::user_task_message(&text)]);
        }
        any |= self.add_subagent_notes();
        if any {
            self.save(false);
        }
    }

    /// What this session's subagents reported (finished, failed, stalled, asked) since the last
    /// step, as one user message the model reads before its next call.
    fn add_subagent_notes(&mut self) -> bool {
        crate::subagents::set_parent_state(self.cost, self.config.cost_limit, &self.parent_model_name());
        let notes = crate::subagents::take_notes();
        if notes.is_empty() {
            return false;
        }
        self.add_messages(vec![json!({
            "role": "user",
            "content": notes.join("\n\n"),
            "extra": {"interrupt_type": "Subagent", "timestamp": now()},
        })]);
        true
    }

    fn apply_pending_compaction(&mut self) {
        if !self.compact_requested {
            return;
        }
        self.compact_requested = false;
        if self.compact("manual", 0, false).is_none() {
            self.add_messages(vec![json!({
                "role": "user",
                "content": "[Context compaction skipped: the conversation is too short to summarize.]",
                "extra": {"interrupt_type": "CompactionSkipped", "timestamp": now()},
            })]);
            self.save(false);
        }
    }

    /// Hold at exit for a follow-up: true when a `MESSAGE` arrived.
    fn wait_for_followup(&mut self) -> Result<bool, ModelError> {
        if Self::control_file().is_none() {
            // No one can send a follow-up (a headless run), but subagents still at work will
            // report: hold for them, so ending a turn never kills the children it started.
            while crate::subagents::live_children() > 0 {
                if STOP.load(Ordering::SeqCst) {
                    return Err(interrupted_idle());
                }
                if crate::subagents::has_notes() && self.add_subagent_notes() {
                    self.save(false);
                    return Ok(true);
                }
                self.warm_cache();
                interruptible_sleep(std::time::Duration::from_millis(200));
            }
            return Ok(self.add_subagent_notes());
        }
        loop {
            if STOP.load(Ordering::SeqCst) {
                return Err(interrupted_idle());
            }
            let (model, messages) = self.drain_control();
            self.apply_model_switch(model);
            self.apply_pending_compaction();
            if !messages.is_empty() {
                for text in messages {
                    self.add_messages(vec![Self::user_task_message(&text)]);
                }
                self.add_subagent_notes();
                self.save(false);
                return Ok(true);
            }
            // A subagent finishing (or asking) wakes a session that holds at its exit: it reads
            // the report and carries on, instead of waiting for the user to poke it.
            if crate::subagents::has_notes() && self.add_subagent_notes() {
                self.save(false);
                return Ok(true);
            }
            self.warm_cache();
            interruptible_sleep(std::time::Duration::from_millis(200));
        }
    }

    /// One cache-warmer tick from an idle wait (plan item 5). A refresh replays the request that
    /// produced the last assistant message with a one-token cap, so the prompt prefix the next
    /// real call needs is still cached. The note it returns is appended to the journal (a
    /// `cache_warm` line), never to the conversation: warming is not a turn, and its cost stays
    /// out of `model_stats` because it did no work.
    ///
    /// The replay runs inline in the idle loop (pi's warmer is async; this agent has no runtime),
    /// so a follow-up that arrives *during* a warm waits for it. A one-token reply is one
    /// provider round-trip, and the same timeout bounds it as any real call, so the worst case
    /// is one request's latency --- never a hang the run cannot recover from.
    fn warm_cache(&mut self) {
        // Cheap first: the state the decision needs, before any clone. The view (the whole
        // conversation) is only built once the warmer says a refresh is due, because this runs
        // every 200 ms of an idle wait.
        if !crate::cache_warmer::active() {
            return;
        }
        let prompt_tokens = self.context_view().last().and_then(|m| crate::compaction::prompt_tokens(m)).unwrap_or(0);
        let prices = self.model.cache_prices();
        let ttl = self.model.cache_ttl_secs();
        let due = self.warmer.refresh_due(ttl, prompt_tokens, prices);
        if !due {
            return;
        }
        let view: Vec<Value> = self.context_view().cloned().collect();
        let model = &mut self.model;
        let note = self.warmer.run_due(prompt_tokens, prices, ttl, |max_tokens| {
            let _ = max_tokens; // the cap is the model's own business (it owns `max_tokens`)
            model.warm_cache(&view)
        });
        if let Some(note) = note {
            self.journal_note(&note);
            // Re-save so the journal's `info` line (and `traj.json`) carry the warmer's count and
            // cost: a run inspected or resumed after an idle stretch sees what warming spent.
            self.save(false);
        }
    }

    // ---- the run -----------------------------------------------------------------------

    pub fn run(&mut self, task: &str, resume: Option<Vec<Value>>, compact_only: bool) -> Result<Obj, ModelError> {
        self.extra_vars.insert("task".into(), json!(task));
        crate::subagents::set_parent_state(self.cost, self.config.cost_limit, &self.parent_model_name());
        if let Some(resume) = resume.filter(|r| !r.is_empty()) {
            self.messages = Self::repair_tool_call_history(resume.into_iter().filter(|m| role(m) != "exit").collect());
            if compact_only {
                self.compact_requested = true;
                self.apply_pending_compaction();
                if !self.wait_for_followup()? {
                    self.save(true);
                    return Ok(self.messages.last().map(extra).unwrap_or_default());
                }
            } else {
                self.add_messages(vec![Self::user_task_message(task)]);
            }
        } else if compact_only {
            return Err(ModelError { message: "compact_only requires resume_messages".into(), status: None, abort: true, kind: "ValueError".into(), connect_refused: false, retry_after: None, });
        } else {
            self.messages.clear();
            let vars = self.template_vars();
            let system = render(&self.config.system_template, &vars).map_err(template_error)?;
            let instance = render(&self.config.instance_template, &vars).map_err(template_error)?;
            let sys = self.model.format_message("system", &system, None);
            let user = self.model.format_message("user", &instance, None);
            // Priority 1 of the round-3: a task that needs no machine answers in ONE call, with
            // no tool list at all, instead of opening the loop that would have it explore the repo
            // to answer "hola". Anything the fast path cannot answer falls through to the loop
            // with the conversation as it was, so quality never depends on the classifier.
            let fast = self.try_fast_path(task);
            if !fast {
                self.add_messages(vec![sys, user]);
            }
        }
        self.save(false);
        loop {
            if self.fastpath_answered {
                break;
            }
            if STOP.load(Ordering::SeqCst) {
                return Err(interrupted());
            }
            let stepped = self.step();
            if STOP.load(Ordering::SeqCst) {
                // Like Python's KeyboardInterrupt: whatever the step appended stays, nothing more.
                if let Err(Flow::Interrupt(msgs)) | Err(Flow::FormatError(msgs)) = stepped {
                    self.add_messages(msgs);
                }
                return Err(interrupted());
            }
            match stepped {
                Ok(()) => self.format_errors = 0,
                Err(Flow::FormatError(msgs)) => {
                    self.cost += msgs.first().map(|m| extra(m).get("cost").and_then(Value::as_f64).unwrap_or(0.0)).unwrap_or(0.0);
                    self.format_errors += 1;
                    let limit = self.config.max_consecutive_format_errors;
                    let mut msgs = msgs;
                    if limit > 0 && limit <= self.format_errors {
                        msgs.push(Self::exit_message("RepeatedFormatError", "RepeatedFormatError", ""));
                    }
                    self.add_messages(msgs);
                }
                Err(Flow::Interrupt(msgs)) => self.add_messages(msgs),
                Err(Flow::Fatal(e)) => {
                    self.add_messages(vec![self.model.format_message(
                        "exit",
                        &e.message,
                        Some(json!({"exit_status": e.kind, "submission": "", "exception_str": e.message, "traceback": format!("{}: {}\n", e.kind, e.message)}).as_object().cloned().unwrap()),
                    )]);
                    self.save(false);
                    return Err(e);
                }
            }
            let save_started = std::time::Instant::now();
            self.save(false);
            self.last_save_ms = save_started.elapsed().as_secs_f64() * 1000.0;
            if self.messages.last().map(role) == Some("exit") {
                let exit = self.messages.pop().unwrap();
                self.journaled = self.journaled.min(self.messages.len());
                match self.wait_for_followup() {
                    Ok(true) => continue,
                    Ok(false) => {}
                    Err(e) => {
                        // Python is killed while holding at exit: the exit line is journaled,
                        // the popped message is not re-added.
                        return Err(e);
                    }
                }
                self.messages.push(exit);
                break;
            }
        }
        Ok(self.messages.last().map(extra).unwrap_or_default())
    }

    /// One tool-free model call for a task that needs no
    /// machine. Returns true when it answered, which ends the run with that text as the
    /// submission.
    ///
    /// It is deliberately all-or-nothing and it never leaves a half state behind: the normal
    /// `system`+`user` messages are added back when it declines, when the call fails, or when the
    /// reply is unusable, so the loop that follows is exactly the one this run had before. The
    /// three ways it declines are cheap --- the classifier said "work", the classifier is off,
    /// or the provider errored --- and a decline costs nothing but the classification.
    fn try_fast_path(&mut self, task: &str) -> bool {
        if crate::intent::classify(task) != crate::intent::Intent::Conversational {
            return false;
        }
        let view = vec![
            self.model.format_message("system", crate::intent::direct_system(), None),
            self.model.format_message("user", &crate::intent::direct_user(task), None),
        ];
        let started = now();
        let reply_result = match self.model_query_text(&view) {
            Ok(r) => r,
            Err(e) => {
                eprintln!("fast path: the direct call failed ({}); taking the normal loop", e.kind);
                return false;
            }
        };
        self.last_model_ms = (now() - started) * 1000.0;
        self.n_calls += 1;
        // A FormatError here means the provider insisted on a tool call we did not offer; the
        // loop (which does offer them) is the right answer, not a second direct call.
        let message = match reply_result {
            crate::models::Reply::Message(m) => m,
            crate::models::Reply::FormatError(_) => return false,
        };
        // Even with no tool list a provider may answer with tool calls (GLM ignores
        // `tool_choice: "none"`; measured, speed8). If it did, this is not a trivial turn after
        // all: hand the whole conversation to the normal loop rather than pretend it was one.
        if get(&message, "extra").and_then(|e| e.get("actions")).and_then(Value::as_array).is_some_and(|a| !a.is_empty()) {
            return false;
        }
        // The model layer already derived `extra.submission` from the reply (same rule the normal loop
        // uses: no tool calls = the text is the answer). Reuse it verbatim so a fast-path run's
        // transcript is indistinguishable from a one-turn normal run's.
        let text = extra(&message).get("submission").and_then(Value::as_str).unwrap_or_default().to_string();
        if !crate::intent::usable_answer(&text) {
            return false;
        }
        let cost = extra(&message).get("cost").and_then(Value::as_f64).unwrap_or(0.0);
        self.cost += cost;
        let mut extra_map = crate::intent::answer_extra(cost).as_object().cloned().unwrap_or_default();
        extra_map.insert("submission".into(), json!(text));
        extra_map.insert("fastpath_intent".into(), json!("conversational"));
        let mut assistant = message.clone();
        assistant["extra"] = Value::Object(extra_map);
        assistant["extra"]["thinking_seconds"] = json!(round1(now() - started));
        self.add_messages(vec![assistant.clone()]);
        // The answer doubles as the exit message, so the transcript ends the way a normal run's does.
        self.add_messages(vec![Self::exit_message("Submitted", &text, &text)]);
        self.fastpath_answered = true;
        true
    }

    /// The direct call, streamed into the journal like any other (the web UI shows the tokens as
    /// they arrive) but without the per-step view build the normal path pays.
    fn model_query_text(&mut self, view: &[Value]) -> Result<crate::models::Reply, ModelError> {
        self.model.query_text(view, None)
    }

    fn step(&mut self) -> Result<(), Flow> {
        let mut t = crate::timings::StepTimings::start();
        let save_ms = std::mem::take(&mut self.last_save_ms);
        t.add_phase("save", save_ms);
        t.mark("control");
        let message = self.query(Some(&mut t))?;
        // `query` appends the assistant message last, so this is its index for the rest of the
        // step (the observations go after it).
        let at = self.messages.len().saturating_sub(1);
        if let Some(sub) = get(&message, "extra").and_then(|e| e.get("submission")).and_then(Value::as_str) {
            self.record_timings(&mut t, at);
            return Err(Flow::Interrupt(vec![Self::exit_message("Submitted", sub, sub)]));
        }
        // Closes the open `model` label and opens `actions`.
        t.mark("actions");
        let outputs = self.execute_actions(&message)?;
        t.mark("observe");
        self.finish_step(&message, outputs)?;
        self.record_timings(&mut t, at);
        Ok(())
    }

    /// Close the clock and stamp it: onto the assistant message the step produced, and into the
    /// run's totals (`serialize_info` reports them). The stamp happens after the observations are
    /// rendered so `observe` is measured, and before `save` so the journal line that carries the
    /// message already has the timings on it.
    fn record_timings(&mut self, t: &mut crate::timings::StepTimings, at: usize) {
        if !crate::timings::enabled() {
            return;
        }
        t.close();
        let mut t = std::mem::replace(t, crate::timings::StepTimings::start());
        // The view build happens inside the model phase (before the call); pulling it out is
        // what distinguishes "the harness cloned the conversation again" from "the model thought".
        t.add_phase("view", std::mem::take(&mut self.last_view_ms));
        self.harness_ms += t.total();
        self.model_ms += self.last_model_ms;
        let Some(m) = self.messages.get_mut(at) else { return };
        if role(m) != "assistant" || m.get("extra").and_then(|e| e.get("timings")).is_some() {
            return;
        }
        crate::timings::stamp(m, &t, self.last_model_ms);
    }

    fn query(&mut self, t: Option<&mut crate::timings::StepTimings>) -> Result<Value, Flow> {
        let mut owned;
        let t = match t {
            Some(t) => t,
            None => {
                owned = crate::timings::StepTimings::start();
                &mut owned
            }
        };
        t.mark("control");
        self.apply_control_commands();
        t.mark("model");
        let c = &self.config;
        let spent = self.cost + crate::subagents::children_cost();
        if (c.step_limit > 0 && c.step_limit <= self.n_calls) || (c.cost_limit > 0.0 && c.cost_limit <= spent) {
            return Err(Flow::Interrupt(vec![Self::exit_message("LimitsExceeded", "LimitsExceeded", "")]));
        }
        if c.wall_time_limit_seconds > 0 && c.wall_time_limit_seconds <= (now() - self.start) as i64 {
            return Err(Flow::Interrupt(vec![Self::exit_message("TimeExceeded", "TimeExceeded", "")]));
        }
        self.n_calls += 1;
        let started = now();
        let mut message = self.query_model()?;
        self.last_model_ms = (now() - started) * 1000.0;
        // A completed call is what the warmer keeps warm: the entry it wrote is the one the next
        // call (a follow-up, a compaction) would otherwise rebuild from scratch.
        self.warmer.observed_call();
        self.cost += extra(&message).get("cost").and_then(Value::as_f64).unwrap_or(0.0);
        if !message.get("extra").is_some_and(Value::is_object) {
            message["extra"] = json!({});
        }
        message["extra"]["thinking_seconds"] = json!(round1(now() - started));
        self.add_messages(vec![message.clone()]);
        Ok(message)
    }

    fn model_query(&mut self, view: &[Value]) -> Result<Reply, ModelError> {
        let path = self.config.output_path.clone();
        if !self.model.streams() || path.is_none() {
            return self.model.query(view, None);
        }
        let journal = journal_path(path.as_ref().unwrap());
        let interval: f64 = std::env::var("MSWEA_PARTIAL_INTERVAL").ok().and_then(|s| s.parse().ok()).unwrap_or(0.2);
        let mut last = 0.0;
        let mut buf = String::new();
        // One handle for the whole call instead of an open/close per flush: a streamed reply
        // flushes every `interval` (0.2 s), so a long generation was paying dozens of
        // open+create syscalls to append to the file it already owns.
        let mut journal_file = std::fs::OpenOptions::new().append(true).create(true).open(&journal).ok();
        let mut sink = |kind: &str, text: &str| {
            buf.push_str(text);
            let t = now();
            if t - last < interval {
                return;
            }
            last = t;
            let chunk = std::mem::take(&mut buf);
            let line = py_json(&json!({"t": "delta", "k": kind, "x": chunk}), true);
            if let Some(f) = journal_file.as_mut() {
                let _ = writeln!(f, "{line}");
            }
        };
        let reply = self.model.query(view, Some(&mut sink));
        drop(sink);
        drop(journal_file); // release before `save` reopens/appends the same file
        reply
    }

    fn query_model(&mut self) -> Result<Value, Flow> {
        // The compaction estimate and the context build are the two passes a step makes over the
        // whole conversation before any bytes go to the provider; timing them separately from the
        // call is what showed the per-step clone (plan item 3, ~27 ms/step).
        let view_started = std::time::Instant::now();
        self.maybe_compact();
        let mut view = self.context_messages();
        let view_ms = view_started.elapsed().as_secs_f64() * 1000.0;
        self.last_view_ms = view_ms;
        let reply = match self.model_query(&view) {
            Ok(r) => r,
            Err(e) => {
                if !self.config.compaction_enabled || !cmp::is_context_overflow(&e.kind, &e.message) {
                    return Err(Flow::Fatal(e));
                }
                cmp::learn_window(&self.model.model_name(), &e.message);
                if self.compact("overflow", 0, true).is_none() {
                    return Err(Flow::Fatal(e));
                }
                view = self.context_messages();
                let budget = (self.compaction_trigger() as f64 / self.tokens_per_char(&view)) as i64;
                if cmp::messages_chars(&view) > budget {
                    let head = cmp::head_length(&view, budget / 10) + 1;
                    view = cmp::shrink(&view, head, budget);
                }
                self.model_query(&view).map_err(Flow::Fatal)?
            }
        };
        let mut message = match reply {
            Reply::Message(m) => m,
            Reply::FormatError(msgs) => return Err(Flow::FormatError(msgs)),
        };
        let chars = cmp::messages_chars(&view);
        if !message.get("extra").is_some_and(Value::is_object) {
            message["extra"] = json!({});
        }
        message["extra"]["context_chars"] = json!(chars);
        if let Some(tokens) = cmp::prompt_tokens(&message) {
            self.calibration = Some(tokens as f64 / chars.max(1) as f64);
        }
        Ok(message)
    }

    /// Run the step's actions and return their observations **in issue order**; the caller renders
    /// them into messages (`finish_step`) so the timing clock can tell execution from rendering.
    fn execute_actions(&mut self, message: &Value) -> Result<Vec<Value>, Flow> {
        let actions: Vec<Value> = message.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut outputs = Vec::new();
        // A single action, or concurrency disabled: the plain serial loop, unchanged.
        if actions.len() < 2 || action_concurrency(actions.len()) < 2 {
            for action in &actions {
                if STOP.load(Ordering::SeqCst) {
                    break;
                }
                if let Some(native) = self.native_outcome(action) {
                    outputs.push(native);
                    continue;
                }
                let command = action.get("command").map(|c| c.as_str().map(String::from).unwrap_or_else(|| py_str(c))).unwrap_or_default();
                match self.env.execute(&command) {
                    Outcome::Output(o) => outputs.push(o),
                    Outcome::Submitted(s) => {
                        let s = match crate::subagents::join_wave() {
                            Some(joined) => {
                                let _ = crate::subagents::take_notes();
                                format!("{s}\n{joined}")
                            }
                            None => s,
                        };
                        return Err(Flow::Interrupt(vec![Self::exit_message("Submitted", &s, &s)]));
                    }
                    Outcome::Stopped => return Err(Flow::Interrupt(vec![])),
                }
            }
            return Ok(outputs);
        }
        // More than one action: run them overlapped on worker threads, then collect them back
        // **in the order they were issued**, so the observation messages the model sees are
        // identical to the serial path's. Execution overlaps; the transcript does not change.
        // Reads never spawn: they run inline (a file open plus a bounded copy, microseconds), in
        // input order, and only the shell commands go to the overlapped batch. Results land back
        // in the order the actions were issued, so the observation messages stay byte-identical
        // to the serial path's.
        let mut slots: Vec<Option<Value>> = (0..actions.len()).map(|_| None).collect();
        let mut batch: Vec<(usize, String)> = Vec::new();
        for (i, action) in actions.iter().enumerate() {
            match self.native_outcome(action) {
                Some(native) => slots[i] = Some(native),
                None => batch.push((i, action.get("command").map(|c| c.as_str().map(String::from).unwrap_or_else(|| py_str(c))).unwrap_or_default())),
            }
        }
        let results = self.env.execute_batch(&batch.iter().map(|(_, c)| c.clone()).collect::<Vec<String>>());
        let mut submitted: Option<String> = None;
        let mut stopped = false;
        for ((i, _), r) in batch.iter().zip(results) {
            match r {
                Outcome::Output(o) => slots[*i] = Some(o),
                Outcome::Submitted(s) => {
                    submitted = Some(s);
                    break;
                }
                Outcome::Stopped => {
                    stopped = true;
                    break;
                }
            }
        }
        if let Some(s) = submitted {
            let s = match crate::subagents::join_wave() {
                Some(joined) => {
                    let _ = crate::subagents::take_notes();
                    format!("{s}\n{joined}")
                }
                None => s,
            };
            return Err(Flow::Interrupt(vec![Self::exit_message("Submitted", &s, &s)]));
        }
        if stopped {
            return Err(Flow::Interrupt(vec![]));
        }
        for slot in slots {
            outputs.push(slot.unwrap_or_else(crate::models::shapes::not_executed));
        }
        Ok(outputs)
    }

    /// The tail of a step, shared by the serial and overlapped paths: render the observations.
    fn finish_step(&mut self, message: &Value, outputs: Vec<Value>) -> Result<(), Flow> {
        let vars = self.template_vars();
        let obs = self.model.format_observation_messages(message, &outputs, &vars).map_err(|e| Flow::Fatal(template_error(e)))?;
        self.add_messages(obs);
        Ok(())
    }

    /// The observation for a native tool action, or `None` when the action is a shell command.
    /// `read`/`write`/`edit` go straight to the filesystem --- no `/bin/sh`, no process, no
    /// timeout --- which is the point of plan item 4 (a read costs an open and a bounded copy
    /// instead of a spawn) and of the benchmark's item 1 (an edit costs `oldText`/`newText`
    /// instead of the whole file inside a heredoc). `code` additionally runs its script's
    /// `bash` calls through the environment's own execute path, so they are journaled, timed and
    /// killed like any command the model issued directly.
    fn native_outcome(&mut self, action: &Value) -> Option<Value> {
        let tool = action.get("tool").and_then(Value::as_str)?;
        let args = action.get("args").cloned().unwrap_or(json!({}));
        let cwd = self.env.working_dir();
        match tool {
            "read" => Some(crate::tools::read_outcome(&args, &cwd)),
            "write" => Some(crate::writing::write_outcome(&args, &cwd)),
            "edit" => Some(crate::writing::edit_outcome(&args, &cwd)),
            "code" => {
                // The script's `bash` calls run through the environment's own execute path, so
                // they are journaled, timed and killed like commands the model issued directly.
                // A command that submits or is stopped ends the script's shell access there: the
                // observation reports it and the run's own exit path takes over on the next step.
                //
                // SAFETY: the raw pointer is this agent's own `env` field, which outlives the
                // script's evaluation (`code_outcome` returns before `execute_actions` does) and
                // is not touched by anything else while the script runs. The `Send` wrapper only
                // moves the pointer: the script's `bash` calls still run on the agent's own
                // thread, one at a time, so there is no concurrent access to hide.
                let env = SendPtr(&mut *self.env as *mut dyn Environment);
                let mut ctx = crate::writing::CodeCtx {
                    cwd,
                    bash: Box::new(move |cmd: &str| match unsafe { env.execute(cmd) } {
                        Outcome::Output(o) => o,
                        Outcome::Submitted(_) | Outcome::Stopped => {
                            json!({"output": "code: the run ended while this script was running a command", "returncode": -1, "exception_info": "action was not executed"})
                        }
                    }),
                };
                Some(crate::writing::code_outcome(&args, &mut ctx))
            }
            _ => None,
        }
    }

    // ---- compaction ------------------------------------------------------------------

    fn context_indices(&self) -> Vec<usize> {
        let last = (0..self.messages.len()).rev().find(|&i| has_extra_key(&self.messages[i], "compaction"));
        let Some(last) = last else { return (0..self.messages.len()).collect() };
        let info = &self.messages[last]["extra"]["compaction"];
        let head = info["head"].as_u64().unwrap_or(0) as usize;
        let tail_n = info["tail_messages"].as_u64().unwrap_or(0) as usize;
        let start = last.saturating_sub(tail_n).max(head);
        let mut out: Vec<usize> = (0..head).collect();
        out.push(last);
        out.extend((start..self.messages.len()).filter(|&i| i != last && !has_extra_key(&self.messages[i], "compaction")));
        out
    }

    pub fn context_messages(&self) -> Vec<Value> {
        self.context_view().cloned().collect()
    }

    /// The messages the model would see, by reference: the same selection as
    /// [`Self::context_messages`] without cloning it. Everything that only reads (the compaction
    /// estimate, the token calibration) uses this; a clone is reserved for the request itself.
    pub fn context_view(&self) -> impl Iterator<Item = &Value> {
        self.context_indices().into_iter().map(|i| &self.messages[i]).filter(|m| role(m) != "exit")
    }

    fn tokens_per_char(&self, view: &[Value]) -> f64 {
        let refs: Vec<&Value> = view.iter().collect();
        self.tokens_per_char_refs(&refs)
    }

    fn tokens_per_char_refs(&self, view: &[&Value]) -> f64 {
        if let Some(c) = self.calibration.filter(|c| *c != 0.0) {
            return c;
        }
        let compacted = view.iter().any(|m| has_extra_key(m, "compaction"));
        for j in (1..view.len()).rev() {
            if role(view[j]) != "assistant" {
                continue;
            }
            let Some(tokens) = cmp::prompt_tokens(view[j]).filter(|t| *t != 0) else { continue };
            if let Some(chars) = extra(view[j]).get("context_chars").and_then(Value::as_i64).filter(|c| *c != 0) {
                return tokens as f64 / chars as f64;
            }
            if !compacted {
                return tokens as f64 / view[..j].iter().map(|m| cmp::message_chars(m)).sum::<i64>().max(1) as f64;
            }
        }
        1.0 / cmp::DEFAULT_CHARS_PER_TOKEN
    }

    fn window(&self) -> i64 {
        cmp::context_window_for(&self.model.model_name(), self.model.context_window())
    }

    fn compaction_trigger(&self) -> i64 {
        let window = self.window();
        let mut trigger = ((window as f64 * self.config.threshold) as i64).min(window - self.config.reserve_tokens);
        if self.config.max_context_tokens > 0 {
            trigger = trigger.min(self.config.max_context_tokens);
        }
        trigger.max(4000)
    }

    fn maybe_compact(&mut self) {
        if !self.config.compaction_enabled {
            return;
        }
        // References only: this runs every step, and the estimate needs the char total and the
        // calibration, neither of which requires a copy of the conversation. One borrowed view
        // feeds both: the calibration scan reads it, and so must the char sum — an iterator
        // handed to the scan is consumed by it.
        let view: Vec<&Value> = self.context_view().collect();
        let tpc = self.tokens_per_char_refs(&view);
        let chars: i64 = view.iter().map(|m| cmp::message_chars(m)).sum();
        let estimate = (chars as f64 * tpc) as i64;
        if estimate >= self.compaction_trigger() {
            self.compact("auto", estimate, false);
        }
    }

    fn compact(&mut self, reason: &str, estimated: i64, overflow: bool) -> Option<Value> {
        let indices = self.context_indices();
        let view: Vec<Value> = indices.iter().map(|&i| self.messages[i].clone()).collect();
        let tpc = self.tokens_per_char(&view);
        let trigger = self.compaction_trigger();
        let head = cmp::head_length(&self.messages, (trigger as f64 * 0.1 / tpc) as i64);
        let lower = head + usize::from(indices.get(head).is_some_and(|&i| has_extra_key(&self.messages[i], "compaction")));
        let mut keep = if self.config.keep_recent_tokens > 0 { self.config.keep_recent_tokens } else { 60000.min((trigger as f64 * 0.1) as i64) };
        if reason == "manual" {
            keep = keep.min((cmp::messages_chars(&view) as f64 * tpc * 0.25) as i64);
        }
        let tail_pos = cmp::tail_start(&view, lower, (keep as f64 / tpc) as i64);
        if tail_pos <= lower && !overflow {
            return None;
        }
        let mut request = view.clone();
        if overflow || estimated > trigger + self.config.reserve_tokens / 2 {
            request = cmp::shrink(&view, lower, (trigger as f64 / tpc) as i64);
        }
        request.push(json!({"role": "user", "content": cmp::SUMMARY_PROMPT}));
        self.compacting = Some(reason.to_string());
        self.save(false);
        let mut summary_message: Option<Value> = None;
        let mut summary = String::new();
        for attempt in 0..2 {
            match self.model.query(&request, None) {
                Ok(Reply::Message(m)) => {
                    summary = crate::models::shapes::text_of(m.get("content").unwrap_or(&Value::Null)).trim().to_string();
                    summary_message = Some(m);
                    break;
                }
                Ok(Reply::FormatError(msgs)) => {
                    summary = msgs.first().map(|m| crate::models::shapes::text_of(m.get("content").unwrap_or(&Value::Null))).unwrap_or_default().trim().to_string();
                    break;
                }
                Err(e) => {
                    if attempt > 0 || !cmp::is_context_overflow(&e.kind, &e.message) {
                        eprintln!("WARNING: compaction summary failed: {e}");
                        break;
                    }
                    cmp::learn_window(&self.model.model_name(), &e.message);
                    let last = request.pop().unwrap();
                    request = cmp::shrink(&request, lower, (trigger as f64 / tpc / 2.0) as i64);
                    request.push(last);
                }
            }
        }
        self.compacting = None;
        if let Some(m) = &summary_message {
            self.cost += extra(m).get("cost").and_then(Value::as_f64).unwrap_or(0.0);
        }
        if summary.chars().count() < 200 {
            summary = cmp::fallback_summary(&view[lower..tail_pos.max(lower)]);
        }
        let requests = cmp::cap_requests(&cmp::user_requests(&view[head..tail_pos.max(head)]));
        let (prompt, read, write) = cmp::cache_usage(summary_message.as_ref().unwrap_or(&json!({})));
        let tail_start = if tail_pos < indices.len() { indices[tail_pos] } else { self.messages.len() };
        let tail_messages = self.messages.len() - tail_start;
        let tokens_before = if estimated != 0 { estimated } else { (cmp::messages_chars(&view) as f64 * tpc) as i64 };
        let message = json!({
            "role": "user",
            "content": cmp::render_compaction(&summary, &requests),
            "extra": {
                "interrupt_type": "Compaction",
                "compaction": {
                    "head": head,
                    "tail_messages": tail_messages,
                    "reason": reason,
                    "tokens_before": tokens_before,
                    "trigger_tokens": trigger,
                    "context_window": self.window(),
                    "summarized_messages": (tail_pos as i64 - lower as i64).max(0),
                    "summary_usage": {"prompt": prompt, "cache_read": read, "cache_write": write},
                    "user_messages": requests,
                },
                "timestamp": now(),
            },
        });
        self.add_messages(vec![message.clone()]);
        self.save(false);
        Some(message)
    }

    // ---- saving ------------------------------------------------------------------------

    pub fn serialize(&self) -> Value {
        let mut data = self.serialize_info();
        data.as_object_mut().unwrap().insert("messages".into(), Value::Array(self.messages.clone()));
        data
    }

    /// The trajectory document without the messages: everything the journal's `info` line and
    /// the throttled export's bookkeeping need. `serialize` reuses it and adds the messages,
    /// so a step that only journals (the common case) never clones the conversation.
    fn serialize_info(&self) -> Value {
        let last_extra = self.messages.last().map(extra).unwrap_or_default();
        let mut data = json!({
            "info": {
                "model_stats": {"instance_cost": self.cost, "api_calls": self.n_calls},
                "config": {"agent": self.config.dump(), "agent_type": "minisweagent.agents.default.DefaultAgent"},
                "mini_version": VERSION,
                "exit_status": last_extra.get("exit_status").cloned().unwrap_or(json!("")),
                "submission": last_extra.get("submission").cloned().unwrap_or(json!("")),
                "compacting": self.compacting.clone().unwrap_or_default(),
                "timings": crate::timings::run_summary(self.harness_ms, self.model_ms, self.n_calls),
                "cache_warmer": self.warmer.summary(),
            },
            "trajectory_format": "mini-swe-agent-1.1",
        });
        // Only when this session started subagents: a run without any stays byte-identical to
        // the Python agent's trajectory (the parity suite compares them).
        if let Some(children) = crate::subagents::snapshot() {
            data["info"]["subagents"] = children;
            data["info"]["subagents_cost"] = json!(crate::subagents::children_cost());
        }
        let obj = data.as_object_mut().unwrap();
        merge_into(obj, self.model.serialize().as_object().unwrap());
        merge_into(obj, self.env.serialize().as_object().unwrap());
        data
    }

    /// Journal always; the full export when forced, at exit, or on the throttle.
    ///
    /// The journal line only needs `info` plus the messages not written yet, so a step that does
    /// not export builds just that: no clone of the whole conversation. The full document (with
    /// `messages`) is materialized only when the throttled export actually fires, which is
    /// `max(20, len/10)` messages or 60 s apart — the O(steps x messages) term that dominated
    /// `serialize()` on long runs is gone.
    pub fn save(&mut self, force: bool) {
        let Some(path) = self.config.output_path.clone() else { return };
        let t = now();
        let is_exit = self.messages.last().map(role) == Some("exit");
        let every = 20usize.max(self.messages.len() / 10);
        let export = force || is_exit || self.messages.len().saturating_sub(self.export_messages) >= every || t - self.export_at >= 60.0;
        let data = if export { self.serialize() } else { self.serialize_info() };
        if let Some(parent) = path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        self.append_journal(&path, &data);
        if export {
            let tmp = path.with_file_name(format!("{}.tmp", path.file_name().unwrap().to_string_lossy()));
            if std::fs::write(&tmp, py_json(&data, true)).is_ok() {
                let _ = std::fs::rename(&tmp, &path);
            }
            self.export_messages = self.messages.len();
            self.export_at = t;
        }
    }

    fn append_journal(&mut self, path: &Path, data: &Value) {
        let journal = journal_path(path);
        let fresh = self.journal_path.as_deref() != Some(path) || self.journaled == 0;
        let mut lines = Vec::new();
        if fresh {
            self.journal_path = Some(path.to_path_buf());
            self.journaled = 0;
            lines.push(py_json(&json!({"t": "meta", "trajectory_format": data.get("trajectory_format").cloned().unwrap_or(json!(""))}), true));
        }
        for m in &self.messages[self.journaled.min(self.messages.len())..] {
            lines.push(py_json(&json!({"t": "msg", "m": m}), true));
        }
        self.journaled = self.messages.len();
        lines.push(py_json(&json!({"t": "info", "i": data.get("info").cloned().unwrap_or(json!({}))}), true));
        let file = if fresh { std::fs::File::create(&journal) } else { std::fs::OpenOptions::new().append(true).create(true).open(&journal) };
        if let Ok(mut f) = file {
            let _ = f.write_all((lines.join("\n") + "\n").as_bytes());
        }
    }

    /// Append one non-message line to the journal (the cache warmer's `cache_warm` note): it is
    /// bookkeeping about the run, not part of the conversation, so it goes straight to the
    /// journal file the way the streamed deltas do and never into `messages`.
    fn journal_note(&mut self, note: &Value) {
        let Some(path) = self.config.output_path.clone() else { return };
        let journal = journal_path(&path);
        if let Some(parent) = journal.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        if let Ok(mut f) = std::fs::OpenOptions::new().append(true).create(true).open(&journal) {
            let _ = writeln!(f, "{}", py_json(note, true));
        }
    }

    /// The run was stopped by a signal: the `finally: save(force=False)` Python runs.
    pub fn save_interrupted(&mut self) {
        self.save(false);
    }
}

/// A raw pointer that claims `Send` so one closure can borrow the agent's environment. See the
/// `code` arm of [`Agent::native_outcome`] for the safety argument.
struct SendPtr(*mut dyn Environment);
unsafe impl Send for SendPtr {}
impl SendPtr {
    /// # Safety
    /// The pointer must still point at a live environment, and nothing else may use it while
    /// this runs.
    unsafe fn execute(&self, cmd: &str) -> Outcome {
        unsafe { (*self.0).execute(cmd) }
    }
}

/// How many of a step's actions may run at once. The commands of one response are executed
/// in order and every result is observed before the next response, but actions the model
/// issued together do not need to *finish* one after the other: pi runs a whole tool batch
/// with `Promise.all` (`executeToolCallsParallel`), and the same overlap is what makes a
/// multi-action step cost its longest command instead of the sum of them. 4 since the round-2
/// benchmark work (the round-1 ceiling of 2 capped a read+edit+edit+test batch, which is the
/// common shape now that `read`/`write`/`edit` are native). 1 restores the strictly serial
/// behaviour (`MINI_AGENT_PARALLEL_ACTIONS=0`).
pub(crate) fn action_concurrency(actions: usize) -> usize {
    let cfg = std::env::var("MINI_AGENT_PARALLEL_ACTIONS").ok().and_then(|s| s.parse::<usize>().ok()).unwrap_or(4);
    cfg.max(1).min(actions.max(1))
}

fn template_error(e: String) -> ModelError {
    ModelError { message: e, status: None, abort: true, kind: "UndefinedError".into(), connect_refused: false, retry_after: None, }
}

fn interrupted() -> ModelError {
    ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterrupt".into(), connect_refused: false, retry_after: None, }
}

/// Stopped while holding at exit: Python dies in `time.sleep` without saving again.
fn interrupted_idle() -> ModelError {
    ModelError { message: "interrupted".into(), status: None, abort: true, kind: "KeyboardInterruptIdle".into(), connect_refused: false, retry_after: None, }
}

/// `<traj>.json` -> `<traj>.jsonl` (Python's `with_suffix`).
pub fn journal_path(path: &Path) -> PathBuf {
    path.with_extension("jsonl")
}

/// `str(value)` for a non-string JSON value.
fn py_str(v: &Value) -> String {
    match v {
        Value::String(s) => s.clone(),
        Value::Null => "None".into(),
        Value::Bool(true) => "True".into(),
        Value::Bool(false) => "False".into(),
        other => py_json(other, false),
    }
}

/// Python's `str.splitlines()`.
fn py_splitlines(s: &str) -> Vec<&str> {
    let mut out = Vec::new();
    let mut start = 0;
    let bytes: Vec<(usize, char)> = s.char_indices().collect();
    let mut i = 0;
    while i < bytes.len() {
        let (pos, c) = bytes[i];
        if matches!(c, '\n' | '\r' | '\u{0b}' | '\u{0c}' | '\u{1c}' | '\u{1d}' | '\u{1e}' | '\u{85}' | '\u{2028}' | '\u{2029}') {
            out.push(&s[start..pos]);
            let mut next = pos + c.len_utf8();
            if c == '\r' && i + 1 < bytes.len() && bytes[i + 1].1 == '\n' {
                next += 1;
                i += 1;
            }
            start = next;
        }
        i += 1;
    }
    if start < s.len() {
        out.push(&s[start..]);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn repairs_unanswered_tool_calls() {
        let ms = vec![
            json!({"role": "assistant", "tool_calls": [{"id": "b"}, {"id": "a"}]}),
            json!({"role": "tool", "tool_call_id": "a", "content": "x"}),
            json!({"role": "user", "content": "next"}),
        ];
        let out = Agent::repair_tool_call_history(ms);
        assert_eq!(out.len(), 4);
        assert_eq!(out[2]["tool_call_id"], "b");
        assert_eq!(out[2]["extra"]["interrupted"], true);
    }

    #[test]
    fn splitlines() {
        assert_eq!(py_splitlines("a\nb\r\nc"), vec!["a", "b", "c"]);
        assert_eq!(py_splitlines("a\n"), vec!["a"]);
    }
}
