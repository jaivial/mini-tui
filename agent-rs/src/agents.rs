//! Agents: named, reusable definitions of a subagent (name, description, when to use it, its
//! specialization as a system prompt, its model), and the native tools a session uses to define
//! them, pick one for a task, delegate to it, message it, or hand its own work over to the next.
//!
//! An agent at work is a SESSION: a child of the session that started it, whose conversation is a
//! byte-for-byte copy of its source's (the delegating session, or for a handoff the agent handing
//! over) with the model switched to the agent's. The copy is the frozen prefix the provider's
//! prompt cache serves; the specialization and the task are appended after it, never before, so
//! the prefix stays identical across every agent started from the same point (speed10: worker
//! prompt tokens served cached 49-63% -> 78-86% once the prefix was stable and warmed).
//!
//! Definitions live in `~/.config/mini-tui/agents/<name>.json` (`MINITUI_AGENTS_DIR`), plus the
//! built-in `general` agent every install has. The native tools are offered only when mini-tui
//! asks for them (`MINITUI_AGENT_TOOLS=1`): a plain run sends exactly the tools it always did, so
//! the parity suite (byte-for-byte requests against the Python agent) is unaffected.
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::path::PathBuf;

const GENERAL: &str = include_str!("../agents/general.json");

/// The native agent tools are on for this process (mini-tui sets it; children inherit it).
pub fn tools_enabled() -> bool {
    std::env::var("MINITUI_AGENT_TOOLS").map(|v| v == "1").unwrap_or(false)
}

pub fn dir() -> PathBuf {
    match std::env::var("MINITUI_AGENTS_DIR").ok().filter(|v| !v.is_empty()) {
        Some(d) => PathBuf::from(d),
        None => crate::config::home().join(".config/mini-tui/agents"),
    }
}

#[derive(Clone, Debug)]
pub struct Def {
    pub name: String,
    pub description: String,
    pub when_to_use: String,
    pub system_prompt: String,
    pub model: String,
    pub max_steps: Option<i64>,
    pub builtin: bool,
}

impl Def {
    fn from_value(v: &Value) -> Option<Def> {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").trim().to_string();
        let name = s("name");
        if !crate::subagents::valid_name(&name) {
            return None;
        }
        Some(Def {
            name,
            description: s("description"),
            when_to_use: s("when_to_use"),
            system_prompt: s("system_prompt"),
            model: s("model"),
            max_steps: v.get("max_steps").and_then(Value::as_i64),
            builtin: v.get("builtin").and_then(Value::as_bool).unwrap_or(false),
        })
    }

    pub fn to_value(&self) -> Value {
        json!({
            "name": self.name,
            "description": self.description,
            "when_to_use": self.when_to_use,
            "system_prompt": self.system_prompt,
            "model": self.model,
            "max_steps": self.max_steps,
            "builtin": self.builtin,
        })
    }
}

/// Every definition: the built-in `general`, then the user's (a user file named `general`
/// replaces the built-in one).
pub fn load() -> BTreeMap<String, Def> {
    let mut out = BTreeMap::new();
    if let Some(d) = serde_json::from_str::<Value>(GENERAL).ok().as_ref().and_then(Def::from_value) {
        out.insert(d.name.clone(), d);
    }
    if let Ok(rd) = std::fs::read_dir(dir()) {
        let mut files: Vec<PathBuf> = rd.flatten().map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect();
        files.sort();
        for p in files {
            let Ok(text) = std::fs::read_to_string(&p) else { continue };
            let Ok(v) = serde_json::from_str::<Value>(&text) else { continue };
            if let Some(mut d) = Def::from_value(&v) {
                d.builtin = false;
                out.insert(d.name.clone(), d);
            }
        }
    }
    out
}

