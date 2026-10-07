//! `agent dispatch`: one step, one wave, no serial exploration phase.
//!
//! The measured 2026-10-07 baseline says a split run costs 2.1x the wall-clock and 2.1x the
//! tokens of one single agent on a 6-file change, and the five phases that cannot overlap are:
//!
//!   P1 the orchestrator explores the repos alone, before any child exists
//!   P2 it writes findings/contracts/decisions/surface by hand, from what it read
//!   P3 it spends one agent step per `spawn`
//!   P4 the children run (the only parallel phase)
//!   P5 it re-reads every diff to verify
//!
//! A single agent pays none of P1, P2, P3 and P5: it reads and edits in the same context, so
//! every read it does is immediately worth something. `dispatch` deletes the phases instead of
//! moving them:
//!
//!   * **the wave is one step.** One `agent dispatch` launches N children, so P3 is one model
//!     turn no matter how many children there are.
//!   * **discovery is a job, not a prerequisite.** `--discover` marks the children whose task
//!     starts with mapping their repo and writing `surface.<repo>.md` + `findings.md` into the
//!     shared store. They do it concurrently, each scoped to its own repo, so P1 and P2 run
//!     INSIDE the parallel phase instead of before it.
//!   * **`--fork` by default.** A child continues this session's compacted conversation instead
//!     of starting cold: it already knows the task, so its first step is work, not re-orienting.
//!   * **`--verify` hands the mechanical gate to the child.** The commands that prove the change
//!     compiles (build, tsc, go vet) run in the child that made it, inside the parallel phase,
//!     so P5 is not the orchestrator re-reading diffs afterwards.
//!   * **`--max-concurrency` caps the wave.** Eight children against a provider that answers 429
//!     loses more wall-clock to retries than it saves; the cap bounds that.
//!
//! The plan is written from the task, BEFORE reading anything: that is the whole trick. A plan
//! that needs exploration to write is a plan that has already paid P1.

use serde_json::{json, Value};
use std::collections::BTreeSet;

/// Default children at once when the caller does not cap it (`MINI_AGENT_DISPATCH_FANOUT`).
pub const DEFAULT_FANOUT: usize = 8;
/// Hard ceiling on a dispatch wave, whatever the env or the flag says: past this the provider,
/// not the machine, is the limit.
pub const MAX_FANOUT: usize = 10;

/// The outcome of building the wave, before anything is launched. The parent's step prints this
/// and stops: the children report themselves as they finish.
#[derive(Debug, Default, Clone)]
pub struct Wave {
    /// `agent spawn` requests, in launch order, ready for `Hub::launch`.
    pub spawns: Vec<Value>,
    /// Names of the children that map their repo and write the shared store.
    pub discoverers: Vec<String>,
    /// Repos the wave covers, in first-seen order.
    pub repos: Vec<String>,
    /// One line per decision the parent made, printed with the result.
    pub notes: Vec<String>,
    /// Anything the wave will not do, and why (capped children, empty plan...).
    pub warnings: Vec<String>,
}

/// The wave size: the flag, else the env, else the default, always clamped to [`MAX_FANOUT`].
pub fn fanout(flag: Option<usize>) -> usize {
    let raw = flag
        .or_else(|| std::env::var("MINI_AGENT_DISPATCH_FANOUT").ok().and_then(|v| v.parse().ok()))
        .unwrap_or(DEFAULT_FANOUT);
    raw.clamp(1, MAX_FANOUT)
}

/// The repo a task belongs to, from the plan's own fields. A task may say `repo`, `repos` or
/// `group`; `group` is the DAG's word for "tasks that share files", which is the same axis.
fn repos_of_task(t: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    fn add(out: &mut Vec<String>, v: &str) {
        let v = v.trim();
        if !v.is_empty() && !out.iter().any(|x| x == v) {
            out.push(v.to_string());
        }
    }
    if let Some(r) = t.get("repo").and_then(Value::as_str) {
        add(&mut out, r);
    }
    if let Some(rs) = t.get("repos").and_then(Value::as_array) {
        for r in rs.iter().filter_map(Value::as_str) {
            add(&mut out, r);
        }
    }
    if out.is_empty() {
        if let Some(g) = t.get("group").and_then(Value::as_str) {
            add(&mut out, g);
        }
    }
    out
}

