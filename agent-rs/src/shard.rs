//! `shard`: deterministic per-file sharding with zero coordinator round-trips.
//!
//! The measured lesson of `dispatch` (see the speed2-4 notes): every orchestration shape that has a
//! model-driven coordinator loses to one agent, because the coordinator's research is serial and as
//! long as the single agent's whole run. `shard` removes the coordinator model entirely:
//!
//!   1. the hub (plain code) lists the repo's tracked files;
//!   2. ONE one-shot executor per file, all at once: each gets the task + every file (read-only) and
//!      answers with only ITS file's new content (or UNCHANGED). No tools, no steps, no exploration;
//!   3. the slow tail is cut by hedging: a call not back after `--hedge` seconds gets an identical
//!      twin (at most 4 calls); the first complete answer wins;
//!   4. `--verify` runs once; on failure the files named in the errors get one more parallel wave
//!      with the errors attached (at most `--fix-rounds`).
//!
//! Wall-clock = the slowest single-file answer (+ the gate), not the sum of a conversation.
//! It is for edits that a whole-repo prompt can hold; large repos need `--files` to narrow it.
use crate::config;
use crate::models::{get_model, shapes, Reply};
use serde_json::{json, Map, Value};
use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::mpsc;
use std::time::{Duration, Instant};

type Obj = Map<String, Value>;

const HELP: &str = "mini-agent-rs shard -t TASK --root DIR [--verify CMD] [-m MODEL] [--files a,b] [--hedge SECS] [--scope auto|all] [--max-inflight N] [--fix-rounds N] [-o stats.json]

One one-shot executor per file, all in parallel, no coordinator model. Each executor sees the task
and every file, and writes back only its own file. --verify (run in --root with sh -c) is the gate;
files named in its errors get up to --fix-rounds more parallel waves. Default: every `git ls-files`
file as context, executors only for the files the task names (--scope auto), hedge 4 s (adaptive, at most 4 calls per file), 32 calls in flight, 2 fix rounds.";

const SYSTEM: &str = "You are an executor. You output file contents only, never commentary.";

#[derive(Clone)]
pub(crate) struct Ctx {
    pub(crate) model_name: Option<String>,
    pub(crate) model_cfg: Obj,
    pub(crate) task: String,
}

/// One answer for one file: Some(new content), None = UNCHANGED, plus the call's usage.
fn ask(ctx: &Ctx, repo: &str, file: &str, extra: &str) -> Result<(Option<String>, Value), String> {
    let prompt = format!(
        "TASK for the whole repository:\n{task}\n\nRepository (every file):\n{repo}\n\n\
         Several workers edit this repo at once, ONE FILE EACH, all from the same task text, so use exactly the names, \
         signatures, JSON tags and props the task gives. Keep the existing wire contract. Other files will be updated by \
         their own workers as the task requires; you may rely on that. Change YOUR FILE only if the task explicitly requires it. \
         Never carry a change over by analogy: a change the task asks for one entity, file or function does NOT apply to the \
         similar ones it does not name (those answer UNCHANGED). Add nothing the task does not ask for. Before answering, check that EVERY requirement the task states for YOUR FILE \
         holds, in the task's exact terms (names, status codes, phrases; for docs: every case the task lists).\nYOUR FILE: {file}\n{extra}\
         If the task requires no change to {file}, answer exactly UNCHANGED. Otherwise answer with the line {BEGIN}, then the COMPLETE new content of {file}, \
         then the line {END}, and nothing else (no code fences around it). No tests.",
        task = ctx.task
    );
    let msgs = vec![
        json!({"role": "system", "content": SYSTEM}),
        json!({"role": "user", "content": prompt}),
    ];
    let (text, usage) = query_text(&ctx.model_name, &ctx.model_cfg, &msgs)?;
    parse_answer(&text).map(|a| (a, usage))
}