/// Save a definition (the `agent_define` tool). Returns the path written.
pub fn define(spec: &Value) -> Result<(Def, PathBuf), String> {
    let mut d = Def::from_value(spec).ok_or("an agent needs a `name`: letters, digits, '.', '_' or '-'")?;
    if d.description.is_empty() {
        return Err("an agent needs a `description` (what it does: one or two sentences)".into());
    }
    if d.system_prompt.is_empty() {
        return Err("an agent needs a `system_prompt` (its specialization: how it works, what it checks, how it reports)".into());
    }
    if d.system_prompt.chars().count() > 16_000 {
        return Err("the system_prompt is over 16000 chars: keep the specialization short, put reference material in files".into());
    }
    d.builtin = false;
    let dir = dir();
    std::fs::create_dir_all(&dir).map_err(|e| format!("{}: {e}", dir.display()))?;
    let path = dir.join(format!("{}.json", d.name));
    let mut v = d.to_value();
    v["created_at"] = json!(crate::util::now());
    v["created_by"] = json!(std::env::var("MINI_AGENT_NAME").unwrap_or_else(|_| "main".into()));
    v.as_object_mut().unwrap().shift_remove("builtin");
    let tmp = path.with_extension("json.tmp");
    std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, &path).map_err(|e| e.to_string())?;
    Ok((d, path))
}

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .split(|c: char| !c.is_alphanumeric())
        .filter(|w| w.chars().count() >= 3)
        .map(|w| {
            // A crude stem so "translations"/"translate"/"translator" meet: the first 6 letters.
            w.chars().take(6).collect::<String>()
        })
        .collect()
}

/// Rank the definitions for a task: word overlap with the agent's name (x3), when_to_use (x2) and
/// description (x1). Deterministic and instant -- the model decides WHETHER to delegate; this only
/// answers "which of the agents I have fits this task best". `general` is the fallback at score 0.
pub fn route(task: &str, defs: &BTreeMap<String, Def>) -> Vec<(String, f64)> {
    let tw: std::collections::BTreeSet<String> = words(task).into_iter().collect();
    let mut ranked: Vec<(String, f64)> = defs
        .values()
        .map(|d| {
            let score = |text: &str| words(text).into_iter().collect::<std::collections::BTreeSet<_>>().intersection(&tw).count() as f64;
            let s = 3.0 * score(&d.name.replace(['-', '_', '.'], " ")) + 2.0 * score(&d.when_to_use) + score(&d.description);
            (d.name.clone(), if d.name == "general" { s.min(0.5) } else { s })
        })
        .collect();
    ranked.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal).then(a.0.cmp(&b.0)));
    ranked
}

/// The agent for a task: the one named (must exist), or with `auto`/empty the best ranked one.
pub fn pick(agent: &str, task: &str, defs: &BTreeMap<String, Def>) -> Result<Def, String> {
    let agent = agent.trim();
    if !agent.is_empty() && agent != "auto" {
        return defs.get(agent).cloned().ok_or_else(|| format!("no agent named {agent:?} (have: {}). Define it first with agent_define, or use agent \"auto\"", defs.keys().cloned().collect::<Vec<_>>().join(", ")));
    }
    let ranked = route(task, defs);
    let best = ranked.iter().find(|(_, s)| *s >= 1.0).map(|(n, _)| n.clone()).unwrap_or_else(|| "general".into());
    defs.get(&best).cloned().ok_or_else(|| "no agents defined and no built-in general agent".into())
}

/// The message an agent's session starts its own work from, appended AFTER the inherited copy
/// (so the copied prefix stays byte-identical and cached).
pub fn task_message(def: &Def, name: &str, task: &str, started_by: &str, source: &str, kind: &str) -> String {
    let how = match kind {
        "handoff" => format!("{started_by} finished its part and HANDED the work over to you"),
        _ => format!("{started_by} DELEGATED this task to you"),
    };
    format!(
        "<agent name=\"{}\" session=\"{name}\">\n{}\n</agent>\n\n\
         You are now agent `{name}` (a `{}` agent): {how}. Everything above is the conversation of {source}, copied into \
         your own session: it is background you already know, not instructions to replay -- do not repeat its tool calls, \
         and do only the task below.\n\
         Coordination: `agent_message` talks to `parent`, to another agent by name, or to your own subagents (an agent \
         you message answers you when its turn ends); `agent_handoff` finishes your part and passes the work to the next \
         agent; `agent_delegate` splits your task across subagents of your own that run in parallel. When your part is \
         done, end your turn with a short report: what you did, what you checked, what the next one must know.\n\n\
         TASK:\n{task}",
        def.name,
        if def.system_prompt.is_empty() { &def.description } else { &def.system_prompt },
        def.name,
    )
}

