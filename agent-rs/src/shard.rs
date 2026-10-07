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
//!      twin (at most 3); the first complete answer wins;
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

const HELP: &str = "mini-agent-rs shard -t TASK --root DIR [--verify CMD] [-m MODEL] [--files a,b] [--hedge SECS] [--fix-rounds N] [-o stats.json]

One one-shot executor per file, all in parallel, no coordinator model. Each executor sees the task
and every file, and writes back only its own file. --verify (run in --root with sh -c) is the gate;
files named in its errors get up to --fix-rounds more parallel waves. Default: every `git ls-files`
file, hedge 8 s, 2 fix rounds.";

const SYSTEM: &str = "You are an executor. You output file contents only, never commentary.";

#[derive(Clone)]
struct Ctx {
    model_name: Option<String>,
    model_cfg: Obj,
    task: String,
}

/// One answer for one file: Some(new content), None = UNCHANGED.
fn ask(ctx: &Ctx, repo: &str, file: &str, extra: &str) -> Result<(Option<String>, u64), String> {
    let prompt = format!(
        "TASK for the whole repository:\n{task}\n\nRepository (every file):\n{repo}\n\n\
         Several workers edit this repo at once, ONE FILE EACH, all from the same task text, so use exactly the names, \
         signatures, JSON tags and props the task gives. Keep the existing wire contract. Other files will be updated by \
         their own workers as the task requires; you may rely on that.\nYOUR FILE: {file}\n{extra}\
         If the task requires no change to {file}, answer exactly UNCHANGED. Otherwise answer with the line {BEGIN}, then the COMPLETE new content of {file}, \
         then the line {END}, and nothing else (no code fences around it). No tests.",
        task = ctx.task
    );
    let mut model = get_model(ctx.model_name.as_deref(), &ctx.model_cfg)?;
    let msgs = vec![
        model.format_message("system", SYSTEM, None),
        model.format_message("user", &prompt, None),
    ];
    let msg = match model
        .query(&msgs, None)
        .map_err(|e| format!("{}: {}", e.kind, e.message))?
    {
        Reply::Message(m) => m,
        Reply::FormatError(ms) => ms.into_iter().next().unwrap_or(Value::Null),
    };
    let out_tok = msg
        .pointer("/extra/response/usage/completion_tokens")
        .and_then(Value::as_u64)
        .unwrap_or(0);
    let text = msg
        .pointer("/extra/submission")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| shapes::text_of(msg.get("content").unwrap_or(&Value::Null)));
    parse_answer(&text).map(|a| (a, out_tok))
}

const BEGIN: &str = "<<<FILE";
const END: &str = "FILE>>>";

/// The answer's file content, between the BEGIN and END lines. Unique markers, not code fences:
/// a markdown file with a fenced example inside it was cut at the inner fence (measured, a doc
/// truncated mid-example). No END = a truncated answer: an error, so the hedge tries again instead
/// of writing half a file.
fn parse_answer(text: &str) -> Result<Option<String>, String> {
    let think = regex::Regex::new(r"(?s)<think>.*?</think>").unwrap();
    let t = think.replace_all(text, "");
    let t = t.trim();
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

/// `ask` with tail hedging: a twin starts every `hedge` seconds while none is back (max 3 in
/// flight in all); the first good answer wins and the others are abandoned.
fn hedged(
    ctx: &Ctx,
    repo: &str,
    file: &str,
    extra: &str,
    hedge: f64,
) -> Result<(Option<String>, u64, u32), String> {
    let (tx, rx) = mpsc::channel();
    let start = |tx: mpsc::Sender<Result<(Option<String>, u64), String>>| {
        let (c, r, f, e) = (
            ctx.clone(),
            repo.to_string(),
            file.to_string(),
            extra.to_string(),
        );
        std::thread::spawn(move || {
            let _ = tx.send(ask(&c, &r, &f, &e));
        });
    };
    start(tx.clone());
    let (mut started, mut live, mut last_err) = (1u32, 1u32, String::new());
    loop {
        let wait = if started < 3 {
            Duration::from_secs_f64(hedge)
        } else {
            Duration::from_secs(3600)
        };
        match rx.recv_timeout(wait) {
            Ok(Ok((a, t))) => return Ok((a, t, started)),
            Ok(Err(e)) => {
                live -= 1;
                last_err = e;
                if started < 3 {
                    start(tx.clone());
                    started += 1;
                    live += 1;
                } else if live == 0 {
                    return Err(last_err);
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) if started < 3 => {
                start(tx.clone());
                started += 1;
                live += 1;
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

fn dump(root: &Path, files: &[String]) -> String {
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
) -> Vec<Value> {
    let repo = dump(root, all);
    let handles: Vec<_> = targets
        .iter()
        .map(|f| {
            let (c, r, f2, e) = (ctx.clone(), repo.clone(), f.clone(), extra(f));
            std::thread::spawn(move || {
                let s = Instant::now();
                let r = hedged(&c, &r, &f2, &e, hedge);
                (f2, r, s.elapsed().as_secs_f64())
            })
        })
        .collect();
    let mut stats = vec![];
    for h in handles {
        let (f, r, secs) = h
            .join()
            .unwrap_or_else(|_| (String::new(), Err("executor panicked".into()), 0.0));
        let mut st = json!({"file": f, "call_s": (secs * 10.0).round() / 10.0, "at_s": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0});
        match r {
            Ok((Some(new), tok, n)) => {
                let path = root.join(&f);
                let changed = std::fs::read_to_string(&path)
                    .map(|old| old.trim() != new.trim())
                    .unwrap_or(true);
                if changed {
                    if let Err(e) = std::fs::write(&path, &new) {
                        st["error"] = json!(e.to_string());
                    }
                }
                st["changed"] = json!(changed);
                st["out_tokens"] = json!(tok);
                st["calls"] = json!(n);
            }
            Ok((None, tok, n)) => {
                st["changed"] = json!(false);
                st["out_tokens"] = json!(tok);
                st["calls"] = json!(n);
            }
            Err(e) => st["error"] = json!(e),
        }
        stats.push(st);
    }
    stats
}

fn sh(root: &Path, cmd: &str) -> (bool, String) {
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
fn blamed(out: &str, files: &[String]) -> Vec<String> {
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
        (Vec::<String>::new(), 8.0f64, 2u32, Vec::<String>::new());
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
    let t0 = Instant::now();
    let mut calls = wave(&ctx, &root, &files, &files, &|_| String::new(), hedge, t0);
    let gofmt = |root: &Path| {
        if files.iter().any(|f| f.ends_with(".go")) {
            let _ = sh(root, "gofmt -w $(git ls-files '*.go') 2>/dev/null");
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
        calls.extend(wave(&ctx, &root, &files, &bad, &extra, hedge, t0));
        gofmt(&root);
        (ok, err) = sh(&root, &verify);
    }
    let wall = (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0;
    let changed = calls.iter().filter(|c| c["changed"] == json!(true)).count();
    let errors: Vec<&Value> = calls.iter().filter(|c| c.get("error").is_some()).collect();
    let stats = json!({"wall_s": wall, "gate": if verify.is_empty() { "none" } else if ok { "pass" } else { "FAIL" }, "fix_rounds": rounds, "files": files.len(), "changed": changed, "errors": errors.len(), "calls": calls});
    if let Some(p) = out {
        let _ = std::fs::write(p, serde_json::to_string_pretty(&stats).unwrap_or_default());
    }
    println!(
        "shard: {} files, {changed} written, gate {}, {rounds} fix round(s), {wall}s",
        files.len(),
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
