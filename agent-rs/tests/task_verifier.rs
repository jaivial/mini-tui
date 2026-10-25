//! Queue-worker closure must be proven by the task's pre-existing deterministic checker.
//! No provider is called: the model is scripted, the checker and filesystem are real.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("task-verifier-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

fn verifier(dir: &Path, body: &str) {
    let path = dir.join("verify.sh");
    write(&path, &format!("#!/bin/sh\n{body}\n"));
    let mut permissions = std::fs::metadata(&path).unwrap().permissions();
    std::os::unix::fs::PermissionsExt::set_mode(&mut permissions, 0o755);
    std::fs::set_permissions(path, permissions).unwrap();
}

fn config(outputs: &str) -> String {
    format!(
        "agent:\n  system_template: s\n  instance_template: \"{{{{task}}}}\"\n  step_limit: 12\nmodel:\n  model_class: deterministic_toolcall\n  model_name: verifier-test\n  cost_per_call: 0.0\n  outputs:\n{outputs}"
    )
}

fn run(dir: &Path, outputs: &str, max_failures: usize) -> Value {
    run_with_modes(dir, outputs, max_failures, false, false, false)
}

fn run_with_options(dir: &Path, outputs: &str, max_failures: usize, fast_close: bool) -> Value {
    run_with_modes(dir, outputs, max_failures, fast_close, false, false)
}

fn run_with_eager(dir: &Path, outputs: &str, max_failures: usize) -> Value {
    run_with_modes(dir, outputs, max_failures, true, true, true)
}

fn run_with_modes(dir: &Path, outputs: &str, max_failures: usize, fast_close: bool, eager: bool, defaults: bool) -> Value {
    write(&dir.join("agent.yaml"), &config(outputs));
    let out = dir.join("traj.json");
    let mut cmd = Command::new(exe());
    cmd.arg("-y")
        .arg("--exit-immediately")
        .arg("-o")
        .arg(&out)
        .arg("-c")
        .arg(dir.join("agent.yaml"))
        .arg("-t")
        .arg("Create the required deliverable and prove it with the supplied checker.")
        .env("MINI_AGENT_TOOLSET", "worker")
        .env("MINI_AGENT_VERIFIER_FAST_CLOSE", if fast_close { "1" } else { "0" })
        .env("MINI_AGENT_VERIFIER_EAGER", if eager { "1" } else { "0" })
        .env("MINITUI_TASK_TITLE", "Fixture verification task")
        .env("MINI_AGENT_FASTPATH", "0")
        .env("MINI_AGENT_GOAL_ORACLE", "off")
        .env("MINI_AGENT_CACHE_WARMER", "off")
        .env("MINI_AGENT_ORCHESTRATOR", "0")
        .env("MINI_AGENT_TASK_VERIFIER_MAX_FAILURES", max_failures.to_string())
        .env("MINI_AGENT_RESERVE_MEM_MB", "64")
        .env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "");
    if defaults {
        cmd.env_remove("MINI_AGENT_VERIFIER_FAST_CLOSE");
        cmd.env_remove("MINI_AGENT_VERIFIER_EAGER");
    }
    cmd.current_dir(dir);
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("err.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let deadline = Instant::now() + Duration::from_secs(15);
    let status = loop {
        if let Ok(Some(status)) = child.try_wait() {
            break status;
        }
        if Instant::now() > deadline {
            unsafe { libc::kill(child.id() as i32, libc::SIGKILL) };
            let _ = child.wait();
            panic!("task verifier run did not finish");
        }
        std::thread::sleep(Duration::from_millis(25));
    };
    write(&dir.join("process.status"), &status.code().map(|c| c.to_string()).unwrap_or_else(|| "signal".into()));
    serde_json::from_str(&std::fs::read_to_string(out).unwrap()).unwrap()
}

fn statuses(doc: &Value, status: &str) -> Vec<Value> {
    doc.pointer("/info/task_verifier/attempts")
        .and_then(Value::as_array)
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(|v| v.get("status").and_then(Value::as_str) == Some(status))
        .collect()
}

#[test]
fn a_preexisting_passing_checker_closes_without_another_model_turn() {
    let dir = tmp("pass");
    verifier(&dir, "printf 'x\\n' >> verifier.calls\necho PASS");
    let doc = run(&dir, "    - {role: assistant, content: done, extra: {submission: done}}\n", 1);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("Submitted"));
    assert_eq!(std::fs::read_to_string(dir.join("process.status")).unwrap(), "0");
    assert_eq!(doc.pointer("/info/model_stats/api_calls").and_then(Value::as_u64), Some(1));
    assert_eq!(std::fs::read_to_string(dir.join("verifier.calls")).unwrap(), "x\n");
    assert_eq!(statuses(&doc, "passed").len(), 1);
}

