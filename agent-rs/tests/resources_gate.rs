//! The OOM guard: `agent resources` reports the room, `agent spawn` refuses a child that would not
//! fit, and the session keeps running (no crash, no OOM).

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("resgate-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

fn script(name: &str, steps: &[( &str, &str )]) -> String {
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

fn run(dir: &Path, yaml: &str, until: &str, envs: &[(&str, &str)]) -> Vec<Value> {
    write(&dir.join("run.yaml"), yaml);
    let mut cmd = Command::new(exe());
    cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(dir.join("traj.json")).arg("-c").arg(dir.join("run.yaml")).arg("-t").arg("orchestrate");
    cmd.env("MSWEA_SILENT_STARTUP", "1").env_remove("MINI_AGENT_SOCKET").env_remove("MINI_AGENT_PARENT_SOCKET").env_remove("MINI_AGENT_DEPTH");
    cmd.env("MINI_AGENT_MONITOR_MS", "50").current_dir(dir);
    for (k, v) in envs {
        cmd.env(k, v);
    }
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("run.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let journal = dir.join("traj.jsonl");
    let deadline = Instant::now() + Duration::from_secs(20);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            break;
        }
        let text = std::fs::read_to_string(&journal).unwrap_or_default();
        if text.contains(until) || Instant::now() > deadline {
            std::thread::sleep(Duration::from_millis(300));
            unsafe { libc::kill(child.id() as i32, libc::SIGTERM) };
            child.wait().unwrap();
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let text = std::fs::read_to_string(&journal).unwrap_or_default();
    let mut msgs = vec![];
    for l in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v["t"].as_str() {
            Some("meta") => msgs.clear(),
            Some("msg") => msgs.push(v["m"].clone()),
            _ => {}
        }
    }
    msgs
}

fn text(m: &Value) -> String {
    m["content"].as_str().map(String::from).unwrap_or_else(|| m["content"].to_string())
}

/// One subagent charged many GiB leaves room for a second but not a third.
#[test]
fn the_gate_refuses_what_does_not_fit_and_reports_the_room() {
    let dir = tmp("refuse");
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent resources --json"),
        ("submit", "first"),
    ]);
    // A reserve well above this box's free memory: the room has to read 0.
    let envs = vec![("MINI_AGENT_RESERVE_MEM_MB", "200000"), ("MINI_AGENT_MAX_SUBAGENTS", "100")];
    let msgs = run(&dir, &parent, "first", &envs);
    let all = msgs.iter().map(|m| text(m)).collect::<Vec<_>>().join("\n");
    let toolout = msgs.iter().find(|m| text(m).contains("max_fanout")).map(|m| text(m)).unwrap_or_default();
    // The whole tool output is one JSON object: find its `max_fanout` field.
    let json = toolout.lines().find(|l| l.trim_start().starts_with('{')).unwrap_or("{}");
    let v: Value = serde_json::from_str(json.trim()).unwrap_or(Value::Null);
    assert_eq!(v["reserve_mb"], 200000, "{toolout}");
    assert_eq!(v["max_fanout"], 0, "a reserve above the whole box leaves no room: {toolout}");
    assert_eq!(v["by_memory"], 0, "memory is what binds: {toolout}");
}

/// Two children whose average cost is high: a third is refused, the session lives on.
#[test]
fn a_refused_spawn_does_not_take_the_session_down() {
    let dir = tmp("aliverefuse");
    let parent = script("parent", &[
        // Free memory that looks tiny (a large reserve) plus a heavy average: both spawn calls are refused.
        ("run", "r1=$(mini-agent-rs agent spawn w1 'x' 2>&1); echo \"first: $r1\"; rc1=$?; r2=$(mini-agent-rs agent spawn w2 'x' 2>&1); echo \"second: $r2\"; echo rc=$?; mini-agent-rs agent resources"),
        ("submit", "still here"),
    ]);
    let child = script("child", &[("submit", "child done")]);
    write(&dir.join("child.yaml"), &child);
    let child_cfg = dir.join("child.yaml").display().to_string();
    let envs: Vec<(&str, &str)> = vec![
        ("MINI_AGENT_RESERVE_MEM_MB", "60000"),
        ("MINI_AGENT_CHILD_MEM_MB", "4000"),
        ("MINI_AGENT_MAX_SUBAGENTS", "100"),
        ("MINI_AGENT_CHILD_CONFIG", child_cfg.as_str()),
    ];
    // The parent is left alone with a very large reserve, so both spawns are refused.
    let msgs = run(&dir, &parent, "still here", &envs);
    let joined = msgs.iter().map(|m| text(m)).collect::<Vec<_>>().join("\n");
    assert!(joined.contains("refusing subagent"), "{joined}");
    assert!(joined.contains("still here"), "the session must survive a refused spawn: {joined}");
    // Nothing was started: no children directory besides the (empty) refusal's one.
    let index = std::fs::read_to_string(dir.join("subagents/index.json")).unwrap_or_default();
    assert!(index.is_empty(), "nothing should have been spawned: {index}");
}