// ---- native tools ----------------------------------------------------------------------------

fn tool_specs() -> Vec<(&'static str, &'static str, Value)> {
    vec![
        (
            "agent_define",
            "Create (or update) a reusable AGENT: a named specialist this session and its subagents can delegate to. \
             Define one when a kind of work will recur or needs a specialization the general agent lacks \
             (translations, code review, deployment, a framework expert...). Saved for every future session.",
            json!({
                "type": "object",
                "properties": {
                    "name": {"type": "string", "description": "short id: letters, digits, '-', '_' (e.g. translator, reviewer, deployer)"},
                    "description": {"type": "string", "description": "what this agent does, one or two sentences"},
                    "when_to_use": {"type": "string", "description": "the tasks it should get: keywords and situations (used to route tasks to it)"},
                    "system_prompt": {"type": "string", "description": "its specialization: how it works, what it must check, its standards, how it reports or hands off"},
                    "model": {"type": "string", "description": "optional model id for it (e.g. zai/glm-5.3-flash); empty = the model of the session that starts it"}
                },
                "required": ["name", "description", "system_prompt"]
            }),
        ),
        (
            "agent_route",
            "Find which agent fits a task: ranks the defined agents (and the built-in `general`) for the task text, \
             and shows each one's description. Use it to decide whether a part of your work should be delegated and to whom.",
            json!({
                "type": "object",
                "properties": {"task": {"type": "string", "description": "the task (or part of it) you are considering delegating"}},
                "required": ["task"]
            }),
        ),
        (
            "agent_delegate",
            "Delegate work to agents that run IN THE BACKGROUND while you keep working. Each delegated agent is a new \
             session that starts as an exact copy of YOUR conversation (it knows everything you know; the provider's \
             prompt cache is reused) on the agent's own model, plus its task. Give several tasks to fan out in parallel. \
             You are notified when each one finishes (no polling): keep working, or end your turn to wait for them.",
            json!({
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "agent name, or \"auto\" to route by the task (falls back to `general`)"},
                    "task": {"type": "string", "description": "the task: complete and self-contained for its part"},
                    "name": {"type": "string", "description": "optional session name for this agent (default: the agent name)"},
                    "model": {"type": "string", "description": "optional model override for this run"},
                    "tasks": {
                        "type": "array",
                        "description": "fan out: several delegations at once, each {agent, task, name?, model?}; they run in parallel",
                        "items": {"type": "object", "properties": {"agent": {"type": "string"}, "task": {"type": "string"}, "name": {"type": "string"}, "model": {"type": "string"}}, "required": ["task"]}
                    }
                }
            }),
        ),
        (
            "agent_message",
            "Send a message to another agent session without waiting: `parent` (the session that started you), one of \
             your own subagents, or a sibling agent by name (e.g. a reviewer telling the translator what to fix). The \
             recipient reads it before its next step (or continues with its full context if it had finished) and its \
             answer comes back to you when its turn ends.",
            json!({
                "type": "object",
                "properties": {
                    "to": {"type": "string", "description": "`parent`, or the session name of an agent"},
                    "text": {"type": "string", "description": "the message: for corrections, each finding with file/line and the check to rerun"}
                },
                "required": ["to", "text"]
            }),
        ),
        (
            "agent_handoff",
            "Finish YOUR part and pass the work to the next agent (a pipeline: translate -> review -> deploy). The next \
             agent starts as a copy of YOUR conversation on its own model, as a sibling under the same parent, and \
             continues from where you stopped. After calling it, end your turn with a one-line summary. If the next \
             agent sends you corrections later, you will be woken with them.",
            json!({
                "type": "object",
                "properties": {
                    "agent": {"type": "string", "description": "the next agent's name (or \"auto\")"},
                    "task": {"type": "string", "description": "what the next agent must do with your work"},
                    "name": {"type": "string", "description": "optional session name for it (default: the agent name)"}
                },
                "required": ["agent", "task"]
            }),
        ),
    ]
}

