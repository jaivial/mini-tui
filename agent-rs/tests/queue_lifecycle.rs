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
    fn spawn_runner(&self, run_dir: &Path) -> Child {
        let log = std::fs::File::create(run_dir.join("runner.out")).unwrap();
        Command::new(exe())
            .args([
                "queue",
                "run",
                "--owner",
                "test-lane",
                "--ttl",
                "600",
                "--limit",
                "1",
                "--db",
            ])
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
