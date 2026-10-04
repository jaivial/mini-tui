//! `mini-agent-rs e2e`: AI end-to-end tests (goals in plain language, exact checks, cached
//! replays), with worker subagents coordinated by this process. See agent-rs/E2E.md.

pub mod browser;
pub mod cache;
pub mod cdp;
pub mod coordinator;
pub mod nginx;
pub mod project;
pub mod report;
pub mod secrets;
pub mod server;
pub mod worker;

use project::{Overrides, Project};
use std::path::{Path, PathBuf};
use std::sync::Arc;

/// The agent skill that teaches agents to use this command (also bundled by mini-tui).
pub const SKILL: &str = include_str!("../../../skills/e2e/SKILL.md");

const USAGE: &str = "mini-agent-rs e2e - AI end-to-end tests for any project with an e2e.yaml

Usage:
  mini-agent-rs e2e [run] [TEST_FILES...] [options]   run the tests
  mini-agent-rs e2e init [--base-url URL] [--server-name NAME]   write e2e.yaml + an example test
  mini-agent-rs e2e detect-url [--project DIR] [--server-name NAME]   the nginx URL serving a project
  mini-agent-rs e2e check-url [--env NAME] [--base-url URL] [--profile NAME]   preflight: reachability, TLS, HTTP auth
  mini-agent-rs e2e clear-cache [--auth]               drop cached actions (and saved logins)
  mini-agent-rs e2e last [-C PATH]                     the latest run: running/finished, progress, report
  mini-agent-rs e2e skill                              print the bundled agent skill (SKILL.md)
  mini-agent-rs browser <command>                      (used by worker subagents)

Options:
  -C, --config PATH        e2e.yaml to use (default: searched upward from the current directory)
  --env NAME               environment from e2e.yaml (also E2E_ENV)
  --base-url URL           override the base URL (also E2E_BASE_URL); `auto` = detect from nginx
  --server-name NAME       with auto: the nginx vhost to use
  --profile NAME           auth profile for every test (`none` = logged out)
  -m, --model MODEL        model for act steps (default: models.worker, else MSWEA_MODEL_NAME)
  --judge-model MODEL      model for assert steps (default: models.judge, else the act model)
  --escalate-model MODEL   retry a failed act step once with this model (default: models.escalate)
  --vision / --no-vision   force sending screenshots to workers (default: by model name)
  -j, --parallel N         tests at a time (default 1)
  -l, --cost-limit USD     total budget for all subagents (default 5; 0 = none)
  --step-limit N           model calls per subagent (default 40)
  --grep TEXT              only tests whose name contains TEXT
  --no-cache               ignore cached actions        --update-cache   re-record them
  --fresh-login            ignore saved login sessions  --headed         show the browser
";

fn take(args: &mut Vec<String>, names: &[&str]) -> Option<String> {
    let i = args.iter().position(|a| names.contains(&a.as_str()) || names.iter().any(|n| a.starts_with(&format!("{n}="))))?;
    let a = args.remove(i);
    if let Some((_, v)) = a.split_once('=') {
        return Some(v.to_string());
    }
    if i < args.len() {
        Some(args.remove(i))
    } else {
        None
    }
}

fn flag(args: &mut Vec<String>, name: &str) -> bool {
    if let Some(i) = args.iter().position(|a| a == name) {
        args.remove(i);
        true
    } else {
        false
    }
}

fn locate_config(explicit: Option<String>) -> Result<PathBuf, String> {
    if let Some(c) = explicit {
        let p = PathBuf::from(&c);
        return if p.is_dir() { Ok(p.join(project::CONFIG_NAME)) } else { Ok(p) };
    }
    let cwd = std::env::current_dir().map_err(|e| e.to_string())?;
    project::find_config(&cwd).ok_or_else(|| format!("no {} in {} or any parent directory (run `mini-agent-rs e2e init`)", project::CONFIG_NAME, cwd.display()))
}

