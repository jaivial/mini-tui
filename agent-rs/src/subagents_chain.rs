//! Agents on the hub: delegate (fan-out), handoff (pipelines between peers), messages between
//! sessions, and the session inheritance they all start from.
//!
//! INHERITANCE. A delegated or handed-over agent is a new session whose conversation is a
//! byte-for-byte copy of its source's journal -- the delegating session's, or for a handoff the
//! agent handing over -- replayed as its own history, with the model switched to the agent's. The
//! copy ends at the source's last observation, which is exactly the message list of the source's
//! own last model call: on the same model, the provider already holds that prefix (the KV the
//! source just computed); on another model, the hub warms the worker model's cache with the same
//! prefix (one call, max_tokens 1) at the moment the agents start (speed10: warm TTFT 1.0-2.5 s vs
//! 2.4-5.5 s cold; a request sent while the warmup is in flight already hits). The agent's
//! specialization and task come AFTER the copy, so every agent started from one point shares the
//! prefix byte for byte. The first call of each agent records prompt/cached tokens: the measured
//! reuse is in `index.json` (and on the web), not assumed.
//!
//! MESSAGING. Every hop goes through the hub of the session that owns the recipient, and nothing
//! blocks: a message lands before the recipient's next step, or wakes it with its full context if
//! its turn had ended. An agent that was messaged by a peer answers that peer when its turn ends
//! (the reply is routed to the peer, not to the parent); an agent that handed its work over or
//! is waiting on a peer's reply does not wake the parent. The parent is woken when a chain really
//! ends. Everything is logged to `subagents/events.jsonl` (what the web draws).
use super::{now, s, Child, Hub};
use crate::agents::{self, Def};
use serde_json::{json, Value};
use std::io::Write;

/// Per-child agent state (kept on the hub's `Child`).
#[derive(Default, Clone)]
pub struct ChildChain {
    /// The agent definition it runs (`general`, `translator`...). Empty = a plain `agent spawn`.
    pub agent: String,
    /// `delegate` or `handoff` (or empty for a plain spawn).
    pub origin: String,
    /// Who started it: `parent` (the hub's own session) or a sibling's name (handoff).
    pub from: String,
    /// The peer to answer when this turn ends (it was messaged by that peer).
    pub reply_to: String,
    /// It handed its work over during this turn: its turn end does not wake the parent.
    pub handed_off: String,
    /// It messaged a peer and waits for the answer: its turn end does not wake the parent.
    pub awaiting: String,
    /// It delegated to subagents of its own and waits for them (until its own hub wakes it).
    pub waiting_children: Vec<String>,
    /// Prompt / cached tokens of its first model call: the inherited prefix, measured.
    pub first_prompt: u64,
    pub first_cached: u64,
    pub prompt_total: u64,
    pub cached_total: u64,
    pub inherited_messages: usize,
    pub warm: String,
    /// When its session started (calls before it are the inherited copy's).
    pub started: f64,
    /// The task it was delegated or handed (without the agent header), for the UIs.
    pub brief: String,
}

pub enum TurnEnd {
    Notify,
    Quiet(String),
    Reply(String),
}

fn usage_n(u: &Value, ptrs: &[&str]) -> u64 {
    ptrs.iter().filter_map(|p| u.pointer(p).and_then(Value::as_u64)).next().unwrap_or(0)
}

impl ChildChain {
    /// A user-role message landed in its journal: one of its own subagents reported. It is still
    /// waiting until every child it fanned out to has reported (a note per finished turn reads
    /// `[subagent <name>] finished its turn`).
    pub fn observe_user(&mut self, m: &Value) {
        if m.pointer("/extra/interrupt_type").and_then(Value::as_str) != Some("Subagent") {
            return;
        }
        let text = super::content_text(m);
        self.waiting_children.retain(|n| !(text.contains(&format!("[subagent {n}] finished")) || text.contains(&format!("[subagent {n}] stopped"))));
    }

