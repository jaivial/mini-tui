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
    /// `(child, lines)` for every task that declared its `files`: the shard sizes the wave is
    /// planned around. A wave costs MAX(shard), not SUM(shard).
    pub weights: Vec<(String, usize)>,
    /// `--join`: the session ends its turn now and the hub answers for it when the wave is over.
    pub join: bool,
}

/// The size of a shard, in lines of the files it owns (missing files count as 0: a new file).
/// Lines, not bytes or files, because the 2026-10-07 runs showed child time tracking the code
/// it had to read and rewrite: the 38-43 step child owned the most lines of the wave.
fn shard_lines(files: &[String], root: &std::path::Path) -> usize {
    files
        .iter()
        .map(|f| std::fs::read_to_string(root.join(f)).map(|t| t.lines().count()).unwrap_or(0))
        .sum()
}

/// A plan task's `lane`: the paths (dirs or files, relative to its cwd) it may WRITE. Its
/// `files` are in its lane too: a shard owns what it is sized by.
fn lane_of_task(t: &Value) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    for key in ["lane", "files"] {
        match t.get(key) {
            Some(Value::String(s)) => out.push(s.trim().to_string()),
            Some(Value::Array(a)) => out.extend(a.iter().filter_map(Value::as_str).map(|s| s.trim().to_string())),
            _ => {}
        }
    }
    out.retain(|s| !s.is_empty());
    out.dedup();
    out
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

fn s_of(v: &Value, k: &str) -> String {
    v.get(k).and_then(Value::as_str).unwrap_or("").to_string()
}

/// What a child is told about its lane. The lane is ENFORCED (the bash tool runs in a mount
/// namespace where everything else under the work tree is read-only), so this is not a request:
/// it saves the child the step of discovering it by hitting `Read-only file system`.
fn lane_preamble(lane: &[String]) -> String {
    format!(
        "## Your lane (enforced)\n\
         You may WRITE only: {}. Everything else in the work tree is READ-ONLY for you (writes fail\n\
         with `Read-only file system`); other children own it and are editing it right now. Read\n\
         other files only when your task needs a fact from them, and never wait for or re-check a\n\
         sibling's work: the contract in your task is the agreement, code to it.\n",
        lane.iter().map(|l| format!("`{l}`")).collect::<Vec<_>>().join(", ")
    )
}

