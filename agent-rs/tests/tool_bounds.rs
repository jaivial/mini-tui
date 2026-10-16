//! Tool budgets, end to end through the real binary: what a tool may hand the model is bounded,
//! and the model is told what it did not see.
//!
//! Two defects, both measured on the deployed binary before this change (A4, 2026-10-16, evidence
//! in `~/.hermes/qa-loop/evidencia/2026-10-16_A4/`):
//!
//! * `bash` was the only tool without a byte budget (read 50 KB, `code`/`codejs` 60 KB,
//!   `computer_use` 30 KB). `yes A4 | head -c 2000000` put all 2 000 045 bytes in one
//!   observation; at 20 MB the run cost 200 MB of RSS and a 41 MB trajectory. The collection is
//!   bounded *while reading* now, head + marker + tail.
//! * `read` enforced its 64 MB cap against `stat` only. A FIFO (size 0) delivered 190 MB into
//!   memory, and the same call on a FIFO with no writer never returned at all: killed by an
//!   external timeout after 10.3 s, with no observation for the model.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("tool-bounds-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// The scripted model: one action, then the submission (confirmed by a second plain reply, since
/// the fast path and the closure oracle are off in these runs). `action` is the action object as
/// JSON text, which is also valid YAML flow mapping --- the shape the other scripts use.
fn script(action: &str) -> String {
    format!(
        "agent:\n  system_template: s\n  instance_template: \"{{{{task}}}}\"\n  step_limit: 6\nmodel:\n  model_class: deterministic_toolcall\n  model_name: tool_bounds\n  cost_per_call: 0.0\n  outputs:\n    - {{role: assistant, content: \"running\", extra: {{actions: [{action}]}}}}\n    - {{role: assistant, content: \"done\", extra: {{submission: \"done\"}}}}\n    - {{role: assistant, content: \"done\", extra: {{submission: \"done\"}}}}\n"
    )
}

/// Run the real binary once and return the messages it recorded.
fn run(dir: &Path, cfg: &str, task: &str) -> Vec<Value> {
    let cfg_path = dir.join("cfg.yaml");
    std::fs::File::create(&cfg_path).unwrap().write_all(cfg.as_bytes()).unwrap();
    let out = dir.join("traj.json");
    let mut cmd = Command::new(exe());
    cmd.arg("-y")
        .arg("--exit-immediately")
        .arg("-o")
        .arg(&out)
        .arg("-c")
        .arg(&cfg_path)
        .arg("-t")
        .arg(task);
    cmd.env("MINITUI_AGENT_TOOLS", "1")
        .env("MSWEA_SILENT_STARTUP", "1")
        .env("MINI_AGENT_FASTPATH", "0")
        .env("MINI_AGENT_GOAL_ORACLE", "off");
    cmd.current_dir(dir);
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("err.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        if Instant::now() > deadline {
            unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
            let _ = child.wait();
            panic!("the run did not finish: a tool is blocking or unbounded");
        }
        std::thread::sleep(Duration::from_millis(25));
    }
    let doc: Value = serde_json::from_str(&std::fs::read_to_string(&out).unwrap_or_default()).unwrap_or(Value::Null);
    doc.get("messages").and_then(Value::as_array).cloned().unwrap_or_default()
}

fn text(m: &Value) -> String {
    m["content"].as_str().map(String::from).unwrap_or_else(|| m["content"].to_string())
}

/// The biggest observation the model was handed (the task prompt is not an observation).
fn biggest_observation(msgs: &[Value], task: &str) -> String {
    msgs.iter()
        .filter(|m| m["role"] == "user")
        .map(text)
        .filter(|t| t != task && !t.starts_with("[FORMAT ERROR]"))
        .max_by_key(|t| t.len())
        .unwrap_or_default()
}

#[test]
fn bash_output_over_the_budget_reaches_the_model_bounded_and_labelled() {
    let dir = tmp("bash-cap");
    let task = "count the lines";
    let msgs = run(&dir, &script(r#"{"command":"yes A4TEST-LINE-A4TEST-LINE | head -c 2000000"}"#), task);
    let obs = biggest_observation(&msgs, task);
    // 2 MB of real output, one line per row: without the budget this observation was 2 000 045
    // bytes (measured). Now it is the budget plus the marker.
    assert!(obs.len() <= 50 * 1024 + 2048, "observation is {} bytes", obs.len());
    assert!(obs.contains("bytes of output dropped"), "no marker: {}", &obs[..obs.len().min(400)]);
    assert!(obs.contains("tool budget is 50.0KB"), "{}", &obs[..obs.len().min(400)]);
    // Head and tail are real command output, not a hollow notice.
    assert!(obs.contains("A4TEST-LINE"), "{}", &obs[..obs.len().min(400)]);
    assert!(!obs.contains("[FORMAT ERROR]"));
}

#[test]
fn a_small_command_output_is_untouched() {
    let dir = tmp("bash-small");
    let task = "say hi";
    let msgs = run(&dir, &script(r#"{"command":"printf 'a4-small\\na4-small\\n'"}"#), task);
    let obs = biggest_observation(&msgs, task);
    assert!(obs.contains("a4-small\na4-small\n"), "{}", obs);
    assert!(!obs.contains("output dropped"), "a small output must not be labelled truncated: {obs}");
}

/// The boundary the ring is easy to get wrong: an output that fills the head half of the budget is
/// complete (head + tail), not a silent head-only slice, and it is not labelled as truncated.
#[test]
fn an_output_that_fills_half_the_budget_is_complete() {
    let dir = tmp("bash-boundary");
    let task = "fill the budget";
    // 60 000 bytes of 'a': over the 51 200-byte budget, so this one IS labelled...
    let cmd = r#"{"command":"head -c 60000 /dev/zero | tr '\\0' 'a'"}"#;
    let msgs = run(&dir, &script(cmd), task);
    let obs = biggest_observation(&msgs, task);
    assert!(obs.contains("output dropped"), "{}", &obs[..obs.len().min(200)]);
    // ...and 40 000 is under it: the whole thing, head and tail, with no marker.
    let cmd = r#"{"command":"head -c 40000 /dev/zero | tr '\\0' 'a'"}"#;
    let msgs = run(&dir, &script(cmd), task);
    let obs = biggest_observation(&msgs, task);
    assert!(obs.contains(&"a".repeat(40000)), "an output under the budget lost its tail: {} bytes", obs.len());
    assert!(!obs.contains("output dropped"), "{}", &obs[..obs.len().min(200)]);
}

#[test]
fn read_refuses_a_fifo_instead_of_reading_it_unbounded() {
    let dir = tmp("read-fifo");
    let fifo = dir.join("pipe");
    let c = std::ffi::CString::new(fifo.to_str().unwrap()).unwrap();
    assert_eq!(unsafe { libc::mkfifo(c.as_ptr(), 0o600) }, 0, "mkfifo failed");
    // No writer is ever opened: on a build without the `is_file` guard this call blocks inside
    // `open(2)` for ever (measured: the 2026-10-16 A/B run on origin/main hit this test's
    // deadline and reported "the run did not finish"), which is what the deadline below catches.
    let action = format!(r#"{{"tool":"read","args":{{"path":{}}}}}"#, serde_json::to_string(&fifo.display().to_string()).unwrap());
    let task = "read the pipe";
    let msgs = run(&dir, &script(&action), task);
    let obs = biggest_observation(&msgs, task);
    assert!(obs.contains("not a regular file"), "{}", obs);
    assert!(obs.contains("FIFO"), "{}", obs);
}