    pub fn observe(&mut self, m: &Value) {
        // The inherited copy is replayed into the journal first: its assistant messages carry the
        // SOURCE's usage, not this agent's. Only calls made after it count (they have a timestamp
        // later than the agent's start, which `started` holds).
        let at = m.pointer("/extra/timestamp").and_then(Value::as_f64).unwrap_or(0.0);
        if at > 0.0 && at < self.started {
            return;
        }
        let Some(u) = m.pointer("/extra/response/usage") else { return };
        let cached = usage_n(u, &["/prompt_tokens_details/cached_tokens", "/cache_read_input_tokens", "/input_tokens_details/cached_tokens"]);
        let mut prompt = usage_n(u, &["/prompt_tokens", "/input_tokens"]);
        if u.get("cache_read_input_tokens").is_some() {
            // Anthropic counts the cached part outside input_tokens.
            prompt += cached + usage_n(u, &["/cache_creation_input_tokens"]);
        }
        if self.first_prompt == 0 {
            self.first_prompt = prompt;
            self.first_cached = cached;
        }
        self.prompt_total += prompt;
        self.cached_total += cached;
    }

    pub fn decorate(&self, v: &mut Value) {
        v["agent"] = json!(self.agent);
        v["origin"] = json!(self.origin);
        v["from"] = json!(self.from);
        v["reply_to"] = json!(self.reply_to);
        v["awaiting"] = json!(self.awaiting);
        v["handed_off"] = json!(self.handed_off);
        v["waiting_children"] = json!(self.waiting_children);
        v["brief"] = json!(clip(&self.brief, 600));
        v["cache"] = json!({
            "inherited_messages": self.inherited_messages,
            "first_prompt": self.first_prompt,
            "first_cached": self.first_cached,
            "prompt_total": self.prompt_total,
            "cached_total": self.cached_total,
            "warm": self.warm,
        });
    }

    /// What the end of a turn does: wake the parent, stay quiet (a handoff, a pending peer
    /// question), or answer the peer that asked.
    pub fn on_turn_end(&mut self) -> TurnEnd {
        if !self.reply_to.is_empty() && self.reply_to != "parent" {
            let to = std::mem::take(&mut self.reply_to);
            self.handed_off.clear();
            return TurnEnd::Reply(to);
        }
        self.reply_to.clear();
        if !self.handed_off.is_empty() {
            let to = std::mem::take(&mut self.handed_off);
            return TurnEnd::Quiet(format!("handed over to {to}"));
        }
        if !self.awaiting.is_empty() {
            return TurnEnd::Quiet(format!("waiting for {}", self.awaiting));
        }
        if !self.waiting_children.is_empty() {
            return TurnEnd::Quiet(format!("waiting for its subagents {}", self.waiting_children.join(", ")));
        }
        TurnEnd::Notify
    }
}

fn clip(t: &str, n: usize) -> String {
    let t = t.trim();
    if t.chars().count() <= n {
        t.to_string()
    } else {
        format!("{}…", t.chars().take(n).collect::<String>())
    }
}

/// The answer a finished child gave (its submission, else its last text).
pub(super) fn answer_of(c: &Child) -> String {
    if !c.submission.trim().is_empty() {
        c.submission.clone()
    } else if !c.exit_text.trim().is_empty() && c.exit_status != "Submitted" {
        format!("{}: {}", c.exit_status, c.exit_text)
    } else {
        c.last_text.clone()
    }
}

impl Hub {
    pub(super) fn event(&self, kind: &str, from: &str, to: &str, text: &str, extra: Value) {
        let mut v = json!({"at": now(), "kind": kind, "from": from, "to": to, "text": clip(text, 1500)});
        if let Value::Object(o) = extra {
            for (k, x) in o {
                v[k] = x;
            }
        }
        let _ = std::fs::create_dir_all(&self.dir);
        if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(self.dir.join("events.jsonl")) {
            let _ = writeln!(f, "{v}");
        }
    }

    fn free_name(&self, base: &str) -> String {
        let taken = |n: &str| self.children.iter().any(|c| c.name == n);
        if !taken(base) {
            return base.to_string();
        }
        (2..).map(|i| format!("{base}-{i}")).find(|n| !taken(n)).unwrap()
    }

