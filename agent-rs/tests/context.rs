//! Context inheritance end to end: a scripted parent hands its children context files, a
//! structured brief and the shared state on disk; scripted children answer. No model, no network.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("context-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent).unwrap();
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
        let v: Value = serde_json::from_str(l).unwrap();
        match v["t"].as_str() {
            Some("meta") => out.clear(),
            Some("msg") => out.push(v["m"].clone()),
            _ => {}
        }
    }
    out
}

fn text(m: &Value) -> String {
    m["content"].as_str().map(String::from).unwrap_or_else(|| m["content"].to_string())
}

/// Run the parent until its journal holds `until`, then stop it like the UI does.
fn run_parent(dir: &Path, parent_yaml: &str, child_yaml: &str, until: &str) -> Vec<Value> {
    write(&dir.join("parent.yaml"), parent_yaml);
    write(&dir.join("child.yaml"), child_yaml);
    write(&dir.join("skills/testskill/SKILL.md"), "ALWAYS say the word pineapple.");
    let mut cmd = Command::new(exe());
    cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(dir.join("traj.json")).arg("-c").arg(dir.join("parent.yaml")).arg("-t").arg("orchestrate");
    cmd.env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_CHILD_CONFIG", dir.join("child.yaml"))
        .env("MINITUI_SKILLS_DIR", dir.join("skills"))
        .env("MINI_AGENT_MONITOR_MS", "50")
        .env_remove("MINI_AGENT_SOCKET").env_remove("MINI_AGENT_PARENT_SOCKET").env_remove("MINI_AGENT_DEPTH").env_remove("MINI_AGENT_CONTEXT_DIR");
    cmd.current_dir(dir);
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("parent.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let journal = dir.join("traj.jsonl");
    let deadline = Instant::now() + Duration::from_secs(25);
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
fn a_child_starts_with_the_context_the_parent_hands_over() {
    let dir = tmp("handover");
    write(&dir.join("notes.md"), "spawn lives in agent-rs/src/subagents.rs; hub owns the children.");
    write(&dir.join("brief.md"), "## Goal\nmap the spawn code path\n## Key paths\nagent-rs/src/subagents.rs\n## Conventions\nno new deps\n## Searches done\ngrep spawn: 12 hits\n## Decisions\nfollow the hub, not the web\nuse $testskill");
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent spawn worker --context-file notes.md --brief --prompt-file brief.md && mini-agent-rs agent wait worker --timeout 15"),
        ("submit", "parent done"),
    ]);
    let child = script("child", &[("submit", "pineapple: mapped the spawn path")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    assert!(msgs.iter().any(|m| text(m).contains("parent done")), "{}", msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n"));
    // The child's task carries the context file, the structured brief, its skills and the
    // shared state note: it never re-discovers any of it.
    let child_msgs = messages(&dir.join("subagents/worker/traj.jsonl"));
    let task = child_msgs.iter().find(|m| m["role"] == "user").map(text).unwrap_or_default();
    assert!(task.contains("<context name="), "{task}");
    assert!(task.contains("spawn lives in agent-rs/src/subagents.rs"), "{task}");
    assert!(task.contains("<brief>"), "{task}");
    assert!(task.contains("grep spawn: 12 hits"), "{task}");
    assert!(task.contains("<skill name=\"testskill\""), "{task}");
    assert!(task.contains("pineapple"), "{task}");
    assert!(task.contains("<shared-context>"), "{task}");
    assert!(task.contains("Shared state on disk:"), "{task}");
    assert!(task.contains("/context/"), "{task}");
    // The shared state dir exists for the whole run tree.
    assert!(dir.join("context").is_dir());
    // expand_skills still inlines $refs exactly once, before the request text.
    assert!(task.contains("Follow the skills above"), "{task}");
}

#[test]
fn oversize_context_and_shapeless_briefs_are_refused() {
    let dir = tmp("limits");
    write(&dir.join("big.md"), &"x".repeat(40_000));
    write(&dir.join("medium.md"), &"y".repeat(32_700));
    write(&dir.join("long-task.md"), &"z".repeat(32_700));
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent spawn big --context-file big.md 'do the job' > out1.txt 2>&1; echo rc1=$? >> out1.txt; cat out1.txt"),
        ("run", "mini-agent-rs agent spawn brief1 --brief 'just do the thing' > out2.txt 2>&1; echo rc2=$? >> out2.txt; cat out2.txt"),
        ("run", "mini-agent-rs agent spawn both --context-file medium.md --prompt-file long-task.md > out3.txt 2>&1; echo rc3=$? >> out3.txt; cat out3.txt"),
        ("submit", "parent done"),
    ]);
    let child = script("child", &[("submit", "unused")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let joined = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(joined.contains("rc1=1"), "{joined}");
    assert!(joined.contains("over the"), "{joined}");
    assert!(joined.contains("rc2=1"), "{joined}");
    assert!(joined.contains("missing:"), "{joined}");
    // Each piece fits its own cap but together they blow the assembled-message cap.
    assert!(joined.contains("rc3=1"), "{joined}");
    assert!(joined.contains("together"), "{joined}");
}
