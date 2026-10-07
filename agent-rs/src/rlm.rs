//! The RLM harness (`mini-agent-rs rlm`): a Recursive Language Model execution framework in
//! pure Rust for mini-tui. Long-horizon context lives in program variables (`let` / `set`), and
//! sub-agents are function calls (`def` / `call`): each call runs its own conversation with the
//! model and the bash tool until it answers, and its answer is the call's value. It all happens
//! inside a persistent REPL whose state (variables and functions) survives restarts
//! (`save` / `load`, auto-saved at exit).
//!
//! The language is line oriented: one statement per line, `#` comments. An expression is text
//! with `{{var}}` interpolation (Jinja, strict: an unknown variable is an error), or one of
//! `ask …` (a model turn), `call …` (a whole sub-agent as a function call) or `run …` (a shell
//! command). Recursion is allowed up to `--max-depth` (default 8).

use crate::agent::STOP;
use crate::config;
use crate::environment::{get_environment, Environment, Outcome};
use crate::models::{get_model, shapes, Model, Reply};
use crate::util::{extra, merge_into, Obj};
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::io::{BufRead, Read, Write};
use std::path::PathBuf;
use std::sync::atomic::Ordering;

pub const HELP: &str = "mini-agent-rs rlm - the RLM harness: context as variables, sub-agents as calls

  let NAME = EXPR            bind a variable (the long-horizon context); `{{name}}` interpolates
  set NAME = EXPR            bind a global (from inside a function too)
  EXPR                       evaluate and print; the value is kept in `{{_}}`
  return EXPR                end the current function call with this value
  def NAME(p1, p2)           define a function (a sub-agent program); body ends with `end`
  end
  ask TEXT                   one sub-agent turn: model + bash tool until it answers
  call NAME(args...)         run a function: a whole sub-agent as a function call
  run SHELL                  run a shell command in the session environment
  vars | show NAME | unset NAME     {{findings}}, {{contracts}}, {{decisions}} and {{surface.<repo>}}
                                     are seeded from the shared context/ of the run at startup
  fns | fn NAME
  model [NAME]               show / switch the model     cost  the spend so far
  clear                      start the conversation over  system [TEXT]  the system prompt
  save [PATH] | load [PATH]  persist the REPL state (also automatic at exit)
  help | quit | exit

EXPR is literal text with {{var}} interpolation, or `ask ...`, `call ...`, `run ...`
(prefix a literal with \\ to force it). Statements may appear in scripts (one per line)
or on the interactive prompt.";

const DEFAULT_SYSTEM: &str = "You are a sub-agent inside an RLM harness: your work is one function \
call in a program. Use the bash tool to do it. Reply with plain text to return the result; the \
text is the value the program gets back, so keep it short and self-contained.";

/// One conversation scope: the REPL's own (depth 0) or one function call (its sub-agent).
#[derive(Default)]
struct Frame {
    /// Parameters and `let` bindings of this scope (shadow the globals).
    locals: BTreeMap<String, String>,
    /// The sub-agent conversation (`ask` appends to it across statements).
    messages: Vec<Value>,
    started: bool,
    /// The value of the last expression, exposed as `{{_}}`.
    last: String,
    depth: usize,
}

/// What executing one statement ended with.
enum Flow {
    Next,
    Return(String),
    Quit,
}

#[derive(Clone)]
struct FnDef {
    params: Vec<String>,
    body: Vec<String>,
}

struct Repl {
    /// The shared context of the run tree, if there is one: seeded into the globals at startup so
    /// the program starts from a paid-for exploration instead of from nothing (Fase 7).
    context_dir: PathBuf,
    model: Box<dyn Model>,
    model_cfg: Obj,
    env: Box<dyn Environment>,
    vars: BTreeMap<String, String>,
    fns: BTreeMap<String, FnDef>,
    system: String,
    state_path: Option<PathBuf>,
    top: Frame,
    /// A `def` whose `end` has not been typed yet: (name, params, body lines).
    collecting: Option<(String, Vec<String>, Vec<String>)>,
    cost: f64,
    calls: i64,
    step_limit: usize,
    max_depth: usize,
}