    /// The copy a new agent session starts from: `source`'s conversation, byte for byte (exits
    /// dropped, as a resumed session replays it). Compaction markers stay: the copy's context
    /// view is then the same one the source sends.
    fn copy_of(&mut self, source: &str) -> Result<(Vec<Value>, String), String> {
        if source == "parent" || source.is_empty() {
            let msgs = super::read_messages(&self.journal);
            if msgs.is_empty() {
                return Err(format!("this session has no saved conversation to copy yet ({})", self.journal.display()));
            }
            return Ok((msgs, "the session that delegated".into()));
        }
        let c = self.child(source)?;
        let msgs = super::read_messages(&c.journal);
        if msgs.is_empty() {
            return Err(format!("{source} has no saved conversation to copy yet"));
        }
        Ok((msgs, format!("agent {source}")))
    }

    fn model_for(&self, def: &Def, model: &str) -> String {
        if !model.is_empty() {
            model.to_string()
        } else if !def.model.is_empty() {
            def.model.clone()
        } else {
            self.parent_model.clone()
        }
    }

    /// Start one agent session as a copy of `source` (see the module doc). Returns its model.
    fn start_agent(&mut self, def: &Def, name: &str, task: &str, model: &str, source: &str, kind: &str, cwd: &str, copy: &[Value], label: &str) -> Result<String, String> {
        let started_by = if source == "parent" { "the session that started you".to_string() } else { format!("agent {source}") };
        let message = agents::task_message(def, name, task, &started_by, label, kind);
        let model = self.model_for(def, model);
        let mut req = json!({
            "cmd": "spawn",
            "name": name,
            "task": message,
            "model": model,
            "inherit_messages": copy,
            "cwd": cwd,
        });
        if let Some(n) = def.max_steps {
            req["max_steps"] = json!(n);
        }
        let out = self.launch(&req)?;
        let parent_model = self.parent_model.clone();
        let c = self.child(name)?;
        c.chain.started = c.started_at;
        c.chain.brief = task.to_string();
        c.chain.agent = def.name.clone();
        c.chain.origin = kind.into();
        c.chain.from = if source.is_empty() { "parent".into() } else { source.into() };
        c.chain.inherited_messages = copy.len();
        let src_model = if source == "parent" { parent_model } else { self.children.iter().find(|c| c.name == source).map(|c| c.model.clone()).unwrap_or_default() };
        let c = self.child(name)?;
        c.chain.warm = if model == src_model {
            format!("same model as {}: its own last call cached this prefix", if source == "parent" { "the parent" } else { source })
        } else {
            format!("cross-model ({src_model} -> {model}): {model} cache warmed with the copy first")
        };
        let _ = out;
        Ok(model)
    }

