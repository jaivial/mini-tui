//! `mini-agent-rs`: the Rust port of mini-swe-agent's embedded runner (`run/tui.py`).
//!
//! Drop-in for mini-tui: the same command line, the same `<traj>.json` export and
//! `<traj>.jsonl` journal (meta / msg / info / delta lines), the same control file protocol
//! (`MSWEA_CONTROL_FILE`: `MODEL`, `MESSAGE`, `COMPACT`), the same YAML configs and `.env`.

mod agent;
mod agents;
mod resources;
mod compaction;
mod context_store;
mod dispatch;
mod config;
mod e2e;
mod environment;
mod metrics;
mod models;
mod plan;
mod repl;
mod rlm;
mod shard;
mod clones;
mod coord;
mod hybrid;
mod subagents;
mod templates;
mod util;

use agent::{Agent, AgentConfig, CHILD_GROUP, SIGNAL, STOP};
use serde_json::Value;
use std::sync::atomic::Ordering;

/// Random lowercase hex (uuid4().hex prefixes in the Python code).
pub fn util_hex(n: usize) -> String {
    use rand::Rng;
    let mut rng = rand::thread_rng();
    (0..n).map(|_| format!("{:x}", rng.gen_range(0..16))).collect()
}

const USAGE: &str = "mini-swe-agent-tui - internal runner for mini-tui

Usage:
  mini-swe-agent-tui -y --exit-immediately -o <trajectory> [-m <model>]
                    [-c <config>]... -t <task> [--resume <trajectory>]
  mini-swe-agent-tui -y -o <trajectory> --resume <trajectory> --compact-only
";

#[derive(Default)]
struct Options {
    task: Option<String>,
    model_name: Option<String>,
    model_class: Option<String>,
    agent_class: Option<String>,
    environment_class: Option<String>,
    resume: Option<String>,
    output: Option<String>,
    cost_limit: Option<f64>,
    configs: Vec<String>,
    yolo: bool,
    exit_immediately: bool,
    compact_only: bool,
}

enum ParseResult {
    Run(Options),
    Help,
}

fn parse_args(argv: &[String]) -> Result<ParseResult, String> {
    let mut o = Options::default();
    let mut positional = Vec::new();
    let mut i = 0;
    while i < argv.len() {
        let arg = &argv[i];
        match arg.as_str() {
            "-y" | "--yolo" => {
                o.yolo = true;
                i += 1;
                continue;
            }
            "--exit-immediately" => {
                o.exit_immediately = true;
                i += 1;
                continue;
            }
            "--compact-only" => {
                o.compact_only = true;
                i += 1;
                continue;
            }
            "-h" | "--help" => return Ok(ParseResult::Help),
            _ => {}
        }
        let (name, inline) = match arg.split_once('=') {
            Some((n, v)) => (n.to_string(), Some(v.to_string())),
            None => (arg.clone(), None),
        };
        let dest = match name.as_str() {
            "-t" | "--task" => "task",
            "-m" | "--model" => "model_name",
            "--model-class" => "model_class",
            "--agent-class" => "agent_class",
            "--environment-class" => "environment_class",
            "-c" | "--config" => "config",
            "-o" | "--output" => "output",
            "--resume" => "resume",
            "-l" | "--cost-limit" => "cost_limit",
            _ => {
                if arg.starts_with('-') && arg != "-" {
                    return Err(format!("unknown option: {arg}\n\n{USAGE}"));
                }
                positional.push(arg.clone());
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
                if i >= argv.len() {
                    return Err(format!("{name} requires a value\n\n{USAGE}"));
                }
                let v = argv[i].clone();
                i += 1;
                v
            }
        };
        if value.is_empty() {
            return Err(format!("{name} requires a value\n\n{USAGE}"));
        }
        match dest {
            // `-t @file`: the task is read from a file the hub wrote (`MINI_AGENT_TASK_FILE=1`
            // marks it), so it is not on argv: a child's `pkill -f "<words of its task>"` would
            // otherwise match -- and kill -- every agent of the tree whose task contains them.
            "task" => {
                o.task = Some(match value.strip_prefix('@').filter(|_| std::env::var("MINI_AGENT_TASK_FILE").is_ok_and(|v| v == "1")) {
                    Some(path) => std::fs::read_to_string(path).map_err(|e| format!("-t @{path}: {e}"))?,
                    None => value,
                })
            }
            "model_name" => o.model_name = Some(value),
            "model_class" => o.model_class = Some(value),
            "agent_class" => o.agent_class = Some(value),
            "environment_class" => o.environment_class = Some(value),
            "config" => o.configs.push(value),
            "output" => o.output = Some(config::expand_user(&value).display().to_string()),
            "resume" => o.resume = Some(config::expand_user(&value).display().to_string()),
            "cost_limit" => o.cost_limit = Some(value.parse().map_err(|_| format!("invalid number for {name}: {value}"))?),
            _ => unreachable!(),
        }
    }
    if !positional.is_empty() {
        o.task = Some(positional.join(" "));
    }
    if o.compact_only && o.resume.is_none() {
        return Err("--compact-only needs --resume <trajectory>".into());
    }
    if o.task.as_deref().unwrap_or("").is_empty() && !o.compact_only {
        return Err("a task is required\n\n{USAGE}".into());
    }
    if !o.yolo {
        return Err("mini-swe-agent-tui only supports yolo runs (-y)".into());
    }
    if o.output.is_none() {
        o.output = Some(config::global_config_dir().join("last_mini_run.traj.json").display().to_string());
    }
    if o.configs.is_empty() {
        let default = std::env::var("MSWEA_MINI_CONFIG_PATH").unwrap_or_else(|_| config::builtin_config_dir().join("mini.yaml").display().to_string());
        o.configs.push(default);
    }
    Ok(ParseResult::Run(o))
}

