//! Strict fusion end to end with a scripted model (no network): the main model's shell action
//! and its script's write are refused and do nothing; the observations say why.

use serde_json::Value;
use std::path::PathBuf;
use std::process::Command;

#[test]
fn strict_fusion_refuses_main_model_writes_and_shell() {
    let dir = std::env::temp_dir().join(format!("fusion-e2e-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    std::fs::write(dir.join("p.yaml"), r#"agent:
  system_template: s
  instance_template: "{{task}}"
  step_limit: 10
model:
  model_class: deterministic_toolcall
  model_name: det
  cost_per_call: 0.0
  outputs:
    - {role: assistant, content: step, extra: {actions: [{tool: code, args: {code: "write(\"x.txt\", \"x\"); print(\"after\");"}, command: "code"}]}}
    - {role: assistant, content: step, extra: {actions: [{command: "touch y.txt"}]}}
    - {role: assistant, content: "done", extra: {submission: "done"}}
"#).unwrap();
    let status = Command::new(PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs")))
        .args(["-y", "--exit-immediately", "-o"]).arg(dir.join("t.json"))
        .arg("-c").arg(dir.join("p.yaml"))
        .args(["-t", "do the work"])
        .env("MINI_AGENT_GOAL_ORACLE", "off").env("MINITUI_AGENT_TOOLS", "1").env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_FUSION_MODELS", "fast=some/worker | test").env("MINI_AGENT_FUSION", "1")
        .env_remove("MINI_AGENT_DEPTH").env_remove("MINI_AGENT_CONFIG_DIR").env_remove("MINI_AGENT_SOCKET")
        .current_dir(&dir)
        .stdout(std::process::Stdio::null()).stderr(std::process::Stdio::null())
        .status().unwrap();
    assert!(status.success());
    assert!(!dir.join("x.txt").exists() && !dir.join("y.txt").exists());
    let traj: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("t.json")).unwrap()).unwrap();
    let all: Vec<String> = traj["messages"].as_array().unwrap().iter().map(|m| m["content"].to_string()).collect();
    assert!(all[0].contains("<fusion>"), "{}", all[0]);
    assert!(all.iter().any(|t| t.contains("1 write/edit/bash call(s) in this script were REFUSED")), "{all:?}");
    assert!(all.iter().any(|t| t.contains("Strict fusion: the main model does not run shell")), "{all:?}");
}