    /// One call, max_tokens 1, on the worker model with the copied prefix: the cache the agents
    /// started from it will read. Only when their model is not the source's (same model = the
    /// source's own last call already cached it). Measured, logged as a `warmup` event.
    fn warmup(&self, model: &str, copy: &[Value], for_names: &[String]) -> Option<Warm> {
        if std::env::var("MINI_AGENT_WARMUP").map(|v| v == "0").unwrap_or(false) || model.is_empty() {
            return None;
        }
        if copy.iter().any(|m| m.pointer("/extra/compaction").is_some()) {
            return None; // a compacted copy's view is rebuilt by the agent: not this list
        }
        let warm = Warm::default();
        let done = warm.0.clone();
        let configs = self.configs.clone();
        let msgs: Vec<Value> = copy.to_vec();
        let dir = self.dir.clone();
        let model = model.to_string();
        let names = for_names.join(", ");
        std::thread::spawn(move || {
            let t0 = std::time::Instant::now();
            let over = crate::config::Overrides { task: None, model_name: Some(model.clone()), model_class: None, agent_class: None, environment_class: None, cost_limit: None, output: None, yolo: true, exit_immediately: true };
            let r = (|| -> Result<Value, String> {
                let cfg = crate::config::build_run_config(&configs, &over)?;
                let mut mc = cfg.get("model").and_then(Value::as_object).cloned().unwrap_or_default();
                let mut kw = mc.get("model_kwargs").and_then(Value::as_object).cloned().unwrap_or_default();
                kw.insert("max_tokens".into(), json!(1));
                mc.insert("model_kwargs".into(), Value::Object(kw));
                let mut m = crate::models::get_model(None, &mc)?;
                // Exactly what each agent replays before its own task: the copy, its unanswered
                // tool call closed the way the agent closes it (providers refuse an open one).
                let view = crate::agent::Agent::repair_tool_call_history(msgs.into_iter().filter(|m| m.get("role").and_then(Value::as_str) != Some("exit")).collect());
                match m.query(&view, None).map_err(|e| format!("{}: {}", e.kind, e.message))? {
                    crate::models::Reply::Message(x) => Ok(x.pointer("/extra/response/usage").cloned().unwrap_or(Value::Null)),
                    crate::models::Reply::FormatError(ms) => Ok(ms.first().and_then(|x| x.pointer("/extra/response/usage")).cloned().unwrap_or(Value::Null)),
                }
            })();
            done.store(true, std::sync::atomic::Ordering::SeqCst);
            let mut v = json!({"at": now(), "kind": "warmup", "from": "hub", "to": names, "model": model, "seconds": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0});
            match r {
                Ok(u) => {
                    v["text"] = json!(format!("warmed the {model} cache for {names}: {} prompt tokens", usage_n(&u, &["/prompt_tokens", "/input_tokens"])));
                    v["usage"] = u;
                }
                Err(e) => v["text"] = json!(format!("warmup failed: {}", clip(&e, 300))),
            }
            if let Ok(mut f) = std::fs::OpenOptions::new().create(true).append(true).open(dir.join("events.jsonl")) {
                let _ = writeln!(f, "{v}");
            }
        });
        Some(warm)
    }

    /// `agent_delegate`: one task or a fan-out (`tasks`), each a copy of THIS session.
    pub(super) fn delegate_cmd(&mut self, req: &Value) -> Result<Value, String> {
        let defs = agents::load();
        let mut items: Vec<Value> = req.get("tasks").and_then(Value::as_array).cloned().unwrap_or_default();
        if items.is_empty() {
            items.push(req.clone());
        }
        if items.iter().any(|i| s(i, "task").trim().is_empty()) {
            return Err("agent_delegate needs a `task` (or `tasks`, each with its task)".into());
        }
        let cwd = s(req, "cwd");
        let (copy, label) = self.copy_of("parent")?;
        // Resolve every agent first: the warmups go out before any agent's first call.
        let mut jobs: Vec<Job> = vec![];
        let mut taken: Vec<String> = vec![];
        for it in &items {
            let task = s(it, "task");
            let def = agents::pick(&s(it, "agent"), &task, &defs)?;
            let want = s(it, "name");
            let base = if want.is_empty() { def.name.clone() } else { want };
            let mut name = self.free_name(&base);
            let mut k = 2;
            while taken.contains(&name) {
                name = self.free_name(&format!("{base}-{k}"));
                k += 1;
            }
            if !super::valid_name(&name) {
                return Err(format!("invalid agent session name {name:?}"));
            }
            taken.push(name.clone());
            let model = self.model_for(&def, &s(it, "model"));
            jobs.push(Job { def, name, task, model, source: "parent".into(), kind: "delegate".into(), cwd: cwd.clone(), label: label.clone() });
        }
        let mut by_model: std::collections::BTreeMap<String, Vec<String>> = Default::default();
        for j in &jobs {
            by_model.entry(j.model.clone()).or_default().push(j.name.clone());
        }
        let parent_model = self.parent_model.clone();
        let warms: Vec<Warm> = by_model.into_iter().filter(|(m, _)| *m != parent_model).filter_map(|(m, names)| self.warmup(&m, &copy, &names)).collect();
        let mut lines = vec![];
        let names: Vec<String> = jobs.iter().map(|j| j.name.clone()).collect();
        for j in &jobs {
            self.event("delegate", "parent", &j.name, &j.task, json!({"agent": j.def.name, "model": j.model, "inherited": copy.len()}));
            lines.push(format!("delegated to {} (agent {}, model {}): a copy of this session ({} messages) + its task", j.name, j.def.name, j.model, copy.len()));
        }
        if !warms.is_empty() {
            lines.push("The worker model's prompt cache is warmed with that copy first; the agents start the moment it is written.".into());
        }
        self.launch_jobs(jobs, copy, warms);
        self.write_index();
        // This session is itself an agent: tell the hub above that its turn end is a wait for
        // these children, not the end of its work (the parent is not woken for it).
        if let (Ok(sock), Ok(me)) = (std::env::var("MINI_AGENT_PARENT_SOCKET"), std::env::var("MINI_AGENT_NAME")) {
            let _ = super::request(&sock, &json!({"cmd": "waits_on", "name": me, "on": names}), 5);
        }
        lines.push(format!(
            "{} running in the background. You will be told when each finishes (no polling): keep working on something else, or end your turn to wait.",
            if names.len() == 1 { "It is".to_string() } else { format!("All {} are", names.len()) }
        ));
        Ok(json!({"ok": true, "output": lines.join("\n"), "data": {"started": names}}))
    }