/// The base URL to test, resolving `auto` through nginx. Returns (url, how, needs_http_auth).
fn resolve_base(p: &Project, server_name: Option<&str>) -> Result<(String, String, bool), String> {
    let sn = server_name.map(String::from).or_else(|| p.server_name.clone());
    if p.base_url != "auto" {
        return Ok((p.base_url.trim_end_matches('/').to_string(), "configured".into(), false));
    }
    let m = nginx::detect(&p.root, sn.as_deref())?;
    let cache = p.cache_dir.join("base_url.json");
    cache::ensure_gitignore(&p.cache_dir);
    let _ = std::fs::write(&cache, serde_json::to_string_pretty(&serde_json::json!({"url": m.url, "server_name": m.server_name, "file": m.file.display().to_string(), "how": m.how, "http_auth": m.auth_basic, "detected_at": crate::util::now()})).unwrap());
    Ok((m.url.clone(), format!("nginx {} ({})", m.file.display(), m.how), m.auth_basic))
}

/// Reachability, TLS and HTTP-auth preflight (no model). Errors are actionable.
fn preflight(url: &str, basic: Option<(String, String)>, secrets_file: Option<&Path>) -> Result<String, String> {
    let agent = ureq::AgentBuilder::new().timeout(std::time::Duration::from_secs(20)).redirects(0).build();
    let r = agent.get(url).call();
    let (code, auth_header) = match r {
        Ok(resp) => (resp.status(), resp.header("www-authenticate").map(String::from)),
        Err(ureq::Error::Status(c, resp)) => (c, resp.header("www-authenticate").map(String::from)),
        Err(ureq::Error::Transport(t)) => {
            let msg = t.to_string();
            let hint = if msg.to_lowercase().contains("certificate") { " (TLS certificate problem)" } else { "" };
            return Err(format!("{url} is not reachable{hint}: {msg}"));
        }
    };
    if code == 401 && auth_header.as_deref().is_some_and(|h| h.to_lowercase().starts_with("basic")) {
        let Some((u, pw)) = basic else {
            return Err(format!("{url} asks for HTTP Basic Auth ({}), but no `http_basic` credentials are configured (auth.http_basic for the whole site, or the profile's)", auth_header.unwrap_or_default()));
        };
        let user = secrets::resolve(&u, secrets_file)?;
        let pass = secrets::resolve(&pw, secrets_file)?;
        use base64::Engine;
        let token = base64::engine::general_purpose::STANDARD.encode(format!("{user}:{pass}"));
        let code2 = match agent.get(url).set("Authorization", &format!("Basic {token}")).call() {
            Ok(r) => r.status(),
            Err(ureq::Error::Status(c, _)) => c,
            Err(e) => return Err(format!("{url}: {e}")),
        };
        if code2 == 401 {
            return Err(format!("{url} rejected the HTTP Basic Auth credentials"));
        }
        return Ok(format!("{url}: HTTP Basic Auth required and accepted (HTTP {code2})"));
    }
    Ok(format!("{url}: HTTP {code}{}", if code == 401 { " (401 without a Basic challenge: the app's own auth)" } else { "" }))
}

fn cmd_detect(mut args: Vec<String>) -> Result<i32, String> {
    let dir = take(&mut args, &["--project"]).map(PathBuf::from).unwrap_or_else(|| std::env::current_dir().unwrap_or_default());
    let sn = take(&mut args, &["--server-name"]);
    let m = nginx::detect(&dir, sn.as_deref())?;
    println!("{}", m.url);
    eprintln!("server_name {} in {} via {}{}", m.server_name, m.file.display(), m.how, if m.auth_basic { "; nginx asks for HTTP Basic Auth" } else { "" });
    Ok(0)
}

