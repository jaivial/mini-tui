//! The card's life, end to end, against the real CLI: create, claim, stop, resume.
//!
//! The worker is a scripted `deterministic_toolcall` model whose only action is a long `sleep`,
//! so the runner really has a live child process to stop -- which is exactly what `systemctl
//! start|stop|restart mini-queue-lane` (a deploy) does to it. No model, no network, no clock
//! guessing: the same run and the same kill on a scratch database.
//!
//! `queue` is behind the `task-graph` feature: run with
//! `cargo test --release --features task-graph --test queue_lifecycle`.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("queue-lifecycle-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

/// A worker config whose model call sleeps (`/sleep` is the scripted model's own primitive, so the
/// worker sits inside the call): it stays alive until the runner stops it.
fn slow_worker_config(dir: &Path) -> PathBuf {
    let cfg = dir.join("config");
    std::fs::create_dir_all(&cfg).unwrap();
    write(
        &cfg.join("mini.yaml"),
        "agent:\n  system_template: s\n  instance_template: \"{{task}}\"\n  step_limit: 40\nmodel:\n  model_class: deterministic_toolcall\n  model_name: slow-worker\n  cost_per_call: 0.0\n  outputs:\n    - {role: assistant, content: step, extra: {actions: [{command: \"/sleep 30\"}]}}\n    - {role: assistant, content: done}\n",
    );
    cfg
}

struct Cli {
    db: PathBuf,
    cfg: PathBuf,
}

impl Cli {
    fn run(&self, args: &[&str]) -> (i32, String, String) {
        let mut cmd = Command::new(exe());
        cmd.arg("queue")
            .args(args)
            .env("MINI_AGENT_CONFIG_DIR", &self.cfg)
            // The lease-expiry tests need to fast-forward time and bind a worker by hand; the
            // CLI refuses both unless this is set, so the hooks cannot be used by accident.
            .env("MINI_AGENT_QUEUE_TEST_HOOKS", "yes")
            .env_remove("MINI_AGENT_QUEUE_MODEL")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped());
        if !args.contains(&"--db") {
            cmd.arg("--db").arg(&self.db);
        }
        let out = cmd.output().unwrap();
        (
            out.status.code().unwrap_or(-1),
            String::from_utf8_lossy(&out.stdout).into_owned(),
            String::from_utf8_lossy(&out.stderr).into_owned(),
        )
    }
    fn ok(&self, args: &[&str]) -> Value {
        let (code, out, err) = self.run(args);
        assert_eq!(code, 0, "queue {args:?} failed: {err}");
        serde_json::from_str::<Value>(out.trim())
            .unwrap_or_else(|e| panic!("queue {args:?} did not print JSON ({e}): {out}"))
    }
    fn refuses(&self, args: &[&str]) {
        let (code, _, _) = self.run(args);
        assert_ne!(code, 0, "queue {args:?} was expected to be refused");
    }
    fn node(&self, id: &str) -> Value {
        let graph = self.ok(&["graph-read"]);
        graph["nodes"]
            .as_array()
            .unwrap()
            .iter()
            .find(|n| n["id"] == Value::String(id.into()))
            .unwrap_or_else(|| panic!("no card {id} in {graph}"))
            .clone()
    }
    fn put(&self, id: &str, project: &str, cwd: &Path, goal: &str) {
        let goal_file = self.db.parent().unwrap().join(format!("{id}.goal"));
        write(&goal_file, goal);
        self.ok(&[
            "put",
            "--id",
            id,
            "--project",
            project,
            "--cwd",
            cwd.to_str().unwrap(),
            "--goal-file",
            goal_file.to_str().unwrap(),
        ]);
    }
    /// Spawn the runner exactly like the lane unit does, with a scripted live worker.
    fn spawn_runner_with_ttl(&self, run_dir: &Path, ttl: &str) -> Child {
        let log = std::fs::File::create(run_dir.join("runner.out")).unwrap();
        Command::new(exe())
            .args(["queue", "run", "--owner", "test-lane", "--ttl", ttl, "--limit", "1", "--db"])
            .arg(&self.db)
            .arg("--run-dir")
            .arg(run_dir)
            .env("MINI_AGENT_CONFIG_DIR", &self.cfg)
            .env_remove("MINI_AGENT_QUEUE_MODEL")
            .stdin(Stdio::null())
            .stdout(Stdio::from(log.try_clone().unwrap()))
            .stderr(Stdio::from(log))
            .spawn()
            .unwrap()
    }
    fn spawn_runner(&self, run_dir: &Path) -> Child {
        self.spawn_runner_with_ttl(run_dir, "600")
    }
    /// Wait until `id` reaches `status`, or fail with what was seen instead.
    fn await_status(&self, id: &str, want: &str, within: Duration) -> Value {
        let deadline = Instant::now() + within;
        loop {
            let node = self.node(id);
            if node["status"] == Value::String(want.into()) {
                return node;
            }
            if Instant::now() > deadline {
                panic!("card {id} never reached {want}; stayed at {node}");
            }
            std::thread::sleep(Duration::from_millis(200));
        }
    }
    fn stop_runner(&self, mut runner: Child) {
        // SIGTERM, the signal systemd sends on `stop`/`restart`.
        unsafe { libc::kill(runner.id() as i32, libc::SIGTERM) };
        let deadline = Instant::now() + Duration::from_secs(20);
        loop {
            assert!(Instant::now() < deadline, "the runner did not exit after SIGTERM");
            if runner.try_wait().unwrap().is_some() {
                return;
            }
            std::thread::sleep(Duration::from_millis(100));
        }
    }
}