    /// `agent_handoff` from child `from`: the next agent starts as a copy of `from`'s session,
    /// as its sibling. `from`'s turn end then does not wake the parent.
    pub(super) fn handoff_cmd(&mut self, req: &Value) -> Result<Value, String> {
        let from = s(req, "from");
        let task = s(req, "task");
        if task.trim().is_empty() {
            return Err("agent_handoff needs a `task` for the next agent".into());
        }
        let defs = agents::load();
        let def = agents::pick(&s(req, "agent"), &task, &defs)?;
        let cwd = {
            let c = s(req, "cwd");
            if c.is_empty() { self.child(&from).map(|c| c.cwd.clone()).unwrap_or_default() } else { c }
        };
        let (copy, label) = self.copy_of(&from)?;
        let want = s(req, "name");
        let name = self.free_name(if want.is_empty() { &def.name } else { &want });
        let model = self.model_for(&def, &s(req, "model"));
        // Same model as the agent handing over: its own last call cached this prefix already.
        let src_model = self.child(&from).map(|c| c.model.clone()).unwrap_or_default();
        let warms: Vec<Warm> = if model != src_model { self.warmup(&model, &copy, std::slice::from_ref(&name)).into_iter().collect() } else { vec![] };
        if let Ok(c) = self.child(&from) {
            c.chain.handed_off = name.clone();
        }
        let def_name = def.name.clone();
        let n_copy = copy.len();
        self.event("handoff", &from, &name, &task, json!({"agent": def_name, "model": model, "inherited": n_copy}));
        self.launch_jobs(vec![Job { def, name: name.clone(), task, model: model.clone(), source: from, kind: "handoff".into(), cwd, label }], copy, warms);
        self.write_index();
        Ok(json!({"ok": true, "output": format!(
            "handed over to {name} (agent {def_name}, model {model}): it starts from a copy of your session ({n_copy} messages) and continues. End your turn now with a one-line summary; if {name} sends you corrections you will be woken with them."
        )}))
    }

