//! `mini-agent-rs repl`: a Recursive-Language-Model REPL harness, in Rust only.
//!
//! The model never sees the context. It sees a REPL: the context is a variable (`context`) in a
//! sandboxed Rhai interpreter, and the model writes code that slices, greps, chunks and
//! aggregates it, printing only what it needs into its own window. Sub-calls are functions:
//!
//!   llm(prompt)                  one plain model call (no tools), returns its text
//!   llm_batch([p1, p2, ...])     the same, in parallel threads (MINI_REPL_PAR, default 8)
//!   rlm(prompt, ctx)             a whole recursive REPL session on `ctx`, returns its FINAL
//!   rlm_batch([[prompt, ctx], ...])  recursive sessions in parallel
//!   FINAL(x)                     the answer; ends the session
//!
//! Sandbox: Rhai has no file, network or process access of its own; the module resolver is a
//! dummy (no `import` from disk), `eval` is disabled, and operations / string / array / map /
//! call depth / wall-clock per cell are capped. The ONLY doors out are the functions above plus,
//! when asked for, `read(path)` / `ls(dir)` (read-only, confined to `--root`) and `sh(cmd)`
//! (`--sh`: bubblewrap, read-only root fs, no network, only `--lane` paths writable).
//!
//! State: the Rhai scope persists across cells of a session; `--state FILE` saves the plain
//! values (strings, numbers, arrays, maps) as JSON at exit and loads them at start.

use crate::config;
use crate::models::{get_model, shapes, Reply};
use crate::util::{extra, now, Obj};
use rhai::{Array, Dynamic, Engine, EvalAltResult, Map, Scope};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

pub const HELP: &str = "mini-agent-rs repl - an RLM harness: context lives in a sandboxed REPL, not in the prompt

  mini-agent-rs repl -t TASK [--context PATH]... [-m MODEL] [--root DIR] [--sh] [--lane PATH]...
                     [--state FILE] [-o TRAJ.json] [--max-turns N] [--max-depth N]

  --context PATH   bind PATH into the REPL: a file -> `context` (string); a folder -> `context`
                   (map path -> text, text files only, capped by MINI_REPL_CONTEXT_MAX bytes)
  --root DIR       enable read(path) / ls(dir), read-only, confined to DIR
  --sh             enable sh(cmd): bubblewrap, read-only fs, no network; --lane paths writable
  --state FILE     persist plain REPL variables across runs (JSON)
  -o FILE          write the root conversation + stats (mini-tui trajectory shape)

Inside: llm(p), llm_batch(ps), rlm(p, ctx), rlm_batch([[p, ctx]...]), FINAL(x), print(x),
grep(text, regex), lines(text), chunks(text, n), len(x), read(path), ls(dir), sh(cmd).";

/// What the whole tree of calls spent (root + every sub-call), split by role.
#[derive(Default, Clone, Debug)]
pub struct Stats {
    pub root_calls: u64,
    pub root_prompt_tokens: u64,
    pub root_output_tokens: u64,
    pub sub_calls: u64,
    pub sub_prompt_tokens: u64,
    pub sub_output_tokens: u64,
    pub cost: f64,
    pub cells: u64,
    pub cell_errors: u64,
    pub eval_secs: f64,
    pub max_depth_seen: u64,
    /// Characters actually sent as prompts (exact; the provider may not report token usage).
    pub root_prompt_chars: u64,
    pub sub_prompt_chars: u64,
    pub format_errors: u64,
}

fn chars_of(msgs: &[Value]) -> u64 {
    msgs.iter().map(|m| serde_json::to_string(m).map(|s| s.len()).unwrap_or(0) as u64).sum()
}

fn usage(msg: &Value) -> (u64, u64) {
    let u = msg.pointer("/extra/response/usage").cloned().unwrap_or(Value::Null);
    let g = |k: &str| u.get(k).and_then(Value::as_u64).unwrap_or(0);
    (g("prompt_tokens").max(g("input_tokens")), g("completion_tokens").max(g("output_tokens")))
}

/// Everything a session (and any sub-session it spawns, in any thread) needs to build its own
/// model: the config is plain data, so each thread makes its own client.
#[derive(Clone)]
pub struct Ctx {
    pub model_name: Option<String>,
    pub model_cfg: Obj,
    pub root: Option<PathBuf>,
    pub sh: bool,
    pub lane: Vec<PathBuf>,
    pub max_turns: usize,
    pub max_depth: u64,
    pub par: usize,
    pub stats: Arc<Mutex<Stats>>,
}