/// The regression this test exists for: stopping the runner (a deploy, a `systemctl restart`)
/// used to mark the in-flight card `blocked` with "queue worker cancelled" -- the work thrown
/// away, the card left open forever and only revivable by hand with `retry --reconciled yes`.
/// The runner killed and reaped that worker itself, so the honest transition is `pending`: the
/// lease is provably free and the next wave picks the card up again.
#[test]
#[cfg(feature = "task-graph")]
fn a_stopped_runner_hands_the_card_back_as_pending_instead_of_burning_it_as_blocked() {
    let dir = tmp("shutdown");
    let cwd = dir.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    let run_dir = dir.join("runs");
    std::fs::create_dir_all(&run_dir).unwrap();
    cli.put("t1", "p1", &cwd, "haz el trabajo");
    assert_eq!(cli.node("t1")["status"], Value::String("pending".into()));

    let runner = cli.spawn_runner(&run_dir);
    let running = cli.await_status("t1", "running", Duration::from_secs(30));
    assert_eq!(running["owner"], Value::String("test-lane".into()));
    assert_eq!(running["fence"], Value::from(1));
    // The child worker is alive inside its model call: this is a real worker being stopped, not a
    // state transition in the abstract.
    std::thread::sleep(Duration::from_millis(1500));
    let logs: Vec<_> = std::fs::read_dir(&run_dir)
        .unwrap()
        .filter_map(|e| e.ok())
        .filter(|e| e.path().extension().and_then(|x| x.to_str()) == Some("log"))
        .collect();
    assert_eq!(logs.len(), 1, "the runner should have started exactly one worker log");

    cli.stop_runner(runner);

    let after = cli.node("t1");
    assert_eq!(after["status"], Value::String("pending".into()), "card after SIGTERM: {after}");
    assert_eq!(after["owner"], Value::Null);
    assert_eq!(after["lease_until"], Value::Null);
    assert_eq!(after["result"], Value::Null, "the dead worker left no result behind: {after}");
    assert_eq!(after["fence"], Value::from(2), "the dead worker's fence is invalidated: {after}");

    let report = std::fs::read_to_string(run_dir.join("runner.out")).unwrap();
    assert!(
        report.contains("\"status\":\"pending\"") && !report.contains("\"blocked\""),
        "the runner must report the requeue, not a failure: {report}"
    );
    // The dead worker can no longer close the card...
    let result_file = dir.join("late-result.json");
    write(&result_file, "{\"task_id\":\"t1\"}");
    cli.refuses(&[
        "finish", "--id", "t1", "--owner", "test-lane", "--fence", "1", "--status", "blocked",
        "--result-file", result_file.to_str().unwrap(),
    ]);
    // ...and the work is not lost: the next wave claims it again.
    let claimed = cli.ok(&["claim", "--owner", "next-lane", "--ttl", "600", "--limit", "1"]);
    assert_eq!(claimed["claimed"][0]["id"], Value::String("t1".into()), "{claimed}");
    assert_eq!(claimed["claimed"][0]["fence"], Value::from(3));
    // One event per real transition, and no `blocked` anywhere in the card's life.
    let events = cli.ok(&["events-read", "--after", "0", "--limit", "100"]);
    let statuses: Vec<String> = events["events"]
        .as_array()
        .unwrap()
        .iter()
        .map(|e| e["status"].as_str().unwrap_or("").to_string())
        .collect();
    assert_eq!(statuses, vec!["pending", "running", "pending", "running"], "{events}");
}