    /// Deliver `text` from `from` to child `to` (mid-turn or waking it), and remember to route its
    /// answer back when `from` is a peer.
    fn deliver(&mut self, from: &str, to: &str, text: &str, kind: &str) -> Result<String, String> {
        let header = match kind {
            "reply" => format!("[reply from {from}]"),
            _ if from == "parent" => "[message from the session that started you]".to_string(),
            _ => format!("[message from agent {from}] (your answer goes back to {from} when your turn ends)"),
        };
        let out = self.send(&json!({"name": to, "text": format!("{header}\n{text}")}))?;
        // An agent that messages the peer that asked it is answering: that is the reply, so its
        // own turn end does not deliver a second copy.
        let mut answering = false;
        if kind != "reply" && from != "parent" {
            if let Ok(c) = self.child(from) {
                if c.chain.reply_to == to {
                    c.chain.reply_to.clear();
                    answering = true;
                }
            }
            if let Ok(c) = self.child(to) {
                if c.chain.awaiting == from {
                    c.chain.awaiting.clear();
                }
            }
        }
        if kind != "reply" {
            let c = self.child(to)?;
            // A peer waiting for this agent's answer keeps its claim: a note from the parent in
            // between does not steal the reply.
            if from != "parent" || c.chain.reply_to.is_empty() {
                c.chain.reply_to = from.to_string();
            }
        }
        if from != "parent" {
            if let Ok(c) = self.child(from) {
                // A reply (or a message that answers the asker) does not open a new wait.
                if kind != "reply" && !answering {
                    c.chain.awaiting = to.to_string();
                }
            }
        }
        if kind == "reply" {
            if let Ok(c) = self.child(to) {
                if c.chain.awaiting == from {
                    c.chain.awaiting.clear();
                }
            }
        }
        self.event(kind, from, to, text, json!({}));
        Ok(out)
    }

    /// `agent_message`: from this hub's session to its child (`own`), or from a child to the
    /// parent / to a sibling.
    pub(super) fn message_cmd(&mut self, req: &Value) -> Result<Value, String> {
        let from = s(req, "from");
        let to = s(req, "to");
        let text = s(req, "text");
        if req.get("own").and_then(Value::as_bool).unwrap_or(false) {
            self.child(&to)?;
            let out = self.deliver("parent", &to, &text, "message")?;
            return Ok(json!({"ok": true, "output": format!("{out}. Its answer reaches you when its turn ends.")}));
        }
        if to == "parent" {
            self.note(format!("[agent {from}] says: {}", super::head_chars(&text, 4000)));
            self.event("message", &from, "parent", &text, json!({}));
            return Ok(json!({"ok": true, "output": "delivered to the session that started you: it reads it before its next step"}));
        }
        if to == from {
            return Err("an agent cannot message itself".into());
        }
        self.child(&to)?;
        let out = self.deliver(&from, &to, &text, "message")?;
        Ok(json!({"ok": true, "output": format!("{out}. Its answer comes back to you when its turn ends: end your turn now if you need it to continue.")}))
    }

    /// After the monitor: answers routed to the peers that asked, and quiet turn ends logged.
    pub(super) fn after_turns(&mut self, routes: Vec<(String, String)>, quiet: Vec<(String, String)>, notified: Vec<String>) {
        for (name, why) in quiet {
            let (steps, cost) = self.children.iter().find(|c| c.name == name).map(|c| (c.steps, c.total_cost())).unwrap_or((0, 0.0));
            self.event("done", &name, "", &format!("turn ended ({why})"), json!({"steps": steps, "cost": cost}));
        }
        for (name, to) in routes {
            let answer = self.children.iter().find(|c| c.name == name).map(answer_of).unwrap_or_default();
            if self.deliver(&name, &to, &answer, "reply").is_err() {
                // The peer is gone: the parent gets it instead.
                self.note(format!("[agent {name}] answered {to}, who is gone:\n{}", super::head_chars(&answer, 4000)));
            }
        }
        for name in notified {
            // A peer still waiting on this agent would hang "waiting" forever: its answer went to
            // the parent, so hand it to the peer too.
            let waiters: Vec<String> = self.children.iter().filter(|c| c.chain.awaiting == name).map(|c| c.name.clone()).collect();
            for w in waiters {
                let answer = self.children.iter().find(|c| c.name == name).map(answer_of).unwrap_or_default();
                let _ = self.deliver(&name, &w, &answer, "reply");
            }
            let Some(c) = self.children.iter().find(|c| c.name == name) else { continue };
            let chain = self.chain_path(&name);
            let text = answer_of(c);
            let status = if c.exit_status.is_empty() { "done".to_string() } else { c.exit_status.clone() };
            self.event("done", &name, "parent", &text, json!({"status": status, "chain": chain}));
        }
    }