fn ident(name: &str) -> bool {
    let mut cs = name.chars();
    matches!(cs.next(), Some('a'..='z') | Some('A'..='Z') | Some('_')) && cs.all(|c| c.is_ascii_alphanumeric() || c == '_')
}

/// `def name(p1, p2)` -> ("name", ["p1", "p2"]); bare `name` means no parameters.
fn parse_def(rest: &str) -> Result<(String, Vec<String>), String> {
    let rest = rest.trim();
    let (name, inside) = match rest.split_once('(') {
        Some((n, tail)) => {
            let tail = tail.trim();
            let Some(inner) = tail.strip_suffix(')') else {
                return Err("ValueError: usage: def NAME(p1, p2)".into());
            };
            (n.trim(), inner)
        }
        None => (rest, ""),
    };
    if !ident(name) {
        return Err(format!("ValueError: invalid function name: {name}"));
    }
    let mut params = Vec::new();
    for p in inside.split(',') {
        let p = p.trim();
        if p.is_empty() {
            continue;
        }
        if !ident(p) {
            return Err(format!("ValueError: invalid parameter name: {p}"));
        }
        if params.contains(&p.to_string()) {
            return Err(format!("ValueError: duplicate parameter: {p}"));
        }
        params.push(p.to_string());
    }
    Ok((name.to_string(), params))
}

/// Split call arguments on top-level commas, keeping quoted spans together.
fn split_args(s: &str) -> Vec<String> {
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut quote: Option<char> = None;
    for c in s.chars() {
        match (quote, c) {
            (Some(q), c2) if c2 == q => quote = None,
            (Some(_), c2) => cur.push(c2),
            (None, q @ ('\'' | '"')) => quote = Some(q),
            (None, ',') => {
                out.push(std::mem::take(&mut cur).trim().to_string());
            }
            (None, c2) => cur.push(c2),
        }
    }
    out.push(cur.trim().to_string());
    out
}

impl Repl {
    fn new(
        model: Box<dyn Model>,
        model_cfg: Obj,
        env: Box<dyn Environment>,
        state_path: Option<PathBuf>,
        step_limit: usize,
        max_depth: usize,
    ) -> Self {
        let context_dir = std::env::var("MINI_AGENT_CONTEXT_DIR").ok().filter(|s| !s.is_empty()).map(PathBuf::from).unwrap_or_default();
        Repl {
            context_dir,
            model,
            model_cfg,
            env,
            vars: BTreeMap::new(),
            fns: BTreeMap::new(),
            system: DEFAULT_SYSTEM.to_string(),
            state_path,
            top: Frame::default(),
            collecting: None,
            cost: 0.0,
            calls: 0,
            step_limit,
            max_depth,
        }
    }

    /// Bind the shared context into the globals when the REPL opens: `{{findings}}`, `{{contracts}}`,
    /// `{{decisions}}` and `{{surface.<repo>}}`. The RLM needs no new mechanism to share context
    /// between sub-agents -- variables ARE the context and `call` IS a sub-agent -- what it lacked
    /// was a seed, and this is it. Nothing to seed: no-op.
    fn seed_context(&mut self) -> usize {
        if self.context_dir.as_os_str().is_empty() {
            return 0;
        }
        let store = crate::context_store::ContextStore::new(self.context_dir.clone());
        let mut n = 0;
        for (k, v) in store.vars(8 * 1024) {
            let Some(stem) = k.strip_prefix("context.") else { continue };
            if v.trim().is_empty() || self.vars.contains_key(stem) {
                continue; // an explicit `let` of the same name wins over the seed
            }
            self.vars.insert(stem.to_string(), v);
            n += 1;
        }
        n
    }

    /// Interpolate `{{var}}` with the globals, then the frame's locals and `{{_}}` on top.
    fn interp(&self, frame: &Frame, text: &str) -> Result<String, String> {
        let mut ctx = Obj::new();
        for (k, v) in &self.vars {
            ctx.insert(k.clone(), Value::String(v.clone()));
        }
        for (k, v) in &frame.locals {
            ctx.insert(k.clone(), Value::String(v.clone()));
        }
        ctx.insert("_".into(), Value::String(frame.last.clone()));
        crate::templates::render(text, &Value::Object(ctx)).map_err(|e| format!("TemplateError: {e}"))
    }