extern "C" fn on_signal(sig: libc::c_int) {
    SIGNAL.store(sig, Ordering::SeqCst);
    STOP.store(true, Ordering::SeqCst);
    if sig == libc::SIGINT {
        // e2e: interrupt the worker subagents too (they save); the coordinator then winds down.
        for g in e2e::worker::GROUPS.iter() {
            let g = g.load(Ordering::SeqCst);
            if g > 0 {
                unsafe {
                    libc::kill(g, libc::SIGINT);
                }
            }
        }
    }
    if sig == libc::SIGTERM {
        // Python dies on SIGTERM without saving: do the same at once, whatever we are blocked in
        // (a model call's socket read included). Only the running command's process group is
        // taken down with us, as the stop path would do. But stop the subagents first: the raise
        // below skips destructors, and without this a web `session.close` (or a service restart)
        // left the children orphaned at their control file and `subagents/index.json` frozen at
        // running/waiting -- the panel showed work that had been dead for hours.
        crate::subagents::shutdown_from_signal();
        let pg = CHILD_GROUP.load(Ordering::SeqCst);
        unsafe {
            if pg > 0 {
                libc::killpg(pg, libc::SIGKILL);
            }
            // The e2e coordinator's worker subagents and browsers (each in its own process
            // group). Workers get SIGTERM first: their handler kills their running command's
            // group (which a SIGKILL of the worker would orphan), then everything is killed.
            for g in e2e::worker::GROUPS.iter() {
                let g = g.load(Ordering::SeqCst);
                if g > 0 {
                    libc::kill(g, libc::SIGTERM);
                }
            }
            let mut ts = libc::timespec { tv_sec: 0, tv_nsec: 300_000_000 };
            libc::nanosleep(&ts, &mut ts);
            for g in e2e::worker::GROUPS.iter() {
                let g = g.load(Ordering::SeqCst);
                if g > 0 {
                    libc::killpg(g, libc::SIGKILL);
                }
            }
            libc::signal(libc::SIGTERM, libc::SIG_DFL);
            libc::raise(libc::SIGTERM);
        }
    }
}

/// Die by the signal that stopped us, as Python does (the parent sees -2 / -15).
fn die_by_signal() -> ! {
    // Raising the signal skips destructors: stop the subagents (they save) first.
    subagents::shutdown();
    let sig = SIGNAL.load(Ordering::SeqCst);
    let sig = if sig == 0 { libc::SIGTERM } else { sig };
    unsafe {
        libc::signal(sig, libc::SIG_DFL);
        libc::raise(sig);
    }
    std::process::exit(128 + sig);
}

fn install_signals() {
    // No SA_RESTART: a SIGINT during a blocking read (a model call) makes it fail with EINTR,
    // so the call returns and the stop flag is seen, like Python's KeyboardInterrupt.
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = on_signal as extern "C" fn(libc::c_int) as libc::sighandler_t;
        action.sa_flags = 0;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}