    /// `a -> b -> c`: the handoffs that led to `name` (empty when it was not handed anything).
    pub(super) fn chain_path(&self, name: &str) -> Vec<String> {
        let mut path = vec![name.to_string()];
        let mut cur = name.to_string();
        for _ in 0..32 {
            let Some(c) = self.children.iter().find(|c| c.name == cur) else { break };
            if c.chain.origin != "handoff" || c.chain.from.is_empty() || c.chain.from == "parent" {
                break;
            }
            cur = c.chain.from.clone();
            path.insert(0, cur.clone());
        }
        if path.len() > 1 { path } else { vec![] }
    }
}

impl Hub {
    /// A child of this hub delegated to subagents of its own (`waits_on` from its hub).
    pub(super) fn waits_on_cmd(&mut self, req: &Value) -> Result<Value, String> {
        let name = s(req, "name");
        let on: Vec<String> = req.get("on").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
        let c = self.child(&name)?;
        c.chain.waiting_children.extend(on.iter().cloned());
        self.event("fanout", &name, &on.join(", "), &format!("{name} split its task across {} subagents of its own", on.len()), json!({"children": on}));
        Ok(json!({"ok": true, "output": ""}))
    }
}

/// A warmup in flight. Measured on Zai glm-5.3-flash (probe3, 1.5k-token prefix): an agent call
/// sent 150 ms after the warmup read 0 cached tokens; one sent 0.5 s or more after it read the
/// whole prefix (1536 of 1543). The prefix is written while the warmup prefills, so the agents
/// wait for the warmup to finish (capped by MINI_AGENT_WARM_WAIT_MS, default 2500 ms).
#[derive(Default, Clone)]
pub(super) struct Warm(std::sync::Arc<std::sync::atomic::AtomicBool>);

impl Warm {
    fn wait_done(&self, cap_ms: u128) {
        let t0 = std::time::Instant::now();
        while !self.0.load(std::sync::atomic::Ordering::SeqCst) && t0.elapsed().as_millis() < cap_ms {
            std::thread::sleep(std::time::Duration::from_millis(20));
        }
    }
}

/// An agent session to start (after its warmup).
pub(super) struct Job {
    def: Def,
    name: String,
    task: String,
    model: String,
    source: String,
    kind: String,
    cwd: String,
    label: String,
}

impl Hub {
    /// Start `jobs` now, or -- when a warmup is in flight -- from a thread once it has written the
    /// prefix: the caller (the delegating model) gets its answer at once either way.
    fn launch_jobs(&mut self, jobs: Vec<Job>, copy: Vec<Value>, warms: Vec<Warm>) {
        if warms.is_empty() {
            for j in jobs {
                self.start_job(j, &copy);
            }
            return;
        }
        let cap: u128 = std::env::var("MINI_AGENT_WARM_WAIT_MS").ok().and_then(|v| v.parse().ok()).unwrap_or(2500);
        std::thread::spawn(move || {
            for w in &warms {
                w.wait_done(cap);
            }
            let Some(hub) = super::HUB.get() else { return };
            let Ok(mut h) = hub.lock() else { return };
            for j in jobs {
                h.start_job(j, &copy);
            }
            h.write_index();
        });
    }

    fn start_job(&mut self, j: Job, copy: &[Value]) {
        if let Err(e) = self.start_agent(&j.def, &j.name, &j.task, &j.model, &j.source, &j.kind, &j.cwd, copy, &j.label) {
            self.event("error", "hub", &j.name, &format!("could not start {}: {e}", j.name), json!({}));
            if j.source == "parent" {
                self.note(format!("[agent {}] could not start: {e}", j.name));
            } else {
                let _ = self.send(&json!({"name": j.source, "text": format!("[hub] your handoff to {} failed: {e}", j.name)}));
                if let Ok(c) = self.child(&j.source) {
                    c.chain.handed_off.clear();
                }
            }
        }
    }
}