fn cmd_init(mut args: Vec<String>) -> Result<i32, String> {
    let base = take(&mut args, &["--base-url"]);
    let sn = take(&mut args, &["--server-name"]);
    let force = flag(&mut args, "--force");
    let root = std::env::current_dir().map_err(|e| e.to_string())?;
    let cfg = root.join(project::CONFIG_NAME);
    if cfg.exists() && !force {
        return Err(format!("{} already exists (use --force to overwrite)", cfg.display()));
    }
    let (url, http_auth, note) = match base {
        Some(b) => (b, false, "given on the command line".to_string()),
        None => match nginx::detect(&root, sn.as_deref()) {
            Ok(m) => ("auto".to_string(), m.auth_basic, format!("detected {} ({})", m.url, m.how)),
            Err(e) => ("http://127.0.0.1:3000".to_string(), false, format!("could not detect a URL: {e}")),
        },
    };
    let prefix = root.file_name().and_then(|n| n.to_str()).unwrap_or("APP").to_uppercase().chars().map(|c| if c.is_ascii_alphanumeric() { c } else { '_' }).collect::<String>();
    let mut profiles = String::new();
    profiles.push_str("    user:\n");
    profiles.push_str(&format!(
        "      # form:                       # the app's own login page (delete if it has none)\n      #   url: /login\n      #   user_field: label=Email\n      #   password_field: label=Password\n      #   submit: role=button[name=Sign in]\n      #   success: {{ url_not_contains: /login }}\n      #   user: env:{prefix}_USER\n      #   password: env:{prefix}_PASS\n      #   totp: env:{prefix}_TOTP   # optional two-factor secret\n"
    ));
    let worker = std::env::var("MSWEA_MODEL_NAME").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| "deepseek/deepseek-flash".into());
    let text = project::SAMPLE_CONFIG
        .replace("{BASE_URL}", &url)
        .replace("{SERVER_NAME}", &sn.map(|s| format!("server_name: {s}\n")).unwrap_or_default())
        .replace("{WORKER}", &worker)
        .replace("{JUDGE}", "cliproxy/claude-sonnet-5-5")
        .replace("{DEFAULT_PROFILE}", "user")
        .replace("{SITE_BASIC}", &if http_auth { format!("  # nginx asks for a password before the app loads (every profile, `none` too)\n  http_basic: {{ user: env:{prefix}_BASIC_USER, password: env:{prefix}_BASIC_PASS }}\n") } else { "  # http_basic: { user: env:NAME, password: env:NAME }   # an nginx auth_basic gate\n".into() })
        .replace("{PROFILES}", profiles.trim_end());
    std::fs::write(&cfg, text).map_err(|e| e.to_string())?;
    let tdir = root.join("e2e");
    std::fs::create_dir_all(&tdir).map_err(|e| e.to_string())?;
    let t = tdir.join("smoke.e2e.yaml");
    if !t.exists() {
        std::fs::write(&t, project::SAMPLE_TEST).map_err(|e| e.to_string())?;
    }
    println!("wrote {} and {}\nbase URL: {note}", cfg.display(), t.display());
    if http_auth {
        println!("nginx asks for HTTP Basic Auth: set {prefix}_BASIC_USER / {prefix}_BASIC_PASS (environment, or ~/.config/mini-tui/e2e-secrets.env with chmod 600)");
    }
    println!("add .e2e-cache/ and .e2e-runs/ to .gitignore (each also gets its own `*` .gitignore)");
    Ok(0)
}

fn load_project(args: &mut Vec<String>) -> Result<(Project, Option<String>), String> {
    let cfg = locate_config(take(args, &["-C", "--config"]))?;
    let o = Overrides { environment: take(args, &["--env"]), base_url: take(args, &["--base-url"]), profile: take(args, &["--profile"]) };
    let sn = take(args, &["--server-name"]);
    Ok((Project::load(&cfg, &o)?, sn))
}

fn cmd_check(mut args: Vec<String>) -> Result<i32, String> {
    let (p, sn) = load_project(&mut args)?;
    let (url, how, auth) = resolve_base(&p, sn.as_deref())?;
    println!("base URL {url} ({how}){}", if auth { "; nginx asks for HTTP Basic Auth" } else { "" });
    let prof = p.profile(None)?;
    match preflight(&url, p.basic_for(prof.as_ref()), p.secrets_file.as_deref()) {
        Ok(m) => {
            println!("{}", secrets::scrub(&m));
            Ok(0)
        }
        Err(e) => {
            eprintln!("{}", secrets::scrub(&e));
            Ok(1)
        }
    }
}

fn cmd_clear(mut args: Vec<String>) -> Result<i32, String> {
    let auth = flag(&mut args, "--auth");
    let (p, _) = load_project(&mut args)?;
    let _ = std::fs::remove_dir_all(p.cache_dir.join("steps"));
    let _ = std::fs::remove_file(p.cache_dir.join("base_url.json"));
    if auth {
        let _ = std::fs::remove_dir_all(p.cache_dir.join("auth"));
    }
    println!("cleared {}{}", p.cache_dir.display(), if auth { " (including saved logins)" } else { "" });
    Ok(0)
}