    fn eval_expr(&mut self, frame: &mut Frame, expr: &str) -> Result<String, String> {
        let expr = expr.trim();
        let value = if let Some(rest) = expr.strip_prefix("call ") {
            let rest = rest.trim();
            let (name, args) = match rest.find('(') {
                Some(i) => {
                    let Some(close) = rest.rfind(')') else {
                        return Err("ValueError: usage: call NAME(args)".into());
                    };
                    if close < i {
                        return Err("ValueError: usage: call NAME(args)".into());
                    }
                    (rest[..i].trim(), &rest[i + 1..close])
                }
                None => (rest, ""),
            };
            if !ident(name) {
                return Err(format!("ValueError: invalid function name: {name}"));
            }
            let args = if args.trim().is_empty() { Vec::new() } else { split_args(args) };
            self.call_fn(frame, name, args)?
        } else if let Some(rest) = expr.strip_prefix("ask ") {
            let prompt = self.interp(frame, rest)?;
            self.ask(frame, &prompt)?
        } else if let Some(rest) = expr.strip_prefix("run ") {
            let command = self.interp(frame, rest)?;
            self.run_cmd(&command)?
        } else {
            if expr == "ask" || expr == "call" || expr == "run" {
                return Err(format!("ValueError: usage: {expr} ..."));
            }
            let text = expr.strip_prefix('\\').unwrap_or(expr);
            self.interp(frame, text)?
        };
        frame.last = value.clone();
        Ok(value)
    }

    /// Run a function call: a sub-agent with its own conversation, params bound, recursion capped.
    fn call_fn(&mut self, parent: &mut Frame, name: &str, raw_args: Vec<String>) -> Result<String, String> {
        let def = self.fns.get(name).cloned().ok_or_else(|| format!("ValueError: unknown function: {name}"))?;
        if raw_args.len() != def.params.len() {
            return Err(format!(
                "ValueError: {name} takes {} args, got {}",
                def.params.len(),
                raw_args.len()
            ));
        }
        if parent.depth + 1 > self.max_depth {
            return Err(format!("RuntimeError: max recursion depth ({}) exceeded", self.max_depth));
        }
        let mut locals = BTreeMap::new();
        for (p, a) in def.params.iter().zip(raw_args) {
            let v = self.interp(parent, &a)?;
            locals.insert(p.clone(), v);
        }
        let mut child = Frame { locals, depth: parent.depth + 1, ..Frame::default() };
        for line in &def.body {
            match self.stmt(&mut child, line)? {
                Flow::Return(v) => return Ok(v),
                Flow::Quit => return Err("RuntimeError: quit inside a function".into()),
                Flow::Next => {}
            }
        }
        Ok(child.last)
    }

    /// One sub-agent turn: query the model, run its bash actions, feed the observations back,
    /// until it answers with plain text (the value) or a submission.
    fn ask(&mut self, frame: &mut Frame, prompt: &str) -> Result<String, String> {
        if !frame.started {
            frame.messages.push(self.model.format_message("system", &self.system, None));
            frame.started = true;
        }
        frame.messages.push(self.model.format_message("user", prompt, None));
        let mut format_errors = 0;
        for _ in 0..self.step_limit {
            if STOP.load(Ordering::SeqCst) {
                return Err("interrupted".into());
            }
            let reply = self.model.query(&frame.messages, None).map_err(|e| format!("{}: {}", e.kind, e.message))?;
            let msg = match reply {
                Reply::Message(m) => m,
                Reply::FormatError(msgs) => {
                    frame.messages.extend(msgs);
                    format_errors += 1;
                    if format_errors >= 3 {
                        return Err("RepeatedFormatError".into());
                    }
                    continue;
                }
            };
            self.cost += extra(&msg).get("cost").and_then(Value::as_f64).unwrap_or(0.0);
            self.calls += 1;
            if let Some(sub) = msg.pointer("/extra/submission").and_then(Value::as_str).map(String::from) {
                frame.messages.push(msg);
                return Ok(sub);
            }
            let actions: Vec<Value> = msg.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default();
            if actions.is_empty() {
                let text = shapes::text_of(msg.get("content").unwrap_or(&Value::Null)).trim().to_string();
                frame.messages.push(msg);
                return Ok(text);
            }
            let mut outputs = Vec::new();
            for a in &actions {
                if STOP.load(Ordering::SeqCst) {
                    return Err("interrupted".into());
                }
                let command = a
                    .get("command")
                    .map(|c| c.as_str().map(String::from).unwrap_or_else(|| crate::util::py_json(c, false)))
                    .unwrap_or_default();
                match self.env.execute(&command) {
                    Outcome::Output(o) => outputs.push(o),
                    Outcome::Submitted(s) => return Ok(s),
                    Outcome::Stopped => return Err("interrupted".into()),
                }
            }
            let mut vars = self.env.template_vars();
            merge_into(&mut vars, &self.model.template_vars());
            let obs = self
                .model
                .format_observation_messages(&msg, &outputs, &Value::Object(vars))
                .map_err(|e| format!("TemplateError: {e}"))?;
            frame.messages.push(msg);
            frame.messages.extend(obs);
        }
        Err(format!("LimitsExceeded: step limit ({}) reached before an answer", self.step_limit))
    }