/// A card that is `pending` again must not keep the previous outcome as its text, and cancelling
/// a card that has no worker must not tell the reader to reconcile one: production showed
/// `pending` cards carrying "cancel requested; reconcile any running worker before retry".
#[test]
#[cfg(feature = "task-graph")]
fn a_requeued_or_cancelled_card_does_not_keep_a_stale_result() {
    let dir = tmp("stale-result");
    let cwd = dir.join("project");
    let cwd2 = dir.join("project2");
    std::fs::create_dir_all(&cwd).unwrap();
    std::fs::create_dir_all(&cwd2).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    cli.put("t1", "p1", &cwd, "una tarea");
    cli.put("t2", "p2", &cwd2, "otra tarea");

    // t1: cancelled while running -> interrupted with the reconciliation note, then retried.
    let both = cli.ok(&["claim", "--owner", "o1", "--ttl", "600", "--limit", "2"]);
    let ids: Vec<&str> = both["claimed"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["t1", "t2"], "both cards claimed for the test: {both}");
    cli.ok(&["cancel", "--id", "t1", "--goal-version", "1"]);
    let interrupted = cli.node("t1");
    assert_eq!(interrupted["status"], Value::String("interrupted".into()));
    assert!(interrupted["result"].as_str().unwrap_or("").contains("reconcile"));
    cli.refuses(&["retry", "--id", "t1"]);
    cli.ok(&["retry", "--id", "t1", "--reconciled", "yes"]);
    let requeued = cli.node("t1");
    assert_eq!(requeued["status"], Value::String("pending".into()));
    assert_eq!(requeued["result"], Value::Null, "a pending card has no outcome yet: {requeued}");

    // t2 was claimed with t1 (it is running): cancelled now, the reconciliation note is right,
    // and once it is pending again no note survives.
    cli.ok(&["cancel", "--id", "t2", "--goal-version", "1"]);
    cli.ok(&["retry", "--id", "t2", "--reconciled", "yes"]);
    cli.ok(&["cancel", "--id", "t2", "--goal-version", "1"]);
    let cancelled = cli.node("t2");
    assert_eq!(cancelled["status"], Value::String("cancelled".into()));
    assert_eq!(cancelled["result"], Value::Null, "no worker ran, so no worker to reconcile: {cancelled}");
}

/// `release` is the runner's own path (see `execute_wave`): only the owner of a live lease can
/// hand it back, and the released card is claimable again by a new owner at a higher fence.
#[test]
#[cfg(feature = "task-graph")]
fn only_the_lease_owner_can_release_it_and_the_card_is_claimable_again() {
    let dir = tmp("release");
    let cwd = dir.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    cli.put("t1", "p1", &cwd, "una tarea");
    cli.ok(&["claim", "--owner", "o1", "--ttl", "600", "--limit", "1"]);

    cli.refuses(&["release", "--id", "t1", "--owner", "o2", "--fence", "1"]);
    cli.refuses(&["release", "--id", "t1", "--owner", "o1", "--fence", "7"]);
    assert_eq!(cli.node("t1")["status"], Value::String("running".into()));
    cli.ok(&["release", "--id", "t1", "--owner", "o1", "--fence", "1"]);

    let released = cli.node("t1");
    assert_eq!(released["status"], Value::String("pending".into()));
    assert_eq!(released["fence"], Value::from(2));
    let result_file = dir.join("r.json");
    write(&result_file, "{}");
    cli.refuses(&[
        "finish", "--id", "t1", "--owner", "o1", "--fence", "1", "--status", "blocked",
        "--result-file", result_file.to_str().unwrap(),
    ]);
    let again = cli.ok(&["claim", "--owner", "o2", "--ttl", "600", "--limit", "1"]);
    assert_eq!(again["claimed"][0]["fence"], Value::from(3), "{again}");
}