/// The tools in the chat-completions shape (empty when the agent tools are off).
pub fn chat_tools() -> Vec<Value> {
    if !tools_enabled() {
        return vec![];
    }
    tool_specs().into_iter().map(|(n, d, p)| json!({"type": "function", "function": {"name": n, "description": d, "parameters": p}})).collect()
}

pub fn responses_tools() -> Vec<Value> {
    if !tools_enabled() {
        return vec![];
    }
    tool_specs().into_iter().map(|(n, d, p)| json!({"type": "function", "name": n, "description": d, "parameters": p})).collect()
}

pub fn anthropic_tools() -> Vec<Value> {
    if !tools_enabled() {
        return vec![];
    }
    tool_specs().into_iter().map(|(n, d, p)| json!({"name": n, "description": d, "input_schema": p})).collect()
}

pub fn is_tool(name: &str) -> bool {
    matches!(name, "agent_define" | "agent_route" | "agent_delegate" | "agent_message" | "agent_handoff")
}

fn sh_quote(s: &str) -> String {
    format!("'{}'", s.replace('\'', "'\\''"))
}

/// The shell command a native agent tool call runs (through the bash tool's own path, so it is
/// journaled, shown and timed like any command): `mini-agent-rs agent <verb> --spec '<json>'`.
pub fn command_for(name: &str, args: &Value) -> Value {
    let verb = name.trim_start_matches("agent_");
    let args = if args.is_object() { args.clone() } else { json!({}) };
    Value::String(format!("mini-agent-rs agent {verb} --spec {}", sh_quote(&args.to_string())))
}

// ---- the client side ---------------------------------------------------------------------

fn describe(defs: &BTreeMap<String, Def>) -> String {
    let mut out = String::new();
    for d in defs.values() {
        out.push_str(&format!(
            "- {}{}{}: {}\n",
            d.name,
            if d.builtin { " (built-in)" } else { "" },
            if d.model.is_empty() { String::new() } else { format!(" [{}]", d.model) },
            d.description
        ));
        if !d.when_to_use.is_empty() {
            out.push_str(&format!("    use for: {}\n", d.when_to_use));
        }
    }
    out
}

fn spec_of(rest: &[String]) -> Result<Value, String> {
    let mut spec = json!({});
    let mut i = 0;
    let mut free: Vec<String> = vec![];
    while i < rest.len() {
        match rest[i].as_str() {
            "--spec" => {
                let raw = rest.get(i + 1).ok_or("--spec needs a JSON object")?;
                let v: Value = serde_json::from_str(raw).map_err(|e| format!("--spec: {e}"))?;
                if let Value::Object(o) = v {
                    for (k, v) in o {
                        spec[k] = v;
                    }
                }
                i += 1;
            }
            "--json" => spec["json_out"] = json!(true),
            a => free.push(a.to_string()),
        }
        i += 1;
    }
    if !free.is_empty() && spec.get("task").is_none() {
        spec["free"] = json!(free.join(" "));
    }
    Ok(spec)
}

fn hub_request(var: &str, req: &Value) -> Result<Value, String> {
    let socket = std::env::var(var).ok().filter(|s| !s.is_empty()).ok_or_else(|| {
        if var == "MINI_AGENT_PARENT_SOCKET" {
            "this session was not started by another agent (it is the root session): there is no parent to talk to".to_string()
        } else {
            "no session agent to talk to (MINI_AGENT_SOCKET is not set): agent tools run inside a mini-agent-rs session".to_string()
        }
    })?;
    crate::subagents::request(&socket, req, 60)
}

fn print_reply(r: Result<Value, String>) -> i32 {
    match r {
        Ok(v) => {
            let out = v.get("output").and_then(Value::as_str).unwrap_or("");
            if v.get("ok").and_then(Value::as_bool) == Some(true) {
                println!("{out}");
                0
            } else {
                eprintln!("error: {out}");
                1
            }
        }
        Err(e) => {
            eprintln!("error: {e}");
            2
        }
    }
}