    /// `run SHELL`: execute in the session environment; the output text is the value.
    fn run_cmd(&mut self, command: &str) -> Result<String, String> {
        match self.env.execute(command) {
            Outcome::Output(o) => Ok(o.get("output").and_then(Value::as_str).unwrap_or("").trim().to_string()),
            Outcome::Submitted(s) => Ok(s),
            Outcome::Stopped => Err("interrupted".into()),
        }
    }

    /// Feed one input line (script or interactive) through the interpreter.
    fn feed(&mut self, raw: &str) -> Result<Flow, String> {
        let mut top = std::mem::take(&mut self.top);
        let r = self.stmt(&mut top, raw);
        self.top = top;
        r
    }

    fn stmt(&mut self, frame: &mut Frame, raw: &str) -> Result<Flow, String> {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') {
            return Ok(Flow::Next);
        }
        if self.collecting.is_some() {
            if line == "end" {
                let (name, params, body) = self.collecting.take().unwrap();
                self.fns.insert(name, FnDef { params, body });
                return Ok(Flow::Next);
            }
            if line.starts_with("def ") {
                return Err("ValueError: nested def is not supported".into());
            }
            self.collecting.as_mut().unwrap().2.push(line.to_string());
            return Ok(Flow::Next);
        }
        if let Some(rest) = line.strip_prefix("def ") {
            let (name, params) = parse_def(rest)?;
            self.collecting = Some((name, params, Vec::new()));
            return Ok(Flow::Next);
        }
        if let Some(rest) = line.strip_prefix("let ") {
            return self.assign(frame, rest, false);
        }
        if let Some(rest) = line.strip_prefix("set ") {
            return self.assign(frame, rest, true);
        }
        if line == "return" || line.starts_with("return ") {
            if frame.depth == 0 {
                return Err("ValueError: return outside a function".into());
            }
            let expr = line.strip_prefix("return").unwrap_or("").trim();
            let v = if expr.is_empty() { String::new() } else { self.eval_expr(frame, expr)? };
            return Ok(Flow::Return(v));
        }
        if line == "ask" || line.starts_with("ask ") || line == "call" || line.starts_with("call ") || line == "run" || line.starts_with("run ") {
            let v = self.eval_expr(frame, line)?;
            println!("{v}");
            return Ok(Flow::Next);
        }
        self.meta(frame, line)
    }

    fn assign(&mut self, frame: &mut Frame, rest: &str, global: bool) -> Result<Flow, String> {
        let Some(eq) = rest.find('=') else {
            return Err("ValueError: usage: let NAME = EXPR".into());
        };
        let name = rest[..eq].trim();
        if !ident(name) {
            return Err(format!("ValueError: invalid variable name: {name}"));
        }
        let v = self.eval_expr(frame, &rest[eq + 1..])?;
        if global {
            self.vars.insert(name.to_string(), v);
        } else if frame.depth == 0 {
            self.vars.insert(name.to_string(), v);
        } else {
            frame.locals.insert(name.to_string(), v);
        }
        Ok(Flow::Next)
    }

    /// The meta commands of the REPL.
    fn meta(&mut self, frame: &mut Frame, line: &str) -> Result<Flow, String> {
        match line {
            "vars" => {
                let mut all = self.vars.clone();
                for (k, v) in &frame.locals {
                    all.insert(k.clone(), v.clone());
                }
                for (k, v) in all {
                    println!("{k} = {v}");
                }
            }
            "fns" => {
                for (name, def) in &self.fns {
                    println!("{name}({})", def.params.join(", "));
                }
            }
            "cost" => println!("cost ${:.4} over {} model calls", self.cost, self.calls),
            "clear" => {
                frame.messages.clear();
                frame.started = false;
            }
            "help" => println!("{HELP}"),
            "quit" | "exit" => return Ok(Flow::Quit),
            _ => {
                if let Some(rest) = line.strip_prefix("show ") {
                    let name = rest.trim();
                    if name == "_" {
                        println!("{}", frame.last);
                    } else if !ident(name) {
                        return Err(format!("ValueError: invalid variable name: {name}"));
                    } else if let Some(v) = frame.locals.get(name).or_else(|| self.vars.get(name)) {
                        println!("{v}");
                    } else {
                        return Err(format!("ValueError: unknown variable: {name}"));
                    }
                } else if let Some(rest) = line.strip_prefix("unset ") {
                    let name = rest.trim();
                    if !ident(name) {
                        return Err(format!("ValueError: invalid variable name: {name}"));
                    }
                    if frame.locals.remove(name).is_none() && self.vars.remove(name).is_none() {
                        return Err(format!("ValueError: unknown variable: {name}"));
                    }
                } else if let Some(rest) = line.strip_prefix("fn ") {
                    let name = rest.trim();
                    let Some(def) = self.fns.get(name) else {
                        return Err(format!("ValueError: unknown function: {name}"));
                    };
                    println!("def {name}({})", def.params.join(", "));
                    for l in &def.body {
                        println!("{l}");
                    }
                    println!("end");
                } else if line == "model" || line.starts_with("model ") {
                    let name = line.strip_prefix("model").unwrap_or("").trim();
                    if name.is_empty() {
                        println!("{}", self.model.model_name());
                    } else {
                        self.model = get_model(Some(name), &self.model_cfg).map_err(|e| format!("ValueError: {e}"))?;
                        println!("{}", self.model.model_name());
                    }
                } else if line == "system" || line.starts_with("system ") {
                    let text = line.strip_prefix("system").unwrap_or("").trim();
                    if text.is_empty() {
                        println!("{}", self.system);
                    } else {
                        self.system = self.interp(frame, text)?;
                    }
                } else if line == "save" || line.starts_with("save ") {
                    let path = self.save_state(line.strip_prefix("save").unwrap_or("").trim())?;
                    println!("saved {path}");
                } else if line == "load" || line.starts_with("load ") {
                    let path = self.load_state(line.strip_prefix("load").unwrap_or("").trim())?;
                    println!("loaded {path}");
                } else {
                    return Err(format!("ValueError: unknown statement: {line}"));
                }
            }
        }
        Ok(Flow::Next)
    }

    /// Where the state goes: an explicit path, else the session's `rlm.json`.
    fn state_file(&self, path: &str) -> Result<PathBuf, String> {
        if !path.is_empty() {
            return Ok(config::expand_user(path));
        }
        self.state_path
            .clone()
            .ok_or_else(|| "ValueError: no state file (pass --state or a path)".to_string())
    }

    fn save_state(&self, path: &str) -> Result<String, String> {
        let path = self.state_file(path)?;
        let fns: BTreeMap<&str, Value> = self
            .fns
            .iter()
            .map(|(n, d)| (n.as_str(), json!({"params": d.params, "body": d.body})))
            .collect();
        let state = json!({
            "version": 1,
            "vars": self.vars,
            "fns": fns,
            "system": self.system,
            "context_dir": self.context_dir,
        });
        if let Some(dir) = path.parent() {
            std::fs::create_dir_all(dir).map_err(|e| format!("{}: {e}", dir.display()))?;
        }
        let text = serde_json::to_string_pretty(&state).map_err(|e| e.to_string())?;
        std::fs::write(&path, text + "\n").map_err(|e| format!("{}: {e}", path.display()))?;
        Ok(path.display().to_string())
    }

    fn load_state(&mut self, path: &str) -> Result<String, String> {
        let path = self.state_file(path)?;
        let text = std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?;
        let v: Value = serde_json::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
        if let Some(Value::Object(o)) = v.get("vars") {
            self.vars = o.iter().map(|(k, v)| (k.clone(), v.as_str().unwrap_or("").to_string())).collect();
        }
        if let Some(Value::Object(o)) = v.get("fns") {
            self.fns = o
                .iter()
                .filter_map(|(n, d)| {
                    let params = d.get("params").and_then(Value::as_array)?;
                    let body = d.get("body").and_then(Value::as_array)?;
                    Some((
                        n.clone(),
                        FnDef {
                            params: params.iter().map(|p| p.as_str().unwrap_or("").to_string()).collect(),
                            body: body.iter().map(|l| l.as_str().unwrap_or("").to_string()).collect(),
                        },
                    ))
                })
                .collect();
        }
        if let Some(d) = v.get("context_dir").and_then(Value::as_str).filter(|d| !d.is_empty()) {
            // A restart under a different MINI_AGENT_CONTEXT_DIR keeps the store it was seeded from.
            if self.context_dir.as_os_str().is_empty() {
                self.context_dir = PathBuf::from(d);
            }
        }
        if let Some(s) = v.get("system").and_then(Value::as_str) {
            self.system = s.to_string();
        }
        Ok(path.display().to_string())
    }
}