const SYSTEM: &str = r#"You are the root of a Recursive Language Model. You work in a REPL, not a chat.

The data you must answer about is NOT in this conversation. It is in the variable `context` of a
persistent Rhai REPL ({CTX_DESC}). You cannot see it except by running code that prints parts
of it. Your window is small; the REPL is not. Print summaries, counts and short slices, never
the whole thing.

Every reply is ONE code cell: a ```rhai fenced block (or the same code as the `command` of your
bash tool -- it runs in this REPL, not in a shell). You get its printed output back. When you
are done, a cell of its own calls FINAL(answer) -- never FINAL in a cell that is still exploring.

Rhai, quickly: `let x = 5;` `x.len()` `s.sub_string(start, len)` `s.index_of("needle")`
`s.split("\n")` `for item in arr { ... }` `if a { } else { }` `arr.push(v)` `m["k"] = v;`
`m.keys()` `s.to_lower()` `s.contains("x")` `parse_int(s)` `` `text ${x}` `` (interpolation).
Variables persist between cells. Functions you define with `fn` CANNOT see outer variables: pass
them as parameters.

Pitfalls: parse_int("1.5") fails -- use num(s) for any number; there is no `fmt`, use fmt2(x)
for 2 decimals; there is no `else if` chain problem but every `if` needs braces; sort a map by
value with top(map, k) -> [[key, value], ...] (descending).

Host functions:
  print(x)                      show x to you (output is truncated to {OUT_MAX} chars per cell)
  len(x)  lines(s)  chunks(s, n)  slice(array_or_string, start, n)
  grep(s, regex) -> array of matching lines   num(s) -> float   fmt2(x)   top(map, k)
  llm(prompt) -> string         ask a sub-model (it sees ONLY the prompt you give it; put the
                                slice of context it needs inside the prompt)
  llm_batch([p1, p2, ...]) -> array   many sub-model calls IN PARALLEL: use it for map steps
  rlm(prompt, ctx) -> string    a recursive sub-session like you, with `ctx` as ITS context
  rlm_batch([[prompt, ctx], ...]) -> array   recursive sub-sessions in parallel
{EXTRA_FNS}  FINAL(answer)                 finish: the answer is returned to whoever called you

Strategy that works: look at the shape of `context` first (len, a few lines), then decide:
exact questions -> code (grep, count, parse); fuzzy questions over lots of text -> chunk it and
llm_batch the chunks, then combine the answers in code. Keep each cell small."#;

fn system_prompt(ctx: &Ctx, desc: &str) -> String {
    let mut extra = String::new();
    if ctx.root.is_some() {
        extra.push_str("  read(path) -> string  ls(dir) -> array   read-only files under the work root\n");
    }
    if ctx.sh {
        extra.push_str("  sh(cmd) -> string             run a shell command in a sandbox (no network; only your lane is writable)\n");
    }
    SYSTEM.replace("{CTX_DESC}", desc).replace("{OUT_MAX}", &out_max().to_string()).replace("{EXTRA_FNS}", &extra)
}

fn out_max() -> usize {
    std::env::var("MINI_REPL_OUT_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(4000)
}

/// A one-line description of a value: what the root is told about `context` instead of it.
pub fn describe(v: &Dynamic) -> String {
    if let Some(s) = v.clone().try_cast::<String>() {
        let lines = s.lines().count();
        let head: String = s.chars().take(200).collect();
        format!("a string of {} chars, {} lines; it starts: {:?}", s.chars().count(), lines, head)
    } else if let Some(m) = v.clone().try_cast::<Map>() {
        let total: usize = m.values().map(|x| x.clone().try_cast::<String>().map(|s| s.len()).unwrap_or(0)).sum();
        let keys: Vec<String> = m.keys().take(8).map(|k| k.to_string()).collect();
        format!("a map of {} entries (path -> text, {} bytes in all); first keys: {:?}", m.len(), total, keys)
    } else if let Some(a) = v.clone().try_cast::<Array>() {
        format!("an array of {} items", a.len())
    } else {
        format!("a {}", v.type_name())
    }
}

/// One sub-model call: the prompt alone, no tools offered by the instructions, plain text back.
fn llm_once(ctx: &Ctx, prompt: &str) -> Result<String, String> {
    let mut model = get_model(ctx.model_name.as_deref(), &ctx.model_cfg)?;
    let msgs = vec![
        model.format_message("system", "Answer the user's request directly in plain text. Do not call tools. Be brief and exact.", None),
        model.format_message("user", prompt, None),
    ];
    ctx.stats.lock().unwrap().sub_prompt_chars += chars_of(&msgs);
    let reply = model.query(&msgs, None).map_err(|e| format!("{}: {}", e.kind, e.message))?;
    let msg = match reply {
        Reply::Message(m) => m,
        Reply::FormatError(ms) => ms.into_iter().next().unwrap_or(Value::Null),
    };
    let (p, o) = usage(&msg);
    {
        let mut st = ctx.stats.lock().unwrap();
        st.sub_calls += 1;
        st.sub_prompt_tokens += p;
        st.sub_output_tokens += o;
        st.cost += extra(&msg).get("cost").and_then(Value::as_f64).unwrap_or(0.0);
    }
    let text = msg.pointer("/extra/submission").and_then(Value::as_str).map(String::from).unwrap_or_else(|| shapes::text_of(msg.get("content").unwrap_or(&Value::Null)));
    Ok(text.trim().to_string())
}

/// Run `jobs` in at most `par` threads, results in input order.
fn parallel<T: Send + 'static>(par: usize, jobs: Vec<Box<dyn FnOnce() -> T + Send>>) -> Vec<T> {
    let n = jobs.len();
    let queue = Arc::new(Mutex::new(jobs.into_iter().enumerate().collect::<Vec<_>>()));
    let out: Arc<Mutex<Vec<Option<T>>>> = Arc::new(Mutex::new((0..n).map(|_| None).collect()));
    let workers: Vec<_> = (0..par.max(1).min(n.max(1)))
        .map(|_| {
            let (q, o) = (queue.clone(), out.clone());
            std::thread::spawn(move || loop {
                let job = q.lock().unwrap().pop();
                let Some((i, f)) = job else { break };
                let r = f();
                o.lock().unwrap()[i] = Some(r);
            })
        })
        .collect();
    for w in workers {
        let _ = w.join();
    }
    Arc::try_unwrap(out).ok().map(|m| m.into_inner().unwrap()).unwrap_or_default().into_iter().map(|x| x.expect("job ran")).collect()
}

fn err(e: impl std::fmt::Display) -> Box<EvalAltResult> {
    e.to_string().into()
}

/// Resolve `p` under `root` and refuse anything that escapes it (`..`, symlinks out).
fn confined(root: &Path, p: &str) -> Result<PathBuf, Box<EvalAltResult>> {
    let full = std::fs::canonicalize(root.join(p)).map_err(|e| err(format!("{p}: {e}")))?;
    let r = std::fs::canonicalize(root).map_err(err)?;
    if !full.starts_with(&r) {
        return Err(err(format!("{p}: outside the work root")));
    }
    Ok(full)
}

/// `sh(cmd)` in bubblewrap: the whole fs read-only, a private /tmp, no network, lane writable.
fn sandboxed_sh(ctx: &Ctx, cmd: &str) -> Result<String, Box<EvalAltResult>> {
    let mut c = std::process::Command::new("bwrap");
    c.args(["--ro-bind", "/", "/", "--dev", "/dev", "--proc", "/proc", "--tmpfs", "/tmp", "--unshare-net", "--die-with-parent"]);
    for l in &ctx.lane {
        let s = l.display().to_string();
        c.args(["--bind", &s, &s]);
    }
    if let Some(r) = &ctx.root {
        c.arg("--chdir").arg(r);
    }
    c.args(["/bin/sh", "-c", cmd]);
    let out = c.output().map_err(|e| err(format!("sh: bwrap: {e}")))?;
    Ok(format!("{}{}", String::from_utf8_lossy(&out.stdout), String::from_utf8_lossy(&out.stderr)))
}

/// The cell engine: sandboxed, with the host functions bound to this session.
fn engine(ctx: &Ctx, depth: u64, printed: Arc<Mutex<String>>, final_: Arc<Mutex<Option<String>>>) -> Engine {
    let mut e = Engine::new();
    e.set_module_resolver(rhai::module_resolvers::DummyModuleResolver::new());
    e.disable_symbol("eval");
    e.set_max_operations(std::env::var("MINI_REPL_MAX_OPS").ok().and_then(|v| v.parse().ok()).unwrap_or(200_000_000));
    e.set_max_string_size(64 << 20);
    e.set_max_array_size(1 << 20);
    e.set_max_map_size(1 << 20);
    e.set_max_call_levels(64);
    e.set_max_expr_depths(128, 64);
    let cell_secs: u64 = std::env::var("MINI_REPL_CELL_SECS").ok().and_then(|v| v.parse().ok()).unwrap_or(600);
    let started = Arc::new(Mutex::new(Instant::now()));
    {
        let started = started.clone();
        e.on_progress(move |_| {
            if started.lock().unwrap().elapsed() > Duration::from_secs(cell_secs) {
                Some(format!("cell wall-clock limit ({cell_secs}s)").into())
            } else {
                None
            }
        });
    }
    {
        let p = printed.clone();
        e.on_print(move |s| {
            let mut b = p.lock().unwrap();
            b.push_str(s);
            b.push('\n');
        });
    }
    {
        let p = printed.clone();
        e.on_debug(move |s, _, _| {
            let mut b = p.lock().unwrap();
            b.push_str(s);
            b.push('\n');
        });
    }
    {
        let f = final_.clone();
        e.register_fn("FINAL", move |x: Dynamic| -> Result<(), Box<EvalAltResult>> {
            *f.lock().unwrap() = Some(x.to_string());
            Err("__FINAL__".into())
        });
    }
    e.register_fn("lines", |s: &str| -> Array { s.lines().map(|l| Dynamic::from(l.to_string())).collect() });
    e.register_fn("chunks", |s: &str, n: i64| -> Array {
        let n = n.max(1) as usize;
        let cs: Vec<char> = s.chars().collect();
        cs.chunks(n).map(|c| Dynamic::from(c.iter().collect::<String>())).collect()
    });
    e.register_fn("grep", |s: &str, re: &str| -> Result<Array, Box<EvalAltResult>> {
        let r = regex::Regex::new(re).map_err(err)?;
        Ok(s.lines().filter(|l| r.is_match(l)).map(|l| Dynamic::from(l.to_string())).collect())
    });
    // Helpers for what models trip on in Rhai (measured: 6 of 11 cells failed on these).
    e.register_fn("num", |s: &str| -> f64 { s.trim().parse::<f64>().unwrap_or(0.0) });
    e.register_fn("fmt2", |x: f64| format!("{x:.2}"));
    e.register_fn("fmt2", |x: i64| format!("{x}.00"));
    e.register_fn("top", |m: Map, k: i64| -> Array {
        let mut v: Vec<(String, f64)> = m.into_iter().map(|(k, v)| (k.to_string(), v.as_float().or_else(|_| v.as_int().map(|i| i as f64)).unwrap_or(0.0))).collect();
        v.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
        v.into_iter().take(k.max(0) as usize).map(|(k, x)| Dynamic::from(vec![Dynamic::from(k), Dynamic::from(x)])).collect()
    });
    e.register_fn("slice", |a: Array, start: i64, n: i64| -> Array { a.into_iter().skip(start.max(0) as usize).take(n.max(0) as usize).collect() });
    e.register_fn("slice", |s: &str, start: i64, n: i64| -> String { s.chars().skip(start.max(0) as usize).take(n.max(0) as usize).collect() });
    e.register_fn("len", |s: &str| s.chars().count() as i64);
    e.register_fn("len", |a: Array| a.len() as i64);
    e.register_fn("len", |m: Map| m.len() as i64);
    {
        let c = ctx.clone();
        e.register_fn("llm", move |p: &str| -> Result<String, Box<EvalAltResult>> { llm_once(&c, p).map_err(err) });
    }
    {
        let c = ctx.clone();
        e.register_fn("llm_batch", move |ps: Array| -> Array {
            let jobs: Vec<Box<dyn FnOnce() -> String + Send>> = ps
                .into_iter()
                .map(|p| {
                    let c = c.clone();
                    let p = p.to_string();
                    Box::new(move || llm_once(&c, &p).unwrap_or_else(|e| format!("ERROR: {e}"))) as Box<dyn FnOnce() -> String + Send>
                })
                .collect();
            parallel(c.par, jobs).into_iter().map(Dynamic::from).collect()
        });
    }
    {
        let c = ctx.clone();
        e.register_fn("rlm", move |p: &str, sub: Dynamic| -> Result<String, Box<EvalAltResult>> {
            if depth + 1 > c.max_depth {
                return Err(err(format!("rlm: max depth {} reached; use llm() here", c.max_depth)));
            }
            Ok(Session::new(c.clone(), depth + 1).run(p, sub).answer)
        });
    }
    {
        let c = ctx.clone();
        e.register_fn("rlm_batch", move |items: Array| -> Result<Array, Box<EvalAltResult>> {
            if depth + 1 > c.max_depth {
                return Err(err(format!("rlm_batch: max depth {} reached; use llm_batch() here", c.max_depth)));
            }
            // Dynamic is Send+Sync under the `sync` feature: the pairs go to the threads whole.
            let jobs: Vec<Box<dyn FnOnce() -> String + Send>> = items
                .into_iter()
                .map(|it| {
                    let c = c.clone();
                    let pair = it.try_cast::<Array>().unwrap_or_default();
                    let p = pair.first().map(|x| x.to_string()).unwrap_or_default();
                    let sub = pair.get(1).cloned().unwrap_or(Dynamic::UNIT);
                    Box::new(move || Session::new(c, depth + 1).run(&p, sub).answer) as Box<dyn FnOnce() -> String + Send>
                })
                .collect();
            Ok(parallel(c.par, jobs).into_iter().map(Dynamic::from).collect())
        });
    }
    if let Some(root) = ctx.root.clone() {
        let r2 = root.clone();
        e.register_fn("read", move |p: &str| -> Result<String, Box<EvalAltResult>> {
            std::fs::read_to_string(confined(&root, p)?).map_err(err)
        });
        e.register_fn("ls", move |p: &str| -> Result<Array, Box<EvalAltResult>> {
            let d = confined(&r2, p)?;
            let mut v: Vec<String> = std::fs::read_dir(d).map_err(err)?.filter_map(|x| x.ok()).map(|x| x.file_name().to_string_lossy().to_string()).collect();
            v.sort();
            Ok(v.into_iter().map(Dynamic::from).collect())
        });
    }
    if ctx.sh {
        let c = ctx.clone();
        e.register_fn("sh", move |cmd: &str| sandboxed_sh(&c, cmd));
    }
    // Reset the per-cell clock each time a cell starts (see Session::cell).
    e.register_fn("__cell_start", move || {
        *started.lock().unwrap() = Instant::now();
    });
    e
}

/// Load `--context PATH`: a file is a string; a folder is a map of its text files.
pub fn load_context(path: &Path) -> Result<Dynamic, String> {
    if path.is_file() {
        return std::fs::read_to_string(path).map(Dynamic::from).map_err(|e| format!("{}: {e}", path.display()));
    }
    let cap: usize = std::env::var("MINI_REPL_CONTEXT_MAX").ok().and_then(|v| v.parse().ok()).unwrap_or(256 << 20);
    let mut m = Map::new();
    let mut total = 0usize;
    let mut stack = vec![path.to_path_buf()];
    while let Some(d) = stack.pop() {
        let Ok(rd) = std::fs::read_dir(&d) else { continue };
        for ent in rd.flatten() {
            let p = ent.path();
            let name = ent.file_name().to_string_lossy().to_string();
            if name.starts_with('.') || name == "node_modules" || name == "target" {
                continue;
            }
            if p.is_dir() {
                stack.push(p);
            } else if let Ok(t) = std::fs::read_to_string(&p) {
                total += t.len();
                if total > cap {
                    return Err(format!("context over MINI_REPL_CONTEXT_MAX ({cap} bytes)"));
                }
                let rel = p.strip_prefix(path).unwrap_or(&p).display().to_string();
                m.insert(rel.into(), Dynamic::from(t));
            }
        }
    }
    Ok(Dynamic::from(m))
}

pub struct Outcome {
    pub answer: String,
    pub messages: Vec<Value>,
    pub turns: usize,
}

pub struct Session {
    ctx: Ctx,
    depth: u64,
}

fn code_cells(text: &str) -> Vec<String> {
    let re = regex::Regex::new(r"(?s)```(?:rhai|repl|rust|js)?[ \t]*\n(.*?)```").unwrap();
    re.captures_iter(text).map(|c| c[1].to_string()).collect()
}

impl Session {
    pub fn new(ctx: Ctx, depth: u64) -> Self {
        {
            let mut st = ctx.stats.lock().unwrap();
            st.max_depth_seen = st.max_depth_seen.max(depth);
        }
        Session { ctx, depth }
    }

    /// Run one session: the model writes cells until one calls FINAL (or it answers in plain text
    /// without a cell, or the turn budget runs out).
    pub fn run(&self, task: &str, context: Dynamic) -> Outcome {
        self.run_with_scope(task, context, &mut Scope::new())
    }

    pub fn run_with_scope(&self, task: &str, context: Dynamic, scope: &mut Scope<'static>) -> Outcome {
        let printed = Arc::new(Mutex::new(String::new()));
        let final_: Arc<Mutex<Option<String>>> = Arc::new(Mutex::new(None));
        let eng = engine(&self.ctx, self.depth, printed.clone(), final_.clone());
        let desc = describe(&context);
        scope.set_or_push("context", context);
        let mut model = match get_model(self.ctx.model_name.as_deref(), &self.ctx.model_cfg) {
            Ok(m) => m,
            Err(e) => return Outcome { answer: format!("ERROR: {e}"), messages: vec![], turns: 0 },
        };
        let mut messages = vec![
            model.format_message("system", &system_prompt(&self.ctx, &desc), None),
            model.format_message("user", &format!("Task: {task}\n\nWrite your first cell."), None),
        ];
        for turn in 1..=self.ctx.max_turns {
            if crate::agent::STOP.load(std::sync::atomic::Ordering::SeqCst) {
                return Outcome { answer: "interrupted".into(), messages, turns: turn };
            }
            {
                let c = chars_of(&messages);
                let mut st = self.ctx.stats.lock().unwrap();
                if self.depth == 0 { st.root_prompt_chars += c } else { st.sub_prompt_chars += c }
            }
            let reply = match model.query(&messages, None) {
                Ok(r) => r,
                Err(e) => return Outcome { answer: format!("ERROR: {}: {}", e.kind, e.message), messages, turns: turn },
            };
            let msg = match reply {
                Reply::Message(m) => m,
                Reply::FormatError(_) => {
                    // A malformed tool call (e.g. bash with no `command`): tell the model and go on.
                    self.ctx.stats.lock().unwrap().format_errors += 1;
                    messages.push(model.format_message("user", "That reply had no runnable cell. Reply with ONE ```rhai fenced block (or pass the code as the bash tool's `command`; it runs in the REPL, not a shell). Call FINAL(answer) when done.", None));
                    continue;
                }
            };
            {
                let (p, o) = usage(&msg);
                let mut st = self.ctx.stats.lock().unwrap();
                if self.depth == 0 {
                    st.root_calls += 1;
                    st.root_prompt_tokens += p;
                    st.root_output_tokens += o;
                } else {
                    st.sub_calls += 1;
                    st.sub_prompt_tokens += p;
                    st.sub_output_tokens += o;
                }
                st.cost += extra(&msg).get("cost").and_then(Value::as_f64).unwrap_or(0.0);
            }
            let text = msg.pointer("/extra/submission").and_then(Value::as_str).map(String::from).unwrap_or_else(|| shapes::text_of(msg.get("content").unwrap_or(&Value::Null)));
            // Cells come from fenced blocks; a model that insists on its bash tool gets its
            // command run as a cell too (the tool is the REPL here).
            let actions: Vec<Value> = msg.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default();
            let mut cells = code_cells(&text);
            let via_tool = cells.is_empty() && !actions.is_empty();
            if via_tool {
                cells = actions.iter().filter_map(|a| a.get("command").and_then(Value::as_str).map(String::from)).collect();
            }
            if cells.is_empty() {
                messages.push(msg);
                return Outcome { answer: text.trim().to_string(), messages, turns: turn };
            }
            let mut outputs: Vec<String> = vec![];
            for code in &cells {
                printed.lock().unwrap().clear();
                let t0 = now();
                let _ = eng.eval_with_scope::<Dynamic>(scope, "__cell_start()");
                let r = eng.eval_with_scope::<Dynamic>(scope, code);
                let mut st = self.ctx.stats.lock().unwrap();
                st.cells += 1;
                st.eval_secs += now() - t0;
                drop(st);
                if let Some(ans) = final_.lock().unwrap().take() {
                    // A FINAL in the same cell that is still LOOKING at the data (it printed, or
                    // a statement before it failed) is a placeholder, not an answer: measured, a
                    // model ended a 3000-ticket session with FINAL("ok") after printing a header.
                    // Answer only when the cell printed nothing besides it.
                    let looked = !printed.lock().unwrap().trim().is_empty();
                    if !looked || turn == self.ctx.max_turns {
                        messages.push(msg);
                        return Outcome { answer: ans, messages, turns: turn };
                    }
                    let out = printed.lock().unwrap().clone();
                    outputs.push(format!("{}\n[FINAL ignored: this cell also printed output, so you have not seen it yet. Read it, then call FINAL(answer) in a cell of its own with the real answer.]", out.chars().take(out_max()).collect::<String>()));
                    continue;
                }
                let mut out = printed.lock().unwrap().clone();
                match r {
                    Ok(v) if !v.is_unit() && out.is_empty() => out = v.to_string(),
                    Ok(_) => {}
                    Err(e) => {
                        self.ctx.stats.lock().unwrap().cell_errors += 1;
                        out.push_str(&format!("ERROR: {e}\n"));
                    }
                }
                let n = out.chars().count();
                if n > out_max() {
                    out = format!("{}\n... [{} more chars truncated: print less, or summarize in code]", out.chars().take(out_max()).collect::<String>(), n - out_max());
                }
                if out.trim().is_empty() {
                    out = "(no output)".into();
                }
                outputs.push(out);
            }
            let vars: Vec<String> = scope.iter().filter(|(n, _, _)| *n != "context").map(|(n, _, v)| format!("{n}:{}", v.type_name().rsplit("::").next().unwrap_or(""))).collect();
            let body = format!("{}\n[variables: {}]", outputs.join("\n---\n"), if vars.is_empty() { "-".into() } else { vars.join(", ") });
            if via_tool {
                let obs: Vec<Value> = actions
                    .iter()
                    .zip(outputs.iter().chain(std::iter::repeat(&String::new())))
                    .map(|(a, _)| json!({"role": "tool", "tool_call_id": a.get("tool_call_id").cloned().unwrap_or(Value::Null), "content": body.clone()}))
                    .collect();
                messages.push(msg);
                messages.extend(obs);
            } else {
                messages.push(msg);
                messages.push(model.format_message("user", &format!("REPL output:\n{body}"), None));
            }
        }
        Outcome { answer: format!("ERROR: no FINAL after {} turns", self.ctx.max_turns), messages, turns: self.ctx.max_turns }
    }
}