/// The heading that tells a mapping child what to write, so every discovery lands in the same
/// place the readers look. It names the keys the store reserves, because `agent surface` and
/// `contract-check` read those and nothing else.
fn discover_preamble(repo: &str) -> String {
    let surface = format!(
        "{}{repo}{}",
        crate::context_store::SURFACE_PREFIX,
        crate::context_store::SURFACE_SUFFIX
    );
    format!(
        "## Your job in this wave: map `{repo}`, do not edit yet\n\
         You are the discovery child for `{repo}`. Nobody has read this repo in this run, and the\n\
         children that work in it are starting NOW in parallel with you. What they get is what you\n\
         write in the next few steps, so write it ONCE, for them, mechanically.\n\
         \n\
         1. List the files of `{repo}` that matter (entry points, the payload types, the HTTP/CLI\n\
            surface) and, for each, the SYMBOLS other code calls. Real paths, real names, `file:line`.\n\
         2. Write that map into the shared store so the other children read it instead of searching:\n\
            \n   mini-agent-rs agent state put {surface} --prompt-file /tmp/surface.md\n\
            (a plain list, one line per symbol: `path:line symbol -> callers`). Keep it under 100 lines:\n\
            it is handed to every later child, so length is paid for by all of them.\n\
         3. If `{repo}` publishes or consumes something another repo reads, write that one fact to\n\
            \n   mini-agent-rs agent state put contracts.md --prompt-file /tmp/c.md\n\
            as a single line naming the PRODUCER and the CONSUMER (the wire field, its exact name and\n\
            spelling on both sides). Only write facts you actually read in the code.\n\
         4. Then STOP, with a summary of what you mapped. Do not edit any file: editing is another\n\
            child's job and two children must never own the same file.\n"
    )
}

/// The heading that hands the mechanical gate to the child that made the change.
fn verify_preamble(cmd: &str) -> String {
    format!(
        "## Done means these pass, run them yourself\n\
         Before you answer, run:\n\
         \n   {cmd}\n\
         \n\
         A child that reports `done` without that command passing has not finished: fix what it\n\
         catches and re-run it until it is clean. This is why you were handed the command: the\n\
         session that started you does NOT re-read your diff to check it, so this output is the\n\
         proof that the change compiles.\n"
    )
}

/// One child of the wave: its name, the task, the repos, and the flags the parent chose.
pub struct Job<'a> {
    pub id: &'a str,
    pub title: &'a str,
    pub task: &'a str,
    pub repos: Vec<String>,
    pub cwd: Option<&'a str>,
    pub discover: bool,
    pub fork: bool,
    pub deps: Vec<String>,
}

