//! The ContextStore end to end: a scripted orchestrator fills the store once, spawns children
//! that get their repo's slice without re-discovering, and the hub runs the handshake and the
//! contract check at the end of a child's turn. No model, no network.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ctxstore-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
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

fn messages(journal: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(journal).unwrap_or_default();
    let mut out = vec![];
    for l in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v["t"].as_str() {
            Some("meta") => out.clear(),
            Some("msg") => out.push(v["m"].clone()),
            _ => {}
        }
    }
    out
}

fn text(m: &Value) -> String {
    match m.get("content") {
        Some(Value::String(t)) => t.clone(),
        _ => m.get("content").map(|c| c.to_string()).unwrap_or_default(),
    }
}

fn run_parent(dir: &Path, parent_yaml: &str, child_yaml: &str, until: &str) -> Vec<Value> {
    write(&dir.join("parent.yaml"), parent_yaml);
    write(&dir.join("child.yaml"), child_yaml);
    let mut cmd = Command::new(exe());
    cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(dir.join("traj.json")).arg("-c").arg(dir.join("parent.yaml")).arg("-t").arg("orchestrate");
    cmd.env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_CHILD_CONFIG", dir.join("child.yaml"))
        .env("MINI_AGENT_MONITOR_MS", "50")
        .env_remove("MINI_AGENT_SOCKET")
        .env_remove("MINI_AGENT_PARENT_SOCKET")
        .env_remove("MINI_AGENT_DEPTH")
        .env_remove("MINI_AGENT_CONTEXT_DIR")
        .env_remove("MINI_AGENT_CONTEXT");
    cmd.current_dir(dir);
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("parent.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let journal = dir.join("traj.jsonl");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return messages(&journal);
        }
        if messages(&journal).iter().any(|m| text(m).contains(until)) || Instant::now() > deadline {
            std::thread::sleep(Duration::from_millis(300));
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let _ = child.wait();
            return messages(&journal);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn children_are_handed_the_shared_context_the_orchestrator_filled_once() {
    let dir = tmp("handover");
    write(&dir.join("findings.md"), "# backend\n`internal/api/group_menus_party_size.go:21 handleGetValidMenusForPartySize <- boRouter`\n\n# preact\n`src/lib/types.ts:506 GroupMenuDisplay <- Reservas.tsx`\n");
    write(&dir.join("contracts.md"), "- backend: emits `group_menu_display`\n- preact: consumes `group_menu_display`\n");
    write(&dir.join("backend-api.md"), "# callers of the handler\n`internal/api/server.go:650 handleToggle <- server`\n");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent state put findings.md --prompt-file findings.md && mini-agent-rs agent state put contracts.md --prompt-file contracts.md && mini-agent-rs agent state put surface.backend.md --prompt-file backend-api.md > out0.txt 2>&1; cat out0.txt"),
            // The backend child gets its slice: the backend surface doc and the backend contract
            // clause, and NOT the preact-only symbol.
            ("run", "mini-agent-rs agent spawn be-worker --cwd /tmp --repo backend 'edit the handler' && mini-agent-rs agent wait be-worker --timeout 20 > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    // The child answers with a handshake: what it touched, who calls it, what contract it emitted.
    let child = script(
        "child",
        &[(
            "submit",
            "Done.\nsurface: internal/api/server.go:650 handleToggle <- server\ncontract: group_menu_display -> preact GroupMenuDisplay\nsurprise: none",
        )],
    );
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("parent done"), "{all}");

    // 1. The child's own task carries the ContextStore slice.
    let child_msgs = messages(&dir.join("subagents/be-worker/traj.jsonl"));
    let task = child_msgs.iter().find(|m| m["role"] == "user").map(text).unwrap_or_default();
    assert!(task.contains("<context name=\"findings.md\">"), "{task}");
    assert!(task.contains("<context name=\"contracts.md\">"), "{task}");
    assert!(task.contains("<context name=\"surface.backend.md\">"), "{task}");
    // It is HANDED, not rediscovered: the spawn message says so.
    assert!(all.contains("handed") && all.contains("context doc"), "{all}");

    // 2. The handshake went back into the store as <child>.md.
    let hs = dir.join("context/be-worker.md");
    assert!(hs.is_file(), "the handshake was not stored: {}", dir.join("context").display());
    let hs_body = std::fs::read_to_string(&hs).unwrap();
    assert!(hs_body.contains("## surface") && hs_body.contains("handleToggle"), "{hs_body}");
    assert!(hs_body.contains("## contract") && hs_body.contains("group_menu_display"), "{hs_body}");
}

#[test]
fn contract_check_runs_at_the_end_of_a_child_turn() {
    let dir = tmp("contract-check");
    write(&dir.join("contracts.md"), "- backend: emits `group_menu_display` for preact\n");
    // A real repo the child "touches": the file does NOT carry the contract field, so the check fails.
    write(&dir.join("backend/handler.go"), "package main\nfunc handleToggle() {}\n");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent state put contracts.md --prompt-file contracts.md > /dev/null 2>&1; mini-agent-rs agent spawn be-worker --cwd backend --repo backend 'edit the handler' && mini-agent-rs agent wait be-worker --timeout 20 > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "Done.\nsurface: handler.go:2 handleToggle <- server\ncontract: none\nsurprise: none")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    // The check found the claim does not hold (handler.go lacks the contract field) and told the parent.
    assert!(all.contains("contract-check") && all.contains("FAIL"), "the failed contract check did not reach the parent:\n{all}");
}

#[test]
fn surface_answers_from_the_index_without_grepping() {
    let dir = tmp("surface");
    write(&dir.join("findings.md"), "# backend\n`internal/api/server.go:650 handleToggle <- server boRouter` [contract group_menu_display]\n");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent state put findings.md --prompt-file findings.md > /dev/null 2>&1; mini-agent-rs agent surface handleToggle > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "unused")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("handleToggle") && all.contains("internal/api/server.go:650"), "{all}");
    assert!(all.contains("called by") && all.contains("contract: group_menu_display"), "{all}");
}