/// Parse the command line.
struct Opts {
    model: Option<String>,
    configs: Vec<String>,
    state: Option<String>,
    evals: Vec<String>,
    script: Option<String>,
    max_depth: usize,
    step_limit: usize,
}

fn parse_opts(args: &[String]) -> Result<Opts, String> {
    let mut o = Opts {
        model: None,
        configs: Vec::new(),
        state: None,
        evals: Vec::new(),
        script: None,
        max_depth: std::env::var("MINI_RLM_MAX_DEPTH").ok().and_then(|s| s.parse().ok()).unwrap_or(8),
        step_limit: std::env::var("MINI_RLM_STEP_LIMIT").ok().and_then(|s| s.parse().ok()).unwrap_or(25),
    };
    let mut i = 0;
    while i < args.len() {
        let arg = args[i].clone();
        if arg == "-h" || arg == "--help" {
            println!("{HELP}");
            std::process::exit(0);
        }
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) => (n.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        let dest = match name.as_str() {
            "-m" | "--model" => "model",
            "-c" | "--config" => "config",
            "--state" => "state",
            "-e" | "--eval" => "eval",
            "--max-depth" => "max_depth",
            "--step-limit" => "step_limit",
            _ => {
                if arg.starts_with('-') && arg != "-" {
                    return Err(format!("unknown option: {arg}\n\n{HELP}"));
                }
                if o.script.is_some() {
                    return Err(format!("unexpected argument: {arg}"));
                }
                o.script = Some(arg);
                i += 1;
                continue;
            }
        };
        let value = match inline {
            Some(v) => {
                i += 1;
                v
            }
            None => {
                i += 1;
                if i >= args.len() {
                    return Err(format!("{name} requires a value"));
                }
                let v = args[i].clone();
                i += 1;
                v
            }
        };
        match dest {
            "model" => o.model = Some(value),
            "config" => o.configs.push(config::expand_user(&value).display().to_string()),
            "state" => o.state = Some(config::expand_user(&value).display().to_string()),
            "eval" => o.evals.push(value),
            "max_depth" => o.max_depth = value.parse().map_err(|_| format!("invalid number for {name}: {value}"))?,
            "step_limit" => o.step_limit = value.parse().map_err(|_| format!("invalid number for {name}: {value}"))?,
            _ => unreachable!(),
        }
    }
    Ok(o)
}