/// Build the wave from a plan. Returns the wave and, in `Wave::warnings`, everything it refused
/// to do. Never launches anything: the parent reviews this in one look and one step.
///
/// The plan is a `plan.json` (the same shape `plan submit` takes): `{"tasks": [ ... ]}`, each task
/// an object with `id` (the child's name), `task` (what it does) and optionally `repo`/`repos`,
/// `cwd`, `deps`, `budget`, `title`, `discover`.
pub fn build(plan: &Value, opts: &Value) -> Result<Wave, String> {
    let tasks = plan
        .get("tasks")
        .and_then(Value::as_array)
        .ok_or("dispatch --file needs a plan: {\"tasks\": [{\"id\": \"backend\", \"task\": \"...\"}]}")?;
    if tasks.is_empty() {
        return Err("the plan has no tasks: nothing to dispatch".into());
    }
    let fork = opts.get("fork").and_then(Value::as_bool).unwrap_or(true);
    let verify_cmd = opts.get("verify").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let cap = fanout(opts.get("max_concurrency").and_then(Value::as_u64).map(|n| n as usize));
    let model = opts.get("model_opt").and_then(Value::as_str).unwrap_or("").to_string();
    let default_fork_k = opts.get("fork_k").and_then(Value::as_i64).map(|n| n as usize);

    let mut wave = Wave::default();
    let mut seen: BTreeSet<String> = BTreeSet::new();
    let mut total = tasks.len();
    // Only the tasks of the FIRST wave are launched here: a task with deps waits for its
    // predecessor's handshake, which does not exist yet. Dispatching them now would start them
    // cold and hand them a store with nothing in it -- exactly the waste this command removes.
    let mut queue: Vec<&Value> = vec![];
    let mut deferred: Vec<String> = vec![];
    let known: BTreeSet<String> = tasks.iter().filter_map(|t| t.get("id").and_then(Value::as_str)).map(String::from).collect();
    for t in tasks {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("").to_string();
        let deps: Vec<String> = t.get("deps").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default();
        // A dep inside this plan that is NOT being dispatched now means this task must wait.
        let waits_on_this_plan = deps.iter().any(|d| known.contains(d));
        if waits_on_this_plan {
            deferred.push(format!("{id} (depends on {})", deps.join(", ")));
            continue;
        }
        queue.push(t);
    }
    for t in &queue {
        let id = t.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if id.is_empty() {
            return Err("every dispatch task needs an `id`: it becomes the subagent's name".into());
        }
        if !crate::subagents::valid_name(&id) {
            return Err(format!("task id {id:?}: letters, digits, '.', '_' or '-' (it is a subagent name)"));
        }
        if !seen.insert(id.clone()) {
            return Err(format!("two tasks share the id {id:?}: names must be unique"));
        }
        let task = t.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if task.is_empty() {
            return Err(format!("task {id}: empty task"));
        }
        let repos = repos_of_task(t);
        for r in &repos {
            if !wave.repos.contains(r) {
                wave.repos.push(r.clone());
            }
        }
        let discover = t.get("discover").and_then(Value::as_bool).unwrap_or(false);
        let mut body = task.clone();
        if discover {
            let repo = repos.first().cloned().unwrap_or_else(|| id.clone());
            body = format!("{}\n## The task itself\n{task}", discover_preamble(&repo));
            wave.discoverers.push(id.clone());
        }
        if !verify_cmd.is_empty() && !discover {
            body = format!("{body}\n\n{}", verify_preamble(&verify_cmd));
        }
        let mut r = json!({"cmd": "spawn", "name": id, "task": body, "force": true});
        if !repos.is_empty() {
            r["repos"] = json!(repos);
        }
        if let Some(c) = t.get("cwd").and_then(Value::as_str) {
            r["cwd"] = json!(c);
        }
        if let Some(b) = t.get("budget") {
            r["budget"] = b.clone();
        }
        if fork {
            r["fork"] = json!(true);
            if let Some(k) = default_fork_k {
                r["fork_k"] = json!(k as i64);
            }
        }
        if !model.is_empty() {
            r["model"] = json!(model);
        }
        wave.spawns.push(r);
    }
    if queue.len() > cap {
        let dropped = &queue[cap..].iter().filter_map(|t| t.get("id").and_then(Value::as_str)).collect::<Vec<_>>().join(", ");
        wave.warnings.push(format!("{total} tasks, cap {cap} (`--max-concurrency`, max {MAX_FANOUT}): {dropped} NOT started this wave. Re-dispatch them when room frees."));
    }
    if !deferred.is_empty() {
        wave.warnings.push(format!("waiting on a task in this plan (launch them with `agent dispatch` once their predecessor's handshake is in the store): {}", deferred.join("; ")));
    }
    if wave.discoverers.is_empty() && fork {
        wave.notes.push("no task is marked `discover`: the children start with no map of their repo and will read it themselves. That is the cost this command exists to avoid.".into());
    } else if !wave.discoverers.is_empty() {
        wave.notes.push(format!("discovery is IN the wave: {} writes the shared store while the others work ({}).", wave.discoverers.join(", "), if wave.repos.is_empty() { "no repo tags".into() } else { wave.repos.join(", ") }));
    }
    Ok(wave)
}