fn cmd_run(mut args: Vec<String>) -> Result<i32, String> {
    let (p, sn) = load_project(&mut args)?;
    let model = take(&mut args, &["-m", "--model"]).or_else(|| p.model("worker"));
    let judge = take(&mut args, &["--judge-model"]).or_else(|| p.model("judge"));
    let escalate = take(&mut args, &["--escalate-model"]).or_else(|| p.model("escalate"));
    let parallel: usize = take(&mut args, &["-j", "--parallel"]).map(|v| v.parse().map_err(|_| format!("bad --parallel {v}"))).transpose()?.unwrap_or(1);
    let cost_limit: f64 = take(&mut args, &["-l", "--cost-limit"]).map(|v| v.parse().map_err(|_| format!("bad --cost-limit {v}"))).transpose()?.unwrap_or(5.0);
    let step_limit: i64 = take(&mut args, &["--step-limit"]).map(|v| v.parse().map_err(|_| format!("bad --step-limit {v}"))).transpose()?.unwrap_or(40);
    let grep = take(&mut args, &["--grep"]);
    let vision = if flag(&mut args, "--vision") { Some(true) } else if flag(&mut args, "--no-vision") { Some(false) } else { None };
    let no_cache = flag(&mut args, "--no-cache");
    let update_cache = flag(&mut args, "--update-cache");
    let fresh_login = flag(&mut args, "--fresh-login");
    let headed = flag(&mut args, "--headed");
    if let Some(bad) = args.iter().find(|a| a.starts_with('-')) {
        return Err(format!("unknown option {bad}\n\n{USAGE}"));
    }
    let files = p.test_files(&args)?;
    let mut tests = vec![];
    for f in &files {
        tests.extend(project::load_tests(f)?);
    }
    if let Some(g) = &grep {
        tests.retain(|t| t.name.to_lowercase().contains(&g.to_lowercase()));
    }
    if tests.is_empty() {
        return Err("no tests to run".into());
    }
    if p.read_only {
        if let Some(t) = tests.iter().find(|t| t.steps.iter().any(|s| matches!(s, project::Step::Act(_) | project::Step::Do(..)))) {
            return Err(format!("environment {} is read_only, but test {:?} has act/click/type steps", p.environment.clone().unwrap_or_default(), t.name));
        }
    }
    let (base, how, nginx_auth) = resolve_base(&p, sn.as_deref())?;
    eprintln!("e2e: {} test(s) against {base} ({how}){}", tests.len(), p.environment.as_ref().map(|e| format!(", environment {e}")).unwrap_or_default());
    // Preflight once per profile in use: fail before any model call.
    let mut checked = std::collections::BTreeSet::new();
    for t in &tests {
        let prof = p.profile(t.profile.as_deref())?;
        let key = prof.as_ref().map(|x| x.name.clone()).unwrap_or_default();
        if checked.insert(key.clone()) {
            let basic = p.basic_for(prof.as_ref());
            if nginx_auth && basic.is_none() {
                eprintln!("warning: nginx asks for HTTP Basic Auth on {base}, but no http_basic credentials are configured");
            }
            match preflight(&t.base_url.clone().unwrap_or(base.clone()), basic, p.secrets_file.as_deref()) {
                Ok(m) => eprintln!("preflight ({}): {}", if key.is_empty() { "logged out" } else { &key }, secrets::scrub(&m)),
                Err(e) => return Err(secrets::scrub(&e)),
            }
        }
    }
    let exe = std::env::current_exe().map_err(|e| e.to_string())?;
    let task = format!("Run {} e2e test(s) from {} against {base}", tests.len(), files.iter().map(|f| f.strip_prefix(&p.root).unwrap_or(f).display().to_string()).collect::<Vec<_>>().join(", "));
    cache::ensure_gitignore(&p.out_dir);
    let run = coordinator::new_run(&p, &base, cost_limit, &task);
    let (worker_cfg, worker_cfg_vision) = coordinator::write_worker_configs(&run.dir, step_limit)?;
    let bin_dir = run.dir.join("bin");
    worker::browser_wrapper(&bin_dir, &exe)?;
    eprintln!("run directory: {} (coordinator trajectory: {})", run.dir.display(), run.traj.display());
    let env = p.environment.clone();
    let ctx = Arc::new(coordinator::Ctx {
        project: p,
        opts: coordinator::Options { worker_model: model, judge_model: judge, escalate_model: escalate, parallel, use_cache: !no_cache, update_cache, fresh_login, headed, vision },
        run: run.clone(),
        exe,
        worker_cfg,
        worker_cfg_vision,
        bin_dir,
    });
    let results = coordinator::run_all(ctx, tests);
    coordinator::finish(&run, &results);
    report::write_all(&run.dir, &base, env.as_deref(), &results)?;
    let passed = results.iter().filter(|r| r.status == "pass").count();
    println!();
    for r in &results {
        let icon = match r.status.as_str() {
            "pass" => "PASS",
            "fail" => "FAIL",
            _ => "ERROR",
        };
        println!("{icon:5} {} ({:.1} s, ${:.4}){}", r.name, r.seconds, r.cost, if r.reason.is_empty() { String::new() } else { format!(" — {}", secrets::scrub(&r.reason)) });
    }
    println!("\n{passed}/{} passed · reports: {}/report.md, junit.xml, report.json", results.len(), run.dir.display());
    Ok(if passed == results.len() { 0 } else { 1 })
}