/// `mini-agent-rs rlm [options] [script]`: run the harness on a script (or `-e` statements, or
/// stdin; interactive prompts when stdin is a terminal). Errors abort a script with exit 1;
/// the REPL state auto-saves at exit.
pub fn client(args: &[String]) -> i32 {
    let o = match parse_opts(args) {
        Ok(o) => o,
        Err(e) => {
            eprintln!("error: {e}");
            return 2;
        }
    };
    let mut o = o;
    if o.configs.is_empty() {
        let default = std::env::var("MSWEA_MINI_CONFIG_PATH")
            .unwrap_or_else(|_| config::builtin_config_dir().join("mini.yaml").display().to_string());
        o.configs.push(default);
    }
    let cfg = match config::build_run_config(&o.configs, &config::Overrides {
        task: None,
        model_name: o.model.clone(),
        model_class: None,
        agent_class: None,
        environment_class: None,
        cost_limit: None,
        output: None,
        yolo: false,
        exit_immediately: false,
    }) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let section = |k: &str| cfg.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
    let model_cfg = section("model");
    let model = match get_model(o.model.as_deref(), &model_cfg) {
        Ok(m) => m,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let env = match get_environment(&section("environment")) {
        Ok(e) => e,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let state_path = o.state.clone().map(PathBuf::from).or_else(|| {
        std::env::var("MINI_RLM_STATE").ok().filter(|s| !s.is_empty()).map(PathBuf::from)
    });
    let mut repl = Repl::new(model, model_cfg, env, state_path, o.step_limit, o.max_depth);
    // The persistent REPL: whatever was bound or defined last time is back.
    if repl.state_path.is_some() {
        let _ = repl.load_state("");
    }
    repl.seed_context();
    repl.run(o)
}

impl Repl {
    fn run(&mut self, o: Opts) -> i32 {
        let mut quit = false;
        for e in &o.evals {
            match self.feed(e) {
                Ok(Flow::Quit) => {
                    quit = true;
                    break;
                }
                Ok(_) => {}
                Err(err) => return self.fail(&err),
            }
        }
        if !quit {
            let tty = unsafe { libc::isatty(0) } == 1;
            if let Some(script) = &o.script {
                let text = if script == "-" {
                    let mut s = String::new();
                    if let Err(e) = std::io::stdin().read_to_string(&mut s) {
                        eprintln!("error: stdin: {e}");
                        return 1;
                    }
                    s
                } else {
                    match std::fs::read_to_string(config::expand_user(script)) {
                        Ok(t) => t,
                        Err(e) => {
                            eprintln!("error: {script}: {e}");
                            return 1;
                        }
                    }
                };
                if let Some(code) = self.run_lines(text.lines().map(String::from), false) {
                    return code;
                }
            } else if tty {
                // A terminal: the interactive prompt (unless `-e` statements only were asked for).
                if o.evals.is_empty() {
                    if let Some(code) = self.run_interactive() {
                        return code;
                    }
                }
            } else {
                let stdin = std::io::stdin();
                let lines = stdin.lock().lines().map_while(Result::ok);
                if let Some(code) = self.run_lines(lines, false) {
                    return code;
                }
            }
        }
        if self.collecting.is_some() {
            eprintln!("error: ValueError: def is missing its `end`");
            return 1;
        }
        if self.state_path.is_some() {
            let _ = self.save_state("");
        }
        0
    }

    /// Run input lines to completion; `Some(exit code)` when the REPL should stop.
    fn run_lines(&mut self, lines: impl Iterator<Item = String>, interactive: bool) -> Option<i32> {
        for line in lines {
            match self.feed(&line) {
                Ok(Flow::Quit) => return None,
                Ok(_) => {}
                Err(err) => {
                    if interactive {
                        eprintln!("error: {err}");
                        STOP.store(false, Ordering::SeqCst);
                    } else {
                        return Some(self.fail(&err));
                    }
                }
            }
        }
        None
    }

    fn run_interactive(&mut self) -> Option<i32> {
        let stdin = std::io::stdin();
        let mut input = String::new();
        loop {
            let prompt = if self.collecting.is_some() { "...> " } else { "rlm> " };
            print!("{prompt}");
            let _ = std::io::stdout().flush();
            input.clear();
            match stdin.read_line(&mut input) {
                Ok(0) | Err(_) => return None,
                Ok(_) => {}
            }
            if let Some(code) = self.run_lines(std::iter::once(input.trim_end_matches('\n').to_string()), true) {
                return Some(code);
            }
        }
    }

    fn fail(&self, err: &str) -> i32 {
        eprintln!("error: {err}");
        if err == "interrupted" {
            STOP.store(false, Ordering::SeqCst);
            130
        } else {
            1
        }
    }
}