/// The regression this test exists for: an expired lease used to mark the card `interrupted`
/// unconditionally, and `interrupted` blocks its whole project and directory tree until a human
/// types `retry --reconciled yes`. So an OOM-killed runner (`MemoryMax=2G`), a `kill -9`, or a
/// reboot left the card stuck *with no worker alive at all* and nothing in the system able to
/// tell the difference. A lease whose worker is provably gone now requeues itself.
///
/// The control is in the same file: `a_live_worker_whose_lease_expires_is_not_relaunched` keeps
/// the `interrupted` freeze for the one case where relaunching WOULD give two writers to one
/// project. Both halves matter -- fixing only the first would trade a stuck card for a
/// double-write.
#[test]
#[cfg(feature = "task-graph")]
fn an_expired_lease_whose_worker_is_provably_gone_requeues_itself() {
    let dir = tmp("expired-gone");
    let cwd = dir.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    let run_dir = dir.join("runs");
    std::fs::create_dir_all(&run_dir).unwrap();
    cli.put("t1", "p1", &cwd, "trabajo lento");
    // A sibling card in the SAME project: if t1 stays frozen, this one can never be claimed.
    cli.put("t2", "p1", &cwd, "trabajo hermano");

    // The lease is the real minimum (30 s) and is allowed to expire on its own.
    let mut runner = cli.spawn_runner_with_ttl(&run_dir, "30");
    cli.await_status("t1", "running", Duration::from_secs(30));
    std::thread::sleep(Duration::from_millis(1500));
    // The worker is found through /proc rather than through the store, so this test does not
    // depend on the column this very change adds: against a build without the fix it fails
    // because of the freeze, not because of a missing field.
    let worker_pid = child_of(runner.id() as i64).expect("the runner spawned a worker");

    // The OOM-killer's signature: the whole cgroup disappears at once, so the worker does not
    // get to finish, release or report anything.
    unsafe { libc::kill(runner.id() as i32, libc::SIGKILL) };
    let _ = runner.wait();
    let worker_gone = {
        let deadline = Instant::now() + Duration::from_secs(10);
        loop {
            if !Path::new(&format!("/proc/{worker_pid}")).exists() { break true; }
            // The runner is gone, so the worker is reparented to init and nobody reaps it.
            unsafe { libc::kill(worker_pid as i32, libc::SIGKILL) };
            if Instant::now() > deadline { break false; }
            std::thread::sleep(Duration::from_millis(100));
        }
    };
    assert!(worker_gone, "the worker should be gone; the premise of this test is a dead one");

    // Wait out the real lease instead of fast-forwarding: this test uses no hook and no
    // shortcut, so the same file also demonstrates the bug against a build without the fix.
    // It costs one sleep and buys an honest A/B.
    std::thread::sleep(Duration::from_secs(32));
    let claimed = cli.ok(&["claim", "--owner", "next-lane", "--ttl", "600", "--limit", "2"]);
    let claimed_ids: Vec<&str> = claimed["claimed"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert!(claimed_ids.contains(&"t1"), "a provably dead worker must not need an operator: {claimed}");
    assert_eq!(cli.node("t1")["fence"], Value::from(3), "the dead worker's fence is invalidated");
    assert_eq!(cli.node("t1")["result"], Value::Null, "no stale outcome on a requeued card");

    // The freeze is really gone. `t1` was requeued (claimable, `pending`), so cancelling it is a
    // plain cancel; with the old code it was `interrupted` and would have demanded a
    // reconciliation instead, which is what left the sibling stuck behind a dead card.
    // The wave above took t1 again (fence 3). Hand that lease back the way a stopping runner
    // does, which leaves the card `pending` and the project unblocked.
    cli.ok(&["release", "--id", "t1", "--owner", "next-lane", "--fence", "3"]);
    let pending = cli.node("t1");
    assert_eq!(pending["status"], Value::String("pending".into()), "{pending}");
    cli.ok(&["cancel", "--id", "t1", "--goal-version", "1"]);
    assert_eq!(cli.node("t1")["status"], Value::String("cancelled".into()));
    let sibling = cli.ok(&["claim", "--owner", "next-lane", "--ttl", "600", "--limit", "2"]);
    let ids: Vec<&str> = sibling["claimed"].as_array().unwrap().iter().map(|c| c["id"].as_str().unwrap()).collect();
    assert_eq!(ids, vec!["t2"], "the dead card no longer freezes its project: {sibling}");

    // The lease names the process that holds it. Checked last on purpose: against a build
    // without the fix this test has already failed above, on the freeze itself.
    assert_eq!(
        cli.node("t1")["worker_pid"].as_i64(),
        Some(worker_pid),
        "the lease must name the process that holds it, so an expiry can be judged"
    );

    // And the requeue is an event an operator can see, not a silent state change.
    let events = cli.ok(&["events-read", "--after", "0", "--limit", "100"]);
    assert!(
        events["events"].as_array().unwrap().iter().any(|e| e["kind"] == "lease_expired_worker_gone"),
        "the automatic requeue must leave a trace: {events}"
    );
}

/// The other half, and the reason the first half is safe: when the worker is still ALIVE, an
/// expired lease must NOT relaunch. Two workers writing the same project is worse than a stuck
/// card. This is the case the old unconditional `interrupted` was right about.
#[test]
#[cfg(feature = "task-graph")]
fn a_live_worker_whose_lease_expires_is_not_relaunched() {
    let dir = tmp("expired-alive");
    let cwd = dir.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    let run_dir = dir.join("runs");
    std::fs::create_dir_all(&run_dir).unwrap();
    cli.put("t1", "p1", &cwd, "trabajo lento");

    // Claimed by a *live* process (this very test binary), which is the case a claim sweep must
    // never relaunch: the holder is demonstrably still running.
    let claimed = cli.ok(&["claim", "--owner", "live-lane", "--ttl", "600", "--limit", "1"]);
    assert_eq!(claimed["claimed"][0]["id"], Value::String("t1".into()));
    let me = std::process::id() as i64;
    let bound = cli.ok(&["bind-worker", "--id", "t1", "--owner", "live-lane", "--fence", "1", "--pid", &me.to_string()]);
    assert_eq!(bound["worker_pid"].as_i64(), Some(me), "the lease must name the holder's pid");

    // Expired means in the PAST: the sweep only fires on lease_until < now.
    let soon = crate_now() - 1;
    cli.ok(&["expire", "--id", "t1", "--at", &soon.to_string()]);
    let after = cli.ok(&["claim", "--owner", "next-lane", "--ttl", "600", "--limit", "2"]);
    assert_eq!(after["claimed"].as_array().unwrap().len(), 0, "a live worker must not be duplicated: {after}");
    let node = cli.node("t1");
    assert_eq!(node["status"], Value::String("interrupted".into()), "{node}");
    assert_eq!(node["fence"], Value::from(1), "the live worker's fence is untouched: {node}");
    // It still owns the lease, so it can still finish honestly.
    let result_file = dir.join("r.json");
    write(&result_file, "{}");
    cli.refuses(&["finish", "--id", "t1", "--owner", "someone-else", "--fence", "1",
        "--status", "blocked", "--result-file", result_file.to_str().unwrap()]);
    // And an unknown worker (no identity recorded, e.g. a card claimed by an older binary) is
    // also left for the operator: nothing can be proven, so nothing is relaunched.
    cli.ok(&["retry", "--id", "t1", "--reconciled", "yes"]);
    cli.ok(&["claim", "--owner", "o3", "--ttl", "600", "--limit", "1"]);
    // retry bumps the fence once and this claim once more, so the card runs at fence 3.
    let fence = cli.node("t1")["fence"].as_i64().unwrap();
    cli.ok(&["bind-worker", "--id", "t1", "--owner", "o3", "--fence", &fence.to_string()]);
    cli.ok(&["unbind-worker", "--id", "t1"]);
    // Expired means in the PAST: the sweep only fires on lease_until < now.
    let soon = crate_now() - 1;
    cli.ok(&["expire", "--id", "t1", "--at", &soon.to_string()]);
    let after = cli.ok(&["claim", "--owner", "o4", "--ttl", "600", "--limit", "1"]);
    assert_eq!(after["claimed"].as_array().unwrap().len(), 0, "unknown worker: no relaunch: {after}");
    assert_eq!(cli.node("t1")["status"], Value::String("interrupted".into()));
}

/// A recycled pid is not the worker: the number came back around to an unrelated process after
/// the card was claimed, which is precisely the case where "the pid exists" proves nothing.
#[test]
#[cfg(feature = "task-graph")]
fn a_recycled_pid_is_not_mistaken_for_the_worker() {
    let dir = tmp("expired-recycled");
    let cwd = dir.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    cli.put("t1", "p1", &cwd, "trabajo");
    cli.ok(&["claim", "--owner", "lane", "--ttl", "600", "--limit", "1"]);
    // Bind to this process (alive), then rewrite the recorded start time to a different one:
    // same pid, different process. The pid is alive and the card must still be requeued.
    cli.ok(&["bind-worker", "--id", "t1", "--owner", "lane", "--fence", "1"]);
    let mine = std::fs::read_to_string("/proc/self/stat").unwrap();
    let ticks: i64 = mine.rsplit_once(')').unwrap().1.split_whitespace().nth(19).unwrap().parse().unwrap();
    cli.ok(&["set-worker-start", "--id", "t1", "--start", &(ticks + 1).to_string()]);
    // Expired means in the PAST: the sweep only fires on lease_until < now.
    let soon = crate_now() - 1;
    cli.ok(&["expire", "--id", "t1", "--at", &soon.to_string()]);
    let after = cli.ok(&["claim", "--owner", "o2", "--ttl", "600", "--limit", "1"]);
    assert_eq!(after["claimed"][0]["id"], Value::String("t1".into()),
        "a recycled pid must not freeze the card: {after}");
}

/// The lease TTL is what decides this, not wall-clock guessing: `release` already proved a
/// runner that stops cleanly requeues its card. This checks the sweep agrees with it instead of
/// leaving two different answers for the same situation.
#[test]
#[cfg(feature = "task-graph")]
fn the_expired_lease_sweep_does_not_touch_a_live_lease() {
    let dir = tmp("expired-live");
    let cwd = dir.join("project");
    std::fs::create_dir_all(&cwd).unwrap();
    let cli = Cli { db: dir.join("queue.sqlite"), cfg: slow_worker_config(&dir) };
    cli.put("t1", "p1", &cwd, "trabajo");
    cli.ok(&["claim", "--owner", "lane", "--ttl", "600", "--limit", "1"]);
    // Expire the lease of a DIFFERENT card: the sweep must leave t1 alone.
    let cwd2 = dir.join("project2");
    std::fs::create_dir_all(&cwd2).unwrap();
    cli.put("t2", "p2", &cwd2, "otro trabajo");
    cli.ok(&["claim", "--owner", "lane2", "--ttl", "600", "--limit", "1"]);
    // Expired means in the PAST: the sweep only fires on lease_until < now.
    let soon = crate_now() - 1;
    cli.ok(&["expire", "--id", "t2", "--at", &soon.to_string()]);
    let _ = cli.ok(&["claim", "--owner", "o3", "--ttl", "600", "--limit", "4"]);
    assert_eq!(cli.node("t1")["status"], Value::String("running".into()),
        "a card whose lease has NOT expired is untouched by another card's expiry");
}

/// The pid of a direct child of `parent`, read from /proc. Parsed after the LAST `)` because the
/// comm field (2) may itself contain spaces and parentheses.
fn child_of(parent: i64) -> Option<i64> {
    let entries = std::fs::read_dir("/proc").ok()?;
    for entry in entries.flatten() {
        // `/proc` also holds entries that are not pids (`self`, `net`, ...); skip them instead of
        // giving up, or the scan stops before it reaches the process it is looking for.
        let Ok(pid) = entry.file_name().to_str().unwrap_or("").parse::<i64>() else { continue };
        let Ok(stat) = std::fs::read_to_string(entry.path().join("stat")) else { continue };
        let Some(ppid) = stat.rsplit_once(')').and_then(|(_, r)| r.split_whitespace().nth(1)).and_then(|v| v.parse::<i64>().ok()) else { continue };
        if ppid == parent { return Some(pid); }
    }
    None
}

fn crate_now() -> i64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap()
        .as_secs() as i64
}