#[test]
fn a_failed_checker_returns_to_the_worker_and_a_repair_can_close() {
    let dir = tmp("repair");
    verifier(&dir, "echo call >> verifier.calls\nif [ \"$(cat deliverable.txt 2>/dev/null)\" = fixed ]; then echo PASS; else echo 'deliverable is not fixed'; exit 1; fi");
    let outputs = concat!(
        "    - {role: assistant, content: premature, extra: {submission: premature}}\n",
        "    - {role: assistant, content: repair, extra: {actions: [{\"command\":\"printf fixed > deliverable.txt\"}]}}\n",
        "    - {role: assistant, content: fixed, extra: {submission: fixed}}\n"
    );
    let doc = run(&dir, outputs, 3);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("Submitted"));
    assert_eq!(doc.pointer("/info/submission").and_then(Value::as_str), Some("fixed"));
    assert_eq!(doc.pointer("/info/model_stats/api_calls").and_then(Value::as_u64), Some(3));
    assert_eq!(std::fs::read_to_string(dir.join("deliverable.txt")).unwrap(), "fixed");
    assert_eq!(std::fs::read_to_string(dir.join("verifier.calls")).unwrap().lines().count(), 2);
    assert_eq!(statuses(&doc, "rejected").len(), 1);
    assert_eq!(statuses(&doc, "passed").len(), 1);
    let text = doc["messages"].as_array().unwrap().iter().map(|m| m["content"].to_string()).collect::<Vec<_>>().join("\n");
    assert!(text.contains("Task verifier rejected closure"), "{text}");
    assert!(text.contains("deliverable is not fixed"), "{text}");
    assert!(!doc["messages"].as_array().unwrap().iter().any(|m| m["role"] == "exit" && m.pointer("/extra/submission").and_then(Value::as_str) == Some("premature")));
}

#[test]
fn a_passing_checker_can_close_without_the_final_model_turn() {
    let dir = tmp("fast-close");
    verifier(&dir, "if [ \"$(cat deliverable.txt 2>/dev/null)\" = fixed ]; then echo PASS; else exit 1; fi");
    let outputs = "    - {role: assistant, content: verify, extra: {actions: [{\"command\":\"printf fixed > deliverable.txt && ./verify.sh\"}]}}\n";
    let doc = run_with_options(&dir, outputs, 1, true);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("Submitted"));
    assert_eq!(doc.pointer("/info/model_stats/api_calls").and_then(Value::as_u64), Some(1));
    let submission = doc.pointer("/info/submission").and_then(Value::as_str).unwrap();
    assert!(submission.contains("Fixture verification task"), "{submission}");
    assert!(submission.contains("./verify.sh: PASS"), "{submission}");
    let passed = statuses(&doc, "passed");
    assert_eq!(passed.len(), 1);
    assert_eq!(passed[0]["fast_close"].as_bool(), Some(true));
}

#[test]
fn eager_verification_closes_before_the_model_writes_a_final_response() {
    let dir = tmp("eager-close");
    verifier(&dir, "if [ \"$(cat deliverable.txt 2>/dev/null)\" = fixed ]; then echo PASS; else exit 1; fi");
    // No ./verify.sh action and no final response: the harness itself verifies after the write.
    let outputs = "    - {role: assistant, content: write, extra: {actions: [{\"command\":\"printf fixed > deliverable.txt\"}]}}\n";
    let doc = run_with_eager(&dir, outputs, 1);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("Submitted"));
    assert_eq!(doc.pointer("/info/model_stats/api_calls").and_then(Value::as_u64), Some(1));
    let passed = statuses(&doc, "passed");
    assert_eq!(passed.len(), 1);
    assert_eq!(passed[0]["eager"].as_bool(), Some(true));
    assert!(doc.pointer("/info/submission").and_then(Value::as_str).unwrap().contains("./verify.sh: PASS"));
}

#[test]
fn a_zero_exit_with_fail_output_is_not_a_passing_verdict() {
    let dir = tmp("masked-failure");
    // The t4 fixture's real shape: a failing node process piped through tail exits zero.
    verifier(&dir, "echo 'FAIL parseDuration returned the wrong value'; exit 0");
    let outputs = concat!(
        "    - {role: assistant, content: check, extra: {actions: [{\"command\":\"./verify.sh\"}]}}\n",
        "    - {role: assistant, content: fake pass, extra: {submission: fake pass}}\n"
    );
    let doc = run_with_options(&dir, outputs, 1, true);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("TaskVerifierFailed"));
    assert_eq!(statuses(&doc, "passed").len(), 0);
    let rejected = statuses(&doc, "rejected");
    assert_eq!(rejected.len(), 1);
    assert!(rejected[0]["reason"].as_str().unwrap().contains("without a passing verdict"));
}

#[test]
fn partial_pass_text_does_not_hide_a_traceback() {
    let dir = tmp("partial-pass");
    verifier(&dir, "echo 'pricing tests PASS'; echo 'Traceback (most recent call last):'; echo 'AssertionError: broken behavior'; exit 0");
    let outputs = concat!(
        "    - {role: assistant, content: check, extra: {actions: [{\"command\":\"./verify.sh\"}]}}\n",
        "    - {role: assistant, content: fake pass, extra: {submission: fake pass}}\n"
    );
    let doc = run_with_options(&dir, outputs, 1, true);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("TaskVerifierFailed"));
    assert_eq!(statuses(&doc, "passed").len(), 0);
    assert_eq!(statuses(&doc, "rejected").len(), 1);
}

#[test]
fn replacing_the_checker_with_an_unconditional_pass_is_not_accepted() {
    let dir = tmp("tamper");
    verifier(&dir, "exit 1");
    let outputs = concat!(
        "    - {role: assistant, content: tamper, extra: {actions: [{\"command\":\"printf '#!/bin/sh\\nexit 0\\n' > verify.sh\"}]}}\n",
        "    - {role: assistant, content: fake pass, extra: {submission: fake pass}}\n"
    );
    let doc = run(&dir, outputs, 1);
    assert_eq!(doc.pointer("/info/exit_status").and_then(Value::as_str), Some("TaskVerifierFailed"));
    assert_ne!(std::fs::read_to_string(dir.join("process.status")).unwrap(), "0");
    assert_eq!(statuses(&doc, "passed").len(), 0);
    let rejected = statuses(&doc, "rejected");
    assert_eq!(rejected.len(), 1);
    assert!(rejected[0]["reason"].as_str().unwrap().contains("contents changed"));
}