/// `mini-agent-rs agent define|route|agents|delegate|handoff|message ...`; `None` = not ours.
pub fn client(cmd: &str, rest: &[String]) -> Option<i32> {
    if !matches!(cmd, "define" | "route" | "agents" | "defs" | "delegate" | "handoff" | "message") {
        return None;
    }
    let spec = match spec_of(rest) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: {e}");
            return Some(2);
        }
    };
    let me = std::env::var("MINI_AGENT_NAME").unwrap_or_else(|_| "main".into());
    let s = |k: &str| spec.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    Some(match cmd {
        "agents" | "defs" => {
            let defs = load();
            if spec.get("json_out").is_some() {
                println!("{}", json!(defs.values().map(Def::to_value).collect::<Vec<_>>()));
            } else {
                print!("{}", describe(&defs));
            }
            0
        }
        "define" => match define(&spec) {
            Ok((d, path)) => {
                // Tell this session's hub (if any) so the definition shows in its message log.
                if let Ok(sock) = std::env::var("MINI_AGENT_SOCKET") {
                    let _ = crate::subagents::request(&sock, &json!({"cmd": "agent_event", "kind": "define", "from": me, "to": d.name, "text": d.description}), 5);
                }
                println!("defined agent {} -> {}\nDelegate to it with agent_delegate {{\"agent\": \"{}\", \"task\": ...}}.", d.name, path.display(), d.name);
                0
            }
            Err(e) => {
                eprintln!("error: {e}");
                1
            }
        },
        "route" => {
            let task = if s("task").is_empty() { s("free") } else { s("task") };
            let defs = load();
            let ranked = route(&task, &defs);
            let best = pick("auto", &task, &defs).map(|d| d.name).unwrap_or_else(|_| "general".into());
            let mut out = format!("best fit: {best}\n");
            for (n, sc) in &ranked {
                let d = &defs[n];
                out.push_str(&format!("  {sc:>4.1}  {n}: {}\n", d.description));
            }
            out.push_str("Delegate with agent_delegate {\"agent\": \"<name>\", \"task\": ...} (several tasks at once fan out in parallel).");
            println!("{out}");
            0
        }
        "delegate" => {
            let mut req = spec.clone();
            req["cmd"] = json!("delegate");
            req["cwd"] = json!(std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default());
            req["from"] = json!(me);
            print_reply(hub_request("MINI_AGENT_SOCKET", &req))
        }
        "handoff" => {
            let mut req = spec.clone();
            req["cmd"] = json!("handoff");
            req["cwd"] = json!(std::env::current_dir().map(|p| p.display().to_string()).unwrap_or_default());
            req["from"] = json!(me);
            print_reply(hub_request("MINI_AGENT_PARENT_SOCKET", &req))
        }
        "message" => {
            let to = s("to");
            let text = if s("text").is_empty() { s("free") } else { s("text") };
            if text.trim().is_empty() || to.trim().is_empty() {
                eprintln!("error: agent_message needs `to` and `text`");
                return Some(2);
            }
            let req = json!({"cmd": "message", "from": me, "to": to, "text": text});
            if to == "parent" {
                print_reply(hub_request("MINI_AGENT_PARENT_SOCKET", &req))
            } else {
                // One of my own subagents first; else a sibling, through the parent's hub.
                let own = std::env::var("MINI_AGENT_SOCKET").ok().filter(|v| !v.is_empty()).map(|sock| crate::subagents::request(&sock, &json!({"cmd": "message", "from": "parent-of", "to": to, "text": text, "own": true}), 60));
                match own {
                    Some(Ok(v)) if v.get("ok").and_then(Value::as_bool) == Some(true) => print_reply(Ok(v)),
                    _ if std::env::var("MINI_AGENT_PARENT_SOCKET").is_ok_and(|v| !v.is_empty()) => print_reply(hub_request("MINI_AGENT_PARENT_SOCKET", &req)),
                    Some(r) => print_reply(r),
                    None => print_reply(Err(format!("no agent named {to} to message"))),
                }
            }
        }
        _ => unreachable!(),
    })
}