/// A stable fingerprint of a wave's identity: the plan file it came from and the names it starts.
/// Two dispatches with the same fingerprint are the same dispatch, and the second one is the bug
/// that costs a wave its progress: `launch` force-replaces a live child (killing its process), so
/// re-running the plan restarts every child from zero. Measured on 2026-10-07: an orchestrator
/// that ran `agent dispatch` three times burned three waves of wall-clock and finished slower than
/// the single agent it was trying to beat.
pub fn fingerprint(plan_name: &str, wave: &Wave) -> String {
    let mut names: Vec<&str> = wave.spawns.iter().map(|s| s["name"].as_str().unwrap_or("?")).collect();
    names.sort_unstable();
    format!("{plan_name}#{}", names.join(","))
}

/// What `dispatch` already started in this run, newest first, as `(fingerprint, child names)`.
pub fn load_runs(dir: &std::path::Path) -> Vec<(String, Vec<String>)> {
    let path = dir.join("dispatched.json");
    let Ok(text) = std::fs::read_to_string(path) else { return vec![] };
    let Ok(v) = serde_json::from_str::<Value>(&text) else { return vec![] };
    v.get("runs")
        .and_then(Value::as_array)
        .map(|a| {
            a.iter()
                .filter_map(|e| {
                    let fp = e.get("id")?.as_str()?.to_string();
                    let names: Vec<String> = e.get("names")?.as_array()?.iter().filter_map(|n| n.as_str().map(String::from)).collect();
                    Some((fp, names))
                })
                .collect()
        })
        .unwrap_or_default()
}

/// Append this dispatch to the run's history (one small file, atomically replaced).
pub fn record_run(dir: &std::path::Path, fp: &str, names: &[String]) {
    let path = dir.join("dispatched.json");
    let mut runs = load_runs(dir);
    runs.retain(|(id, _)| id != fp);
    runs.insert(0, (fp.to_string(), names.to_vec()));
    runs.truncate(20);
    let v = json!({ "runs": runs.iter().map(|(id, n)| json!({"id": id, "names": n})).collect::<Vec<_>>() });
    let tmp = dir.join(".dispatched.json.tmp");
    if std::fs::write(&tmp, serde_json::to_string_pretty(&v).unwrap_or_default()).is_ok() {
        let _ = std::fs::rename(&tmp, &path);
    }
}

/// The text the parent's step prints: what started, in one look, without a second `agent` step.
pub fn report(wave: &Wave) -> String {
    let mut out = String::new();
    out.push_str(&format!("dispatch: {} subagent(s) started in ONE step.\n", wave.spawns.len()));
    let mut lines: Vec<String> = vec![];
    for s in &wave.spawns {
        let name = s["name"].as_str().unwrap_or("?");
        let mut flags: Vec<String> = vec![];
        if s.get("fork").and_then(Value::as_bool).unwrap_or(false) {
            flags.push("forked (no cold start)".into());
        }
        if let Some(rs) = s.get("repos").and_then(Value::as_array) {
            let list: Vec<&str> = rs.iter().filter_map(Value::as_str).collect();
            if !list.is_empty() {
                flags.push(format!("repo {}", list.join(",")));
            }
        }
        let flag_note = if flags.is_empty() { String::new() } else { format!(" · {}", flags.join(" · ")) };
        lines.push(format!("  {name}{flag_note}"));
    }
    for l in lines {
        out.push_str(&l);
        out.push('\n');
    }
    for n in &wave.notes {
        out.push_str(&format!("  · {n}\n"));
    }
    for w in &wave.warnings {
        out.push_str(&format!("  ! {w}\n"));
    }
    out.push_str("\nNothing else to do while they run: do NOT explore the repos yourself and do NOT re-read their diffs (that is the serial cost this command removes). Each one reports when it finishes; read the report, read `agent result <name>`, and trust the `--verify` command it ran.\n");
    out
}