/// One plain model call on `msgs` (`{role, content}` objects): the reply text without its
/// `<think>` block, and the provider's usage object (prompt / cached / completion tokens).
pub(crate) fn query_text(model_name: &Option<String>, model_cfg: &Obj, msgs: &[Value]) -> Result<(String, Value), String> {
    let mut model = get_model(model_name.as_deref(), model_cfg)?;
    let msgs: Vec<Value> = msgs
        .iter()
        .map(|m| model.format_message(m["role"].as_str().unwrap_or("user"), m["content"].as_str().unwrap_or(""), None))
        .collect();
    let msg = match model.query(&msgs, None).map_err(|e| format!("{}: {}", e.kind, e.message))? {
        Reply::Message(m) => m,
        Reply::FormatError(ms) => ms.into_iter().next().unwrap_or(Value::Null),
    };
    let usage = msg.pointer("/extra/response/usage").cloned().unwrap_or(Value::Null);
    let text = msg
        .pointer("/extra/submission")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| shapes::text_of(msg.get("content").unwrap_or(&Value::Null)));
    let think = regex::Regex::new(r"(?s)<think>.*?</think>").unwrap();
    Ok((think.replace_all(&text, "").trim().to_string(), usage))
}

const BEGIN: &str = "<<<FILE";
const END: &str = "FILE>>>";

/// The answer's file content, between the BEGIN and END lines. Unique markers, not code fences:
/// a markdown file with a fenced example inside it was cut at the inner fence (measured, a doc
/// truncated mid-example). No END = a truncated answer: an error, so the hedge tries again instead
/// of writing half a file.
pub(crate) fn parse_answer(text: &str) -> Result<Option<String>, String> {
    let t = text.trim();
    if let Some(open) = t.find(BEGIN) {
        let body_start = t[open..]
            .find('\n')
            .map(|n| open + n + 1)
            .ok_or("empty answer")?;
        let close = t
            .rfind(END)
            .filter(|&c| c >= body_start)
            .ok_or("truncated answer: no end marker")?;
        let mut body = t[body_start..close].to_string();
        if !body.ends_with('\n') {
            body.push('\n');
        }
        return Ok(Some(body));
    }
    if t.contains("UNCHANGED") {
        return Ok(None);
    }
    Err("answer has neither the file markers nor UNCHANGED".into())
}

/// Global cap on model calls in flight (first calls and hedge twins alike). One call per file at
/// once, plus twins, is a burst the provider answers with 429s; under a 429 storm uncapped
/// twins multiply it (measured: 508 retries, 106 s for a 2-file task on xl). `--max-inflight`.
pub(crate) struct Slots {
    free: std::sync::Mutex<usize>,
    cv: std::sync::Condvar,
}

impl Slots {
    pub(crate) fn new(n: usize) -> Self {
        Slots {
            free: std::sync::Mutex::new(n.max(1)),
            cv: std::sync::Condvar::new(),
        }
    }
    fn acquire(&self) {
        let mut f = self.free.lock().unwrap();
        while *f == 0 {
            f = self.cv.wait(f).unwrap();
        }
        *f -= 1;
    }
    fn try_acquire(&self) -> bool {
        let mut f = self.free.lock().unwrap();
        if *f == 0 {
            return false;
        }
        *f -= 1;
        true
    }
    fn release(&self) {
        *self.free.lock().unwrap() += 1;
        self.cv.notify_one();
    }
}

/// Latencies of the answers already back in this wave: the hedge threshold adapts to them.
pub(crate) type Lat = std::sync::Arc<std::sync::Mutex<Vec<f64>>>;

/// When to start a twin: `hedge` seconds until a quarter of the wave (min 3) has answered, then
/// 2.5x the median answer so far, clamped to [2 s, hedge]. A fixed 8 s hedge was the whole wall
/// time of 1-file tasks whose answers take ~1.5 s (measured, speed6 t01).
fn threshold(lat: &Lat, wave_n: usize, hedge: f64) -> f64 {
    let mut v = lat.lock().map(|v| v.clone()).unwrap_or_default();
    if v.len() < (wave_n / 4).max(3).min(wave_n) {
        return hedge;
    }
    v.sort_by(|a, b| a.total_cmp(b));
    (2.5 * v[v.len() / 2]).clamp(2.0f64.min(hedge), hedge)
}