fn run(o: Options) -> Result<(), String> {
    let overrides = config::Overrides {
        task: o.task.clone(),
        model_name: o.model_name.clone(),
        model_class: o.model_class.clone(),
        agent_class: o.agent_class.clone(),
        environment_class: o.environment_class.clone(),
        cost_limit: o.cost_limit,
        output: o.output.clone(),
        yolo: o.yolo,
        exit_immediately: o.exit_immediately,
    };
    let cfg = config::build_run_config(&o.configs, &overrides)?;
    let section = |k: &str| cfg.get(k).and_then(Value::as_object).cloned().unwrap_or_default();
    let mut agent_cfg = section("agent");
    match agent_cfg.shift_remove("agent_class").and_then(|v| v.as_str().map(String::from)).as_deref() {
        None | Some("default") | Some("minisweagent.agents.default.DefaultAgent") => {}
        // The interactive agent asks for confirmations on a terminal; mini-tui always runs yolo,
        // where it behaves like the default agent.
        Some("interactive") | Some("minisweagent.agents.interactive.InteractiveAgent") => {}
        Some(other) => return Err(format!("Unknown agent type: {other} (the Rust agent supports: default)")),
    }
    let model_cfg = section("model");
    let model = models::get_model(None, &model_cfg)?;
    let env = environment::get_environment(&section("environment"))?;
    let agent_config = AgentConfig::from(&agent_cfg)?;
    // Subagents: a hub for this session's children (socket + monitor), reachable from the bash
    // tool as `mini-agent-rs agent …`. Its guard stops the children when the run ends.
    let _subagents = match &agent_config.output_path {
        Some(traj) => {
            let mut specs = o.configs.clone();
            // Children inherit the run's config files, not its one-off `key=value` overrides of this run's limits.
            specs.retain(|s| !s.starts_with("agent.step_limit="));
            subagents::start(traj, &specs, agent_config.cost_limit)
        }
        None => None,
    };
    let mut agent = Agent::new(model, env, agent_config);
    agent.requested_model = model_cfg.get("model_name").and_then(Value::as_str).unwrap_or("").to_string();
    let resume: Option<Vec<Value>> = match &o.resume {
        Some(p) => {
            let text = std::fs::read_to_string(p).map_err(|e| format!("{p}: {e}"))?;
            let v: Value = serde_json::from_str(&text).map_err(|e| format!("{p}: {e}"))?;
            Some(v.get("messages").and_then(Value::as_array).cloned().unwrap_or_default())
        }
        None => None,
    };
    let result = agent.run(o.task.as_deref().unwrap_or(""), resume, o.compact_only);
    match result {
        Ok(_) => Ok(()),
        Err(e) if e.kind == "KeyboardInterrupt" => {
            // SIGINT is Python's KeyboardInterrupt (its `finally` saves); SIGTERM kills Python
            // outright, before any save. The running command's group was killed either way.
            if SIGNAL.load(Ordering::SeqCst) != libc::SIGTERM {
                agent.save_interrupted();
            }
            die_by_signal();
        }
        Err(e) if e.kind == "KeyboardInterruptIdle" => die_by_signal(),
        Err(e) => Err(format!("{}: {}", e.kind, e.message)),
    }
}

/// Python's `" ".join(text.splitlines()[0].split())`, cut to 60 code points.
fn first_line_title(text: &str) -> String {
    let text = text.trim();
    let first = text.lines().next().unwrap_or("");
    let joined = first.split_whitespace().collect::<Vec<_>>().join(" ");
    joined.chars().take(60).collect()
}

fn reply_text(m: &Value, submission_first: bool) -> String {
    let content = m.get("content").and_then(Value::as_str).unwrap_or("");
    let sub = m.pointer("/extra/submission").and_then(Value::as_str).unwrap_or("");
    let text = if submission_first { if sub.is_empty() { content } else { sub } } else if content.is_empty() { sub } else { content };
    text.trim().to_string()
}

/// `mini-agent-rs title <task> <model>`: `scripts/gen_title.py`, printing a JSON string
/// (empty on any failure).
fn cmd_title(args: &[String]) -> i32 {
    let task = args.first().cloned().unwrap_or_default();
    let model = args.get(1).cloned().unwrap_or_default();
    let prompt = format!("Write a short title (max 8 words, no quotes, no trailing punctuation) for this coding task. Reply with ONLY the title.\n\nTASK:\n{task}");
    let title = models::get_model(Some(&model), &serde_json::Map::new())
        .ok()
        .and_then(|mut m| m.query(&[serde_json::json!({"role": "user", "content": prompt})], None).ok())
        .and_then(|r| match r {
            models::Reply::Message(m) => Some(first_line_title(&reply_text(&m, true))),
            models::Reply::FormatError(_) => None,
        })
        .unwrap_or_default();
    println!("{}", util::py_json(&Value::String(title), false));
    0
}