/// `e2e last`: the latest run of the project, for polling a background run.
fn cmd_last(mut args: Vec<String>) -> Result<i32, String> {
    let (p, _) = load_project(&mut args)?;
    let mut runs: Vec<PathBuf> = std::fs::read_dir(&p.out_dir).map(|rd| rd.flatten().map(|e| e.path()).filter(|x| x.join("coordinator.traj.jsonl").exists()).collect()).unwrap_or_default();
    runs.sort();
    let Some(dir) = runs.pop() else {
        println!("no runs yet in {}", p.out_dir.display());
        return Ok(1);
    };
    let journal = std::fs::read_to_string(dir.join("coordinator.traj.jsonl")).unwrap_or_default();
    let mut notes: Vec<String> = vec![];
    let mut exit: Option<String> = None;
    let mut cost = 0.0;
    for line in journal.lines() {
        let Ok(v) = serde_json::from_str::<serde_json::Value>(line) else { continue };
        match v.get("t").and_then(|t| t.as_str()) {
            Some("msg") => {
                let m = &v["m"];
                let role = m.get("role").and_then(|r| r.as_str()).unwrap_or("");
                let text = m.get("content").and_then(|c| c.as_str()).unwrap_or("").to_string();
                if role == "exit" {
                    exit = Some(text);
                } else if role != "system" {
                    notes.push(text);
                }
            }
            Some("info") => cost = v.pointer("/i/model_stats/instance_cost").and_then(|c| c.as_f64()).unwrap_or(cost),
            _ => {}
        }
    }
    let state = match &exit {
        Some(e) => format!("finished: {e}"),
        None => "running (or stopped without finishing: check its log)".into(),
    };
    println!("run {}\nstate: {state} · cost so far ${cost:.4}\n", dir.display());
    let tail = notes.len().saturating_sub(12);
    for n in &notes[tail..] {
        println!("- {}", n.chars().take(300).collect::<String>().replace('\n', " "));
    }
    if exit.is_some() {
        if let Ok(md) = std::fs::read_to_string(dir.join("report.md")) {
            println!("\n{md}");
        }
        return Ok(0);
    }
    Ok(3)
}

pub fn main(argv: &[String]) -> i32 {
    let mut args = argv.to_vec();
    if flag(&mut args, "-h") || flag(&mut args, "--help") {
        println!("{USAGE}");
        return 0;
    }
    let sub = args.first().cloned().unwrap_or_default();
    let r = match sub.as_str() {
        "init" => cmd_init(args[1..].to_vec()),
        "detect-url" => cmd_detect(args[1..].to_vec()),
        "check-url" | "preflight" => cmd_check(args[1..].to_vec()),
        "clear-cache" => cmd_clear(args[1..].to_vec()),
        "last" | "status" => cmd_last(args[1..].to_vec()),
        "skill" => {
            print!("{SKILL}");
            Ok(0)
        }
        "run" => cmd_run(args[1..].to_vec()),
        _ => cmd_run(args),
    };
    match r {
        Ok(c) => c,
        Err(e) => {
            eprintln!("error: {}", secrets::scrub(&e));
            2
        }
    }
}