/// Calls per file at most (the first one plus hedge twins). Measured (speed7): with 3, a file
/// whose three calls were all slow set the whole wall time (19 s for a 2 s median wave).
const MAX_CALLS: u32 = 4;

/// One model call's result: Some(new content) / None = UNCHANGED, and the call's usage.
pub(crate) type Answer = Result<(Option<String>, Value), String>;

/// `call` with tail hedging: a twin starts when the newest call in flight is older than
/// `threshold` (max `MAX_CALLS` calls in all); the first good answer wins and the others are abandoned.
/// Returns the answer, the usage of every call that came back, and how many calls started.
pub(crate) fn hedged(
    call: std::sync::Arc<dyn Fn() -> Answer + Send + Sync>,
    file: &str,
    hedge: f64,
    lat: &Lat,
    wave_n: usize,
    slots: &std::sync::Arc<Slots>,
) -> Result<(Option<String>, Value, u32), String> {
    let (tx, rx) = mpsc::channel::<Answer>();
    let start = |tx: mpsc::Sender<Answer>| {
        let (c, sl) = (call.clone(), slots.clone());
        std::thread::spawn(move || {
            let r = c();
            sl.release();
            let _ = tx.send(r);
        });
    };
    let t_first = Instant::now();
    slots.acquire();
    start(tx.clone());
    let mut last_start = Instant::now();
    let (mut started, mut live, mut last_err) = (1u32, 1u32, String::new());
    loop {
        // Poll at most every 250 ms so a threshold that drops mid-wait is noticed.
        let wait = if started < MAX_CALLS {
            Duration::from_secs_f64(threshold(lat, wave_n, hedge))
                .saturating_sub(last_start.elapsed())
                .clamp(Duration::from_millis(10), Duration::from_millis(250))
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(wait) {
            Ok(Ok((a, u))) => {
                if let Ok(mut v) = lat.lock() {
                    v.push(t_first.elapsed().as_secs_f64());
                }
                return Ok((a, u, started));
            }
            Ok(Err(e)) => {
                eprintln!("{file}: call failed: {}", e.chars().take(400).collect::<String>());
                live -= 1;
                last_err = e;
                if started < MAX_CALLS {
                    slots.acquire();
                    start(tx.clone());
                    last_start = Instant::now();
                    started += 1;
                    live += 1;
                } else if live == 0 {
                    return Err(last_err);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) if started < MAX_CALLS => {
                if last_start.elapsed().as_secs_f64() >= threshold(lat, wave_n, hedge)
                    && slots.try_acquire()
                {
                    start(tx.clone());
                    last_start = Instant::now();
                    started += 1;
                    live += 1;
                }
            }
            Err(_) => {
                return Err(if last_err.is_empty() {
                    "no answer".into()
                } else {
                    last_err
                })
            }
        }
    }
}

pub(crate) fn dump(root: &Path, files: &[String]) -> String {
    files
        .iter()
        .map(|f| {
            format!(
                "=== {f}\n{}",
                std::fs::read_to_string(root.join(f)).unwrap_or_default()
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// One parallel wave over `targets`; writes every changed file. Returns per-file stats.
fn wave(
    ctx: &Ctx,
    root: &Path,
    all: &[String],
    targets: &[String],
    extra: &dyn Fn(&str) -> String,
    hedge: f64,
    t0: Instant,
    slots: &std::sync::Arc<Slots>,
) -> Vec<Value> {
    let repo = dump(root, all);
    let lat: Lat = Default::default();
    let wave_n = targets.len();
    let handles: Vec<_> = targets
        .iter()
        .map(|f| {
            let (c, r, f2, e, l, sl) = (
                ctx.clone(),
                repo.clone(),
                f.clone(),
                extra(f),
                lat.clone(),
                slots.clone(),
            );
            std::thread::spawn(move || {
                let s = Instant::now();
                let f3 = f2.clone();
                let call = std::sync::Arc::new(move || ask(&c, &r, &f3, &e));
                let r = hedged(call, &f2, hedge, &l, wave_n, &sl);
                (f2, r, s.elapsed().as_secs_f64())
            })
        })
        .collect();
    let mut stats = vec![];
    for h in handles {
        let (f, r, secs) = h
            .join()
            .unwrap_or_else(|_| (String::new(), Err("executor panicked".into()), 0.0));
        stats.push(record(root, &f, r, secs, t0));
    }
    stats
}

/// Writes one executor's answer to `root/file` (if it changed) and returns its stats line.
pub(crate) fn record(root: &Path, f: &str, r: Result<(Option<String>, Value, u32), String>, secs: f64, t0: Instant) -> Value {
    let mut st = json!({"file": f, "call_s": (secs * 10.0).round() / 10.0, "at_s": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0});
    match r {
        Ok((new, usage, n)) => {
            let mut changed = false;
            if let Some(new) = new {
                let path = root.join(f);
                changed = std::fs::read_to_string(&path).map(|old| old.trim() != new.trim()).unwrap_or(true);
                if changed {
                    if let Some(d) = path.parent() {
                        let _ = std::fs::create_dir_all(d);
                    }
                    if let Err(e) = std::fs::write(&path, &new) {
                        st["error"] = json!(e.to_string());
                    }
                }
            }
            st["changed"] = json!(changed);
            st["usage"] = usage;
            st["calls"] = json!(n);
        }
        Err(e) => st["error"] = json!(e),
    }
    st
}

/// Sum of prompt / cached / completion tokens over stats lines that carry a `usage`.
pub(crate) fn token_totals(calls: &[Value]) -> Value {
    let (mut p, mut c, mut o) = (0u64, 0u64, 0u64);
    for u in calls.iter().filter_map(|c| c.get("usage")) {
        p += u["prompt_tokens"].as_u64().unwrap_or(0);
        c += u.pointer("/prompt_tokens_details/cached_tokens").and_then(Value::as_u64).unwrap_or(0);
        o += u["completion_tokens"].as_u64().unwrap_or(0);
    }
    json!({"prompt": p, "cached": c, "completion": o})
}

/// Lower-case word tokens of `s`, camelCase split, a plural `s` dropped (len > 3).
fn tokens(s: &str) -> std::collections::HashSet<String> {
    let mut spaced = String::new();
    let mut prev: Option<char> = None;
    for c in s.chars() {
        if c.is_ascii_uppercase()
            && prev.is_some_and(|p| p.is_ascii_lowercase() || p.is_ascii_digit())
        {
            spaced.push(' ');
        }
        spaced.push(c);
        prev = Some(c);
    }
    spaced
        .split(|c: char| !c.is_ascii_alphanumeric())
        .map(str::to_ascii_lowercase)
        .filter(|w| w.len() >= 3)
        .map(|w| match w.strip_suffix('s') {
            Some(b) if w.len() > 3 => b.to_string(),
            _ => w,
        })
        .collect()
}

/// `--scope auto`: the files the task is about, picked by plain code (no model round-trip).
/// A file is a target when its path is quoted in the task, or a distinctive token of its
/// basename (`MenuList.tsx` -> menu) is a word of the task. A basename token that pairs with
/// two or more different tokens across the repo (`list` in MenuList, OrderList, ...) is a
/// suffix, not a subject, and does not select. Every file stays in the prompt as context; only
/// the executors are scoped. Measured reasons (speed6): one executor per tracked file is a token
/// burst that a token-plan rate limit answers with 429 storms, and executors of files the task
/// does not name copy the change over by analogy. A file the task needs but does not name is
/// left to the gate: files blamed by --verify join the fix waves. No match -> every file.
fn scope(task: &str, files: &[String]) -> Vec<String> {
    use std::collections::{HashMap, HashSet};
    let stem = |f: &str| {
        let b = f.rsplit('/').next().unwrap_or(f);
        b.split('.').next().unwrap_or(b).to_string()
    };
    let mut partners: HashMap<String, HashSet<String>> = HashMap::new();
    for f in files {
        let t = tokens(&stem(f));
        for a in &t {
            let e = partners.entry(a.clone()).or_default();
            e.extend(t.iter().filter(|b| *b != a).cloned());
        }
    }
    let want = tokens(task);
    let picked: Vec<String> = files
        .iter()
        .filter(|f| {
            task.contains(f.as_str())
                || tokens(&stem(f))
                    .iter()
                    .any(|t| want.contains(t) && partners.get(t).map_or(0, |p| p.len()) < 2)
        })
        .cloned()
        .collect();
    if picked.is_empty() {
        files.to_vec()
    } else {
        picked
    }
}

pub(crate) fn sh(root: &Path, cmd: &str) -> (bool, String) {
    match Command::new("sh")
        .arg("-c")
        .arg(cmd)
        .current_dir(root)
        .output()
    {
        Ok(o) => (
            o.status.success(),
            format!(
                "{}{}",
                String::from_utf8_lossy(&o.stdout),
                String::from_utf8_lossy(&o.stderr)
            ),
        ),
        Err(e) => (false, e.to_string()),
    }
}

/// Tracked files named in the gate's output (`path/x.go:12:` relative to root or any subdir).
pub(crate) fn blamed(out: &str, files: &[String]) -> Vec<String> {
    let re = regex::Regex::new(r"([\w./-]+\.\w+):\d+").unwrap();
    let mut hit: Vec<String> = vec![];
    for c in re.captures_iter(out) {
        let p = c[1].trim_start_matches("./");
        if let Some(f) = files
            .iter()
            .find(|f| f.as_str() == p || f.ends_with(&format!("/{p}")))
        {
            if !hit.contains(f) {
                hit.push(f.clone());
            }
        }
    }
    hit
}

pub fn client(args: &[String]) -> i32 {
    let (mut task, mut root, mut verify, mut model_name, mut out) = (
        String::new(),
        PathBuf::from("."),
        String::new(),
        None,
        None::<PathBuf>,
    );
    let (mut only, mut hedge, mut fix_rounds, mut configs) =
        (Vec::<String>::new(), 4.0f64, 2u32, Vec::<String>::new());
    let mut max_inflight = 32usize;
    let mut scope_all = false;
    let mut clones = false;
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
            "--task-file" => match std::fs::read_to_string(config::expand_user(&val())) {
                Ok(t) => task = t,
                Err(e) => {
                    eprintln!("error: --task-file: {e}");
                    return 2;
                }
            },
            "--root" => root = config::expand_user(&val()),
            "--verify" => verify = val(),
            "-m" | "--model" => model_name = Some(val()),
            "-c" | "--config" => configs.push(val()),
            "--files" => {
                only = val()
                    .split(',')
                    .map(|s| s.trim().to_string())
                    .filter(|s| !s.is_empty())
                    .collect()
            }
            "--scope" => scope_all = val() == "all",
            "--clones" => clones = true,
            "--max-inflight" => max_inflight = val().parse().unwrap_or(max_inflight),
            "--hedge" => hedge = val().parse().unwrap_or(hedge),
            "--fix-rounds" => fix_rounds = val().parse().unwrap_or(fix_rounds),
            "-o" => out = Some(config::expand_user(&val())),
            other => {
                eprintln!("error: unknown argument {other}\n\n{HELP}");
                return 2;
            }
        }
        i += 1;
    }
    if task.trim().is_empty() {
        eprintln!("error: shard needs -t TASK or --task-file\n\n{HELP}");
        return 2;
    }
    if configs.is_empty() {
        configs.push(
            config::builtin_config_dir()
                .join("mini.yaml")
                .display()
                .to_string(),
        );
    }
    let ov = config::Overrides {
        task: None,
        model_name: model_name.clone(),
        model_class: None,
        agent_class: None,
        environment_class: None,
        cost_limit: None,
        output: None,
        yolo: false,
        exit_immediately: false,
    };
    let cfg = match config::build_run_config(&configs, &ov) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {e}");
            return 1;
        }
    };
    let model_cfg = cfg
        .get("model")
        .and_then(Value::as_object)
        .cloned()
        .unwrap_or_default();
    let files: Vec<String> = if only.is_empty() {
        let (ok, o) = sh(&root, "git ls-files");
        if !ok {
            eprintln!("error: git ls-files in {}: {o}", root.display());
            return 1;
        }
        o.lines()
            .map(String::from)
            .filter(|f| !f.is_empty())
            .collect()
    } else {
        only
    };
    let ctx = Ctx {
        model_name,
        model_cfg,
        task,
    };
    // One-shot calls are hedged, so a 429 is better retried soon than after the agent loop's
    // 4 s floor (measured: a parent call spent 36 s in 4/4/4/8/16 s backoff on a 1-file task).
    if std::env::var_os("MINI_AGENT_RETRY_MIN_WAIT").is_none() {
        std::env::set_var("MINI_AGENT_RETRY_MIN_WAIT", "1");
    }
    let slots = std::sync::Arc::new(Slots::new(max_inflight));
    let t0 = Instant::now();
    let (mut calls, targets) = if clones {
        crate::clones::run(&ctx, &root, &files, hedge, t0, &slots)
    } else {
        let targets = if scope_all {
            files.clone()
        } else {
            scope(&ctx.task, &files)
        };
        let calls = wave(&ctx, &root, &files, &targets, &|_| String::new(), hedge, t0, &slots);
        (calls, targets)
    };
    // New files written by the clones join the gate's blame list and the gofmt pass.
    let mut files = files;
    for t in &targets {
        if !files.contains(t) {
            files.push(t.clone());
        }
    }
    let gofmt = |root: &Path| {
        if files.iter().any(|f| f.ends_with(".go")) {
            let _ = sh(root, "gofmt -w $(git ls-files -co --exclude-standard '*.go') 2>/dev/null");
        }
    };
    gofmt(&root);
    let (mut ok, mut err) = if verify.is_empty() {
        (true, String::new())
    } else {
        sh(&root, &verify)
    };
    let mut rounds = 0;
    while !ok && rounds < fix_rounds {
        rounds += 1;
        let mut bad = blamed(&err, &files);
        if bad.is_empty() {
            bad = files.clone();
        }
        let tail: String = err
            .chars()
            .rev()
            .take(3000)
            .collect::<Vec<_>>()
            .into_iter()
            .rev()
            .collect();
        let gate = verify.clone();
        let extra = move |f: &str| {
            format!("\nThe repo above is the CURRENT state. The gate `{gate}` fails with:\n{tail}\nFix {f} so the gate passes.\n")
        };
        calls.extend(wave(&ctx, &root, &files, &bad, &extra, hedge, t0, &slots));
        gofmt(&root);
        (ok, err) = sh(&root, &verify);
    }
    let wall = (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let changed = calls.iter().filter(|c| c["changed"] == json!(true)).count();
    let errors: Vec<&Value> = calls.iter().filter(|c| c.get("error").is_some()).collect();
    let stats = json!({"wall_s": wall, "mode": if clones { "clones" } else { "shard" }, "targets": targets.len(), "gate": if verify.is_empty() { "none" } else if ok { "pass" } else { "FAIL" }, "fix_rounds": rounds, "files": files.len(), "changed": changed, "errors": errors.len(), "tokens": token_totals(&calls), "calls": calls});
    if let Some(p) = out {
        let _ = std::fs::write(p, serde_json::to_string_pretty(&stats).unwrap_or_default());
    }
    println!(
        "shard: {} files, {} targeted, {changed} written, gate {}, {rounds} fix round(s), {wall}s",
        files.len(),
        targets.len(),
        stats["gate"].as_str().unwrap_or("")
    );
    if !ok {
        println!(
            "{}",
            err.chars()
                .rev()
                .take(2000)
                .collect::<Vec<_>>()
                .into_iter()
                .rev()
                .collect::<String>()
        );
    }
    // Abandoned hedge twins may still be in flight: exit now instead of waiting for them.
    use std::io::Write;
    let _ = std::io::stdout().flush();
    std::process::exit(if ok && errors.is_empty() { 0 } else { 1 });
}
