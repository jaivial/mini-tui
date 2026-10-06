//! Cold-start metrics end to end: a scripted run (no model, no network) leaves a journal, and
//! `mini-agent-rs metrics` splits it into discovery and work.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("metrics-e2e-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

fn script(name: &str, steps: &[(&str, &str)]) -> String {
    let mut out = format!(
        "agent:\n  system_template: s\n  instance_template: \"{{{{task}}}}\"\n  step_limit: 40\nmodel:\n  model_class: deterministic_toolcall\n  model_name: {name}\n  cost_per_call: 0.01\n  outputs:\n"
    );
    for (kind, text) in steps {
        let text = serde_json::to_string(text).unwrap();
        if *kind == "run" {
            out.push_str(&format!("    - {{role: assistant, content: step, extra: {{actions: [{{command: {text}}}]}}}}\n"));
        } else {
            out.push_str(&format!("    - {{role: assistant, content: {text}, extra: {{submission: {text}}}}}\n"));
        }
    }
    out
}

#[test]
fn metrics_measure_a_real_run() {
    let dir = tmp("run");
    write(&dir.join("parent.yaml"), &script("metrics-parent", &[
        ("run", "ls"),
        ("run", "grep -rn spawn ."),
        ("run", "cargo build"),
        ("submit", "done"),
    ]));
    let status = Command::new(exe())
        .arg("-y").arg("--exit-immediately")
        .arg("-o").arg(dir.join("traj.json"))
        .arg("-c").arg(dir.join("parent.yaml"))
        .arg("-t").arg("measure me")
        .env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env_remove("MINI_AGENT_SOCKET").env_remove("MINI_AGENT_PARENT_SOCKET").env_remove("MINI_AGENT_DEPTH")
        .current_dir(&dir)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .status().unwrap();
    assert!(status.success());
    let out = Command::new(exe())
        .arg("metrics").arg(dir.join("traj.jsonl")).arg("--json")
        .output().unwrap();
    assert!(out.status.success(), "{}", String::from_utf8_lossy(&out.stderr));
    let v: Value = serde_json::from_slice(&out.stdout).unwrap();
    // 4 assistant steps: 2 discovery, `cargo build` plus the final answer as work.
    assert_eq!(v["steps"].as_i64().unwrap(), 4);
    assert_eq!(v["discovery_steps"].as_i64().unwrap(), 2, "{v}");
    assert_eq!(v["work_steps"].as_i64().unwrap(), 2);
    assert!(v["discovery_tokens"].as_i64().unwrap() > 0);
    assert!(v["task_tokens"].as_i64().unwrap() > 0);
    assert!(v["brief_tokens_estimate"].as_i64().unwrap() < v["discovery_tokens"].as_i64().unwrap());
    // The human report works too.
    let out = Command::new(exe()).arg("metrics").arg(dir.join("traj.jsonl")).output().unwrap();
    assert!(out.status.success());
    assert!(String::from_utf8_lossy(&out.stdout).contains("cold-start metrics"));
}