/// `mini-agent-rs test-model <model>`: `scripts/test_model.py` — exit 0 when a one-word
/// completion (or a tool call) comes back.
fn cmd_test_model(args: &[String]) -> i32 {
    let model = args.first().cloned().unwrap_or_default();
    let result = models::get_model(Some(&model), &serde_json::Map::new()).map_err(|e| format!("ValueError: {e}")).and_then(|mut m| {
        m.query(&[serde_json::json!({"role": "user", "content": "Reply with the single word: ok"})], None).map_err(|e| format!("{}: {}", e.kind, e.message))
    });
    match result {
        Ok(models::Reply::Message(m)) => {
            let has_actions = m.pointer("/extra/actions").and_then(Value::as_array).is_some_and(|a| !a.is_empty());
            if !reply_text(&m, false).is_empty() || has_actions {
                println!("ok");
                return 0;
            }
            eprintln!("error: the model answered with an empty message");
            1
        }
        // A reply the model layer could not parse still proves the endpoint answers... but Python
        // raises FormatError here, which the script reports as a failure: keep that.
        Ok(models::Reply::FormatError(_)) => {
            eprintln!("error: FormatError: FormatError()");
            1
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

fn main() {
    let argv: Vec<String> = std::env::args().skip(1).collect();
    // `e2e` (the test coordinator) and `browser` (its workers' client): see E2E.md.
    if argv.first().map(String::as_str) == Some("e2e") {
        config::load_dotenv();
        install_signals();
        std::process::exit(e2e::main(&argv[1..]));
    }
    if argv.first().map(String::as_str) == Some("agent") {
        std::process::exit(subagents::client(&argv[1..]));
    }
    if argv.first().map(String::as_str) == Some("browser") {
        std::process::exit(e2e::server::client(&argv[1..]));
    }
    // The RLM harness (experimental, behind its own subcommand): a persistent REPL with context
    // as variables and sub-agents as calls. Nothing else in the binary couples to it.
    // The REPL harness (RLM-style): context in a sandboxed Rhai REPL, sub-calls as functions.
    if argv.first().map(String::as_str) == Some("repl") {
        config::load_dotenv();
        install_signals();
        std::process::exit(repl::client(&argv[1..]));
    }
    // `shard`: one one-shot executor per file, all in parallel, no coordinator model (src/shard.rs).
    if argv.first().map(String::as_str) == Some("shard") {
        config::load_dotenv();
        install_signals();
        std::process::exit(shard::client(&argv[1..]));
    }
    // `orchestrate` = `shard --coord`: an LLM coordinator plans and reviews, workers are copies of
    // its session on the cheap model (src/coord.rs). `shard --hybrid` / `--clones` keep speed8/7.
    if argv.first().map(String::as_str) == Some("orchestrate") {
        config::load_dotenv();
        install_signals();
        let mut a = vec!["--coord".to_string()];
        a.extend(argv[1..].iter().cloned());
        std::process::exit(shard::client(&a));
    }
    if argv.first().map(String::as_str) == Some("rlm") {
        config::load_dotenv();
        install_signals();
        std::process::exit(rlm::client(&argv[1..]));
    }
    // One-shot helpers mini-tui runs besides the agent itself.
    if let Some(cmd) = argv.first().map(String::as_str).filter(|c| *c == "title" || *c == "test-model" || *c == "metrics") {
        config::load_dotenv();
        let code = if cmd == "title" {
            cmd_title(&argv[1..])
        } else if cmd == "metrics" {
            metrics::client(&argv[1..])
        } else {
            cmd_test_model(&argv[1..])
        };
        std::process::exit(code);
    }
    let parsed = match parse_args(&argv) {
        Ok(ParseResult::Help) => {
            println!("{USAGE}");
            return;
        }
        Ok(ParseResult::Run(o)) => o,
        Err(e) => {
            eprintln!("error: {e}");
            std::process::exit(2);
        }
    };
    config::load_dotenv();
    install_signals();
    if let Err(e) = run(parsed) {
        eprintln!("{e}");
        std::process::exit(1);
    }
}