fn save_scope(scope: &Scope, path: &Path) {
    let mut m = serde_json::Map::new();
    for (name, _, v) in scope.iter() {
        if name == "context" {
            continue;
        }
        if let Ok(j) = rhai::serde::from_dynamic::<Value>(&v) {
            m.insert(name.to_string(), j);
        }
    }
    let _ = std::fs::write(path, serde_json::to_string_pretty(&Value::Object(m)).unwrap_or_default());
}

fn load_scope(path: &Path) -> Scope<'static> {
    let mut s = Scope::new();
    if let Ok(t) = std::fs::read_to_string(path) {
        if let Ok(Value::Object(m)) = serde_json::from_str::<Value>(&t) {
            for (k, v) in m {
                if let Ok(d) = rhai::serde::to_dynamic(v) {
                    s.push_dynamic(k, d);
                }
            }
        }
    }
    s
}

pub fn client(args: &[String]) -> i32 {
    let mut task = String::new();
    let mut contexts: Vec<String> = vec![];
    let mut model_name: Option<String> = None;
    let mut root: Option<PathBuf> = None;
    let mut sh = false;
    let mut lane: Vec<PathBuf> = vec![];
    let mut state: Option<PathBuf> = None;
    let mut out: Option<PathBuf> = None;
    let mut configs: Vec<String> = vec![];
    let mut max_turns: usize = std::env::var("MINI_REPL_MAX_TURNS").ok().and_then(|v| v.parse().ok()).unwrap_or(30);
    let mut max_depth: u64 = std::env::var("MINI_REPL_MAX_DEPTH").ok().and_then(|v| v.parse().ok()).unwrap_or(2);
    let mut eval_only: Option<String> = None;
    let mut i = 0;
    while i < args.len() {
        let a = args[i].as_str();
        let mut val = || {
            i += 1;
            args.get(i).cloned().unwrap_or_default()
        };
        match a {
            "-h" | "--help" => {
                println!("{HELP}");
                return 0;
            }
            "-t" | "--task" => task = val(),
            "--context" => contexts.push(val()),
            "-m" | "--model" => model_name = Some(val()),
            "-c" | "--config" => configs.push(val()),
            "--root" => root = Some(config::expand_user(&val())),
            "--sh" => sh = true,
            "--lane" => lane.push(config::expand_user(&val())),
            "--state" => state = Some(config::expand_user(&val())),
            "-o" => out = Some(config::expand_user(&val())),
            "--max-turns" => max_turns = val().parse().unwrap_or(max_turns),
            "--max-depth" => max_depth = val().parse().unwrap_or(max_depth),
            "--eval" => eval_only = Some(val()),
            other => {
                eprintln!("error: unknown argument {other}\n\n{HELP}");
                return 2;
            }
        }
        i += 1;
    }
    // `--eval CODE`: run one cell against the context with NO model (sub-calls error out): the
    // sandbox and the interpreter, measured on their own.
    if let Some(code) = eval_only {
        let context = match contexts.first() {
            Some(c) => match load_context(&config::expand_user(c)) {
                Ok(v) => v,
                Err(e) => {
                    eprintln!("error: {e}");
                    return 1;
                }
            },
            None => Dynamic::from(String::new()),
        };
        let ctx = Ctx { model_name: None, model_cfg: Obj::new(), root, sh, lane, max_turns, max_depth, par: 1, stats: Arc::new(Mutex::new(Stats::default())) };
        let printed = Arc::new(Mutex::new(String::new()));
        let fin = Arc::new(Mutex::new(None));
        let eng = engine(&ctx, 0, printed.clone(), fin);
        let mut scope = Scope::new();
        scope.push_dynamic("context", context);
        let _ = eng.eval_with_scope::<Dynamic>(&mut scope, "__cell_start()");
        let t0 = now();
        let r = eng.eval_with_scope::<Dynamic>(&mut scope, &code);
        print!("{}", printed.lock().unwrap());
        match r {
            Ok(v) if !v.is_unit() => println!("{v}"),
            Ok(_) => {}
            Err(e) => println!("ERROR: {e}"),
        }
        eprintln!("eval_s={:.3}", now() - t0);
        return 0;
    }
    if task.trim().is_empty() {
        eprintln!("error: repl needs -t TASK\n\n{HELP}");
        return 2;
    }
    if configs.is_empty() {
        configs.push(config::builtin_config_dir().join("mini.yaml").display().to_string());
    }
    let cfg = match config::build_run_config(&configs, &config::Overrides {
        task: None,
        model_name: model_name.clone(),
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
    let model_cfg = cfg.get("model").and_then(Value::as_object).cloned().unwrap_or_default();
    let context = match contexts.len() {
        0 => Dynamic::from(String::new()),
        1 => match load_context(&config::expand_user(&contexts[0])) {
            Ok(c) => c,
            Err(e) => {
                eprintln!("error: {e}");
                return 1;
            }
        },
        _ => {
            let mut m = Map::new();
            for c in &contexts {
                match load_context(&config::expand_user(c)) {
                    Ok(v) => {
                        m.insert(c.as_str().into(), v);
                    }
                    Err(e) => {
                        eprintln!("error: {e}");
                        return 1;
                    }
                }
            }
            Dynamic::from(m)
        }
    };
    let ctx = Ctx {
        model_name,
        model_cfg,
        root,
        sh,
        lane,
        max_turns,
        max_depth,
        par: std::env::var("MINI_REPL_PAR").ok().and_then(|v| v.parse().ok()).unwrap_or(8),
        stats: Arc::new(Mutex::new(Stats::default())),
    };
    let mut scope = state.as_deref().map(load_scope).unwrap_or_default();
    let t0 = now();
    let o = Session::new(ctx.clone(), 0).run_with_scope(&task, context, &mut scope);
    let wall = now() - t0;
    let st = ctx.stats.lock().unwrap().clone();
    let stats = json!({
        "wall_s": (wall * 10.0).round() / 10.0, "turns": o.turns,
        "root_calls": st.root_calls, "root_prompt_tokens": st.root_prompt_tokens, "root_output_tokens": st.root_output_tokens,
        "sub_calls": st.sub_calls, "sub_prompt_tokens": st.sub_prompt_tokens, "sub_output_tokens": st.sub_output_tokens,
        "cost": st.cost, "cells": st.cells, "cell_errors": st.cell_errors, "eval_s": (st.eval_secs * 1000.0).round() / 1000.0,
        "max_depth_seen": st.max_depth_seen,
        "root_prompt_chars": st.root_prompt_chars, "sub_prompt_chars": st.sub_prompt_chars, "format_errors": st.format_errors,
    });
    if let Some(p) = &out {
        let traj = json!({"messages": o.messages, "info": {"exit_status": "Submitted", "submission": o.answer, "repl_stats": stats}, "trajectory_format": "mini-swe-agent-1.1"});
        let _ = std::fs::write(p, serde_json::to_string_pretty(&traj).unwrap_or_default());
    }
    if let Some(p) = &state {
        save_scope(&scope, p);
    }
    println!("{}", o.answer);
    eprintln!("{}", stats);
    0
}