/// The heading that hands the mechanical gate to the child that made the change.
///
/// `baseline` is the escape hatch that keeps the gate inside the child. A gate that CANNOT pass
/// (the repo does not build before you touched it, the toolchain is missing) sends the parent
/// back to proving it by hand, serially, after the wave -- which is exactly the cost this
/// command removes. With a baseline the child is told the truth about the gate instead:
/// compare against the untouched tree and report only what ITS OWN change added.
fn verify_preamble(cmd: &str, baseline: &str) -> String {
    if baseline.is_empty() {
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
    } else {
        format!(
            "## Done means: {cmd} must not get WORSE because of you\n\
             Run it:\n\
             \n   {cmd}\n\
             \n\
             It is KNOWN to fail on this repo before anybody changed anything:\n\
             \n   {baseline}\n\
             \n\
             So do NOT try to fix the pre-existing breakage and do NOT go shimming it in /tmp: that\n\
             is not your task and it is not your file. What you owe is proof that YOUR change did\n\
             not add to it. Run the command on the pristine tree (`git stash`, run it, `git stash\n\
             pop`), run it on your tree, and report the two outputs side by side. If yours adds a\n\
             NEW error, that one IS yours: fix it. If both fail the same way, say so in one line and\n\
             finish. The session that started you does NOT re-read your diff to check this, so your\n\
             comparison is the whole verification.\n"
        )
    }
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
    let verify_baseline = opts.get("verify_baseline").and_then(Value::as_str).unwrap_or("").trim().to_string();
    let cap = fanout(opts.get("max_concurrency").and_then(Value::as_u64).map(|n| n as usize));
    let model = opts.get("model_opt").and_then(Value::as_str).unwrap_or("").to_string();
    let default_fork_k = opts.get("fork_k").and_then(Value::as_i64).map(|n| n as usize);
    let root = std::path::PathBuf::from(opts.get("root").and_then(Value::as_str).unwrap_or("."));
    let join = opts.get("join").and_then(Value::as_bool).unwrap_or(false);

    let mut wave = Wave { join, ..Wave::default() };
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
            body = format!("{body}\n\n{}", verify_preamble(&verify_cmd, &verify_baseline));
        }
        // Where, and what "done" is, stated once. Measured 2026-10-07: a --no-fork child was never
        // told its work tree and opened with `find / -name menu.go`; others wrote JSDOM and
        // `_test.go` harnesses nobody asked for (13-20 of 30-36 steps) -- the gate is the proof.
        let cwd_txt = t.get("cwd").and_then(Value::as_str).map(String::from).unwrap_or_else(|| root.display().to_string());
        let body = format!(
            "## Where\nYour work tree is `{cwd_txt}` and your shell already starts there; paths in the task are relative to it.\n\n{body}\n\n## Scope\nDo exactly the change above, in your own files. Do not write tests, harnesses or scratch copies to check behaviour: {}. Then answer in a few lines: files changed and the contract you coded to.\n",
            if verify_cmd.is_empty() { "reading your diff once is enough" } else { "the gate command is the proof, and the session that started you re-runs it once for the whole wave" }
        );
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
        let lane = lane_of_task(t);
        if !lane.is_empty() {
            let cwd = t.get("cwd").and_then(Value::as_str).map(std::path::PathBuf::from).unwrap_or_else(|| root.clone());
            let files: Vec<String> = match t.get("files") {
                Some(Value::Array(a)) => a.iter().filter_map(Value::as_str).map(String::from).collect(),
                Some(Value::String(f)) => vec![f.clone()],
                _ => vec![],
            };
            if !files.is_empty() {
                wave.weights.push((id.clone(), shard_lines(&files, &cwd)));
            }
            r["lane"] = json!(lane);
            r["task"] = json!(format!("{}\n\n{}", s_of(&r, "task"), lane_preamble(&lane)));
        }
        if fork {
            r["fork"] = json!(true);
            r["fork_handover"] = json!(HANDOVER);
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
    // Balance: the wave ends when its LONGEST shard ends. Measured 2026-10-07: shards of
    // 0:55 / 0:49 / 1:56 / 2:06 -- three children sat idle for a minute behind the fourth.
    if wave.weights.len() >= 2 {
        let max = wave.weights.iter().map(|w| w.1).max().unwrap_or(0);
        let min = wave.weights.iter().map(|w| w.1).min().unwrap_or(0).max(1);
        if max as f64 > 1.5 * min as f64 {
            let heavy = wave.weights.iter().find(|w| w.1 == max).map(|w| w.0.clone()).unwrap_or_default();
            wave.warnings.push(format!(
                "unbalanced wave: the heaviest shard ({heavy}, {max} lines) is {:.1}x the lightest ({min} lines). The wave lasts as long as {heavy}: split it, or move files to the light shards.",
                max as f64 / min as f64
            ));
        }
        // Heaviest first: the long pole gets the earliest start.
        let order: Vec<String> = {
            let mut w = wave.weights.clone();
            w.sort_by(|a, b| b.1.cmp(&a.1));
            w.into_iter().map(|w| w.0).collect()
        };
        let rank = |s: &Value| order.iter().position(|n| Some(n.as_str()) == s["name"].as_str()).unwrap_or(usize::MAX);
        wave.spawns.sort_by_key(|s| rank(s));
    }
    if wave.discoverers.is_empty() && fork {
        wave.notes.push("no task is marked `discover`: the children start with no map of their repo and will read it themselves. That is the cost this command exists to avoid.".into());
    } else if !wave.discoverers.is_empty() {
        wave.notes.push(format!("discovery is IN the wave: {} writes the shared store while the others work ({}).", wave.discoverers.join(", "), if wave.repos.is_empty() { "no repo tags".into() } else { wave.repos.join(", ") }));
    }
    Ok(wave)
}

/// What a dispatched child is told about the conversation it inherited. See
/// `fork_messages_with`: the forked summary carries the parent's tool calls, and a child that
/// replays a `dispatch`+poll loop deadlocks on itself (`agent ls` always lists it as running).
/// Measured 2026-10-07: one child spent 9 steps and ~3 minutes on that loop and produced nothing.
pub const HANDOVER: &str = "**The conversation above is BACKGROUND, not a script.** The wave has\n\
     already been dispatched and the session that started you is waiting for it. You are ONE\n\
     child of that wave, with ONE job: the task stated below. Do not re-run `agent dispatch`, do\n\
     not re-read the repos to plan anything, and do not run a loop that waits for subagents\n\
     (`agent ls`, `agent wait`) -- `agent ls` lists YOU as running, so such a loop never ends.\n\
     Start from the task, do it, and answer.";

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
    if !wave.weights.is_empty() {
        let w: Vec<String> = wave.weights.iter().map(|(n, l)| format!("{n}={l}")).collect();
        out.push_str(&format!("  · shard sizes (lines): {}\n", w.join(" ")));
    }
    for n in &wave.notes {
        out.push_str(&format!("  · {n}\n"));
    }
    for w in &wave.warnings {
        out.push_str(&format!("  ! {w}\n"));
    }
    if wave.join {
        out.push_str("\n--join: this session's turn ENDS NOW. When the last child finishes, the hub runs the gate once and answers for this session with every child's result. Do not poll, do not verify: finish your turn.\n");
        return out;
    }
    out.push_str("\nNothing else to do while they run: do NOT explore the repos yourself and do NOT re-read their diffs (that is the serial cost this command removes). Each one reports when it finishes; read the report, read `agent result <name>`, and trust the `--verify` command it ran.\n");
    out
}
