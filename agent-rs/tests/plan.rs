//! The plan scheduler end to end: a scripted parent hands the hub a DAG and goes idle; the hub
//! launches every task the moment its deps are satisfied. No model, no network.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("plan-test-{name}-{}", std::process::id()));
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

/// Run the parent until its journal holds `until`, then stop it like the UI does. Children get
/// their own scripted config per name (`child-<name>.yaml`).
fn run_parent(dir: &Path, parent_yaml: &str, until: &str) -> Vec<Value> {
    write(&dir.join("parent.yaml"), parent_yaml);
    let mut cmd = Command::new(exe());
    cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(dir.join("traj.json")).arg("-c").arg(dir.join("parent.yaml")).arg("-t").arg("orchestrate");
    cmd.env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_CHILD_CONFIG", dir.join("child-{name}.yaml"))
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

fn plan_json(dir: &Path) -> Value {
    serde_json::from_str(&std::fs::read_to_string(dir.join("subagents/plan.json")).unwrap()).unwrap()
}

fn status(plan: &Value, id: &str) -> String {
    plan["tasks"].as_array().unwrap().iter().find(|t| t["id"] == id).unwrap()["status"].as_str().unwrap().to_string()
}

fn task_message(dir: &Path, child: &str) -> String {
    messages(&dir.join(format!("subagents/{child}/traj.jsonl")))
        .iter()
        .find(|m| m["role"] == "user")
        .map(text)
        .unwrap_or_default()
}

#[test]
fn a_finished_task_launches_its_successor_at_once_while_others_run() {
    let dir = tmp("auto");
    write(&dir.join("plan-file.json"), r#"{"tasks":[
        {"id":"A1","title":"map spawn","task":"map it","deps":[],"budget":{"steps":60,"cost":0.5}},
        {"id":"A2","title":"use the map","task":"use it","deps":["A1"]},
        {"id":"B","title":"slow side quest","task":"take your time","deps":[]}
    ]}"#);
    write(&dir.join("child-A1.yaml"), &script("a1", &[("submit", "a1 done")]));
    write(&dir.join("child-A2.yaml"), &script("a2", &[("submit", "a2 done")]));
    write(&dir.join("child-B.yaml"), &script("b", &[("run", "sleep 5"), ("submit", "b done")]));
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent plan submit --file plan-file.json"),
        ("submit", "parent resting"),
        // each wake consumes one scripted output: keep buffer answers for the [plan] notes
        ("submit", "buffer"), ("submit", "buffer"), ("submit", "buffer"), ("submit", "buffer"),
    ]);
    // The parent is idle: the note wakes it after A2 finished, while B still works.
    let msgs = run_parent(&dir, &parent, "[plan] A2 finished");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("[plan] A1 finished (review) -> launching A2"), "{all}");
    assert!(all.contains("[plan] A2 launched (deps satisfied: A1)"), "{all}");
    assert!(all.contains("[plan] A2 finished (review)"), "{all}");
    // B keeps running while the chain completes: parallelism is untouched.
    let plan = plan_json(&dir);
    assert_eq!(status(&plan, "A1"), "review", "{plan}");
    assert_eq!(status(&plan, "A2"), "review", "{plan}");
    assert_eq!(status(&plan, "B"), "running", "{plan}");
    // The budgets of the plan are the child's budgets.
    let index: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("subagents/index.json")).unwrap()).unwrap();
    let a1 = index["children"].as_array().unwrap().iter().find(|c| c["name"] == "A1").unwrap();
    assert_eq!(a1["steps"].as_i64().unwrap() <= 60, true, "{a1}");
}

#[test]
fn a_chain_of_three_runs_with_handoff() {
    let dir = tmp("chain");
    write(&dir.join("plan-file.json"), r#"{"tasks":[
        {"id":"Z1","title":"step one","task":"write context/z1.md and answer","deps":[],"artifacts":["context/z1.md"]},
        {"id":"Z2","title":"step two","task":"read the handoff and answer","deps":["Z1"],"artifacts":["context/z2.md"]},
        {"id":"Z3","title":"step three","task":"finish it","deps":["Z2"]}
    ]}"#);
    write(&dir.join("child-Z1.yaml"), &script("z1", &[("run", "mkdir -p context && echo 'z1 artifact body' > context/z1.md"), ("submit", "z1 done")]));
    write(&dir.join("child-Z2.yaml"), &script("z2", &[("run", "echo 'z2 artifact body' > context/z2.md"), ("submit", "z2 done")]));
    write(&dir.join("child-Z3.yaml"), &script("z3", &[("submit", "z3 done")]));
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent plan submit --file plan-file.json"),
        ("submit", "parent resting"),
        ("submit", "buffer"), ("submit", "buffer"), ("submit", "buffer"), ("submit", "buffer"),
    ]);
    let msgs = run_parent(&dir, &parent, "[plan] Z3 finished");

    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("[plan] Z1 finished (review) -> launching Z2"), "{all}");
    assert!(all.contains("[plan] Z2 finished (review) -> launching Z3"), "{all}");
    let plan = plan_json(&dir);
    assert_eq!(status(&plan, "Z3"), "review", "{plan}");
    // Z2 started with Z1's result and artifact in its task: the handoff.
    let z2_task = task_message(&dir, "Z2");
    assert!(z2_task.contains("<handoff from=\"Z1\""), "{z2_task}");
    assert!(z2_task.contains("z1 done"), "{z2_task}");
    assert!(z2_task.contains("artifact context/z1.md"), "{z2_task}");
    assert!(z2_task.contains("z1 artifact body"), "{z2_task}");
    // Z3 gets Z2's handoff. The DAG does NOT re-push Z1's result in the handoff block (Z3's only
    // dep is Z2), but the accumulated shared context (ContextStore, Fase 7) does carry Z1's
    // artifact: everything a previous child wrote into context/ is handed to the next one, so
    // nothing that was already learned has to be discovered again.
    let z3_task = task_message(&dir, "Z3");
    assert!(z3_task.contains("<handoff from=\"Z2\""), "{z3_task}");
    assert!(z3_task.contains("z2 artifact body"), "{z3_task}");
    let handoff_only = z3_task.split("<context name=").next().unwrap_or("");
    assert!(!handoff_only.contains("z1 artifact body"), "Z1 must not re-enter the handoff block: {handoff_only}");
    // …and the shared context is what carries it instead.
    assert!(z3_task.contains("<context name=\"z1.md\""), "{z3_task}");
}

#[test]
fn a_failed_task_blocks_its_dependents_and_reports() {
    let dir = tmp("fail");
    write(&dir.join("plan-file.json"), r#"{"tasks":[
        {"id":"P1","title":"the risky one","task":"hang around","deps":[]},
        {"id":"P2","title":"after it","task":"continue","deps":["P1"]}
    ]}"#);
    write(&dir.join("child-P1.yaml"), &script("p1", &[("run", "sleep 30"), ("submit", "never")]));
    write(&dir.join("child-P2.yaml"), &script("p2", &[("submit", "unused")]));
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent plan submit --file plan-file.json && sleep 1 && mini-agent-rs agent stop P1"),
        ("submit", "parent resting"),
        ("submit", "buffer"), ("submit", "buffer"), ("submit", "buffer"),
    ]);
    let msgs = run_parent(&dir, &parent, "[plan] P1 failed");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("[plan] P1 failed"), "{all}");
    assert!(all.contains("dependents are blocked"), "{all}");
    let plan = plan_json(&dir);
    assert_eq!(status(&plan, "P1"), "failed", "{plan}");
    assert_eq!(status(&plan, "P2"), "blocked", "{plan}");
}

#[test]
fn a_plan_is_validated_shown_and_reviewed() {
    let dir = tmp("cli");
    write(&dir.join("bad.json"), r#"{"tasks":[{"id":"A","task":"x","deps":["B"]},{"id":"B","task":"y","deps":["A"]}]}"#);
    write(&dir.join("good.json"), r#"{"tasks":[{"id":"W1","title":"one","task":"do it","deps":[]}]}"#);
    write(&dir.join("child-W1.yaml"), &script("w1", &[("submit", "w1 done")]));
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent plan submit --file bad.json > out1.txt 2>&1; echo rc1=$? >> out1.txt; cat out1.txt"),
        ("run", "mini-agent-rs agent plan submit --file good.json && mini-agent-rs agent wait W1 --timeout 15 && mini-agent-rs agent plan review W1 ok && mini-agent-rs agent plan graph && mini-agent-rs agent plan review W1 fail wrong && mini-agent-rs agent plan retry W1 && mini-agent-rs agent wait W1 --timeout 15 && mini-agent-rs agent plan show"),
        ("submit", "parent done"),
        ("submit", "buffer"), ("submit", "buffer"),
    ]);
    let msgs = run_parent(&dir, &parent, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("rc1=1"), "{all}");
    assert!(all.contains("cycle"), "{all}");
    assert!(all.contains("plan accepted: 1 tasks"), "{all}");
    assert!(all.contains("[plan] W1 finished (review)"), "{all}");
    assert!(all.contains("W1: done"), "{all}");
    assert!(all.contains("W1: failed, dependents are blocked"), "{all}");
    assert!(all.contains("back to pending"), "{all}");
    assert!(all.contains("ready queue:"), "{all}");
    // the retry relaunched it and the second run finished into review again (the transition
    // lands on the hub's next tick: give it a moment)
    for _ in 0..40 {
        if status(&plan_json(&dir), "W1") == "review" {
            break;
        }
        std::thread::sleep(Duration::from_millis(50));
    }
    let plan = plan_json(&dir);
    assert_eq!(status(&plan, "W1"), "review", "{plan}");
}

#[test]
fn a_restart_recovers_a_plan_left_running() {
    let dir = tmp("restart");
    write(&dir.join("plan-file.json"), r#"{"tasks":[
        {"id":"P1","title":"hangs","task":"hang around","deps":[]},
        {"id":"P2","title":"after it","task":"continue","deps":["P1"]}
    ]}"#);
    write(&dir.join("child-P1.yaml"), &script("p1", &[("run", "sleep 30"), ("submit", "never")]));
    write(&dir.join("child-P2.yaml"), &script("p2", &[("submit", "unused")]));
    let parent = script("parent", &[
        ("run", "mini-agent-rs agent plan submit --file plan-file.json"),
        ("submit", "parent resting"),
        ("submit", "buffer"), ("submit", "buffer"),
    ]);
    run_parent(&dir, &parent, "[plan] P1 launched");
    // The session dies with P1 running; the next session finds plan.json and must not hang.
    std::thread::sleep(Duration::from_millis(300));
    let parent2 = script("parent2", &[
        ("run", "mini-agent-rs agent plan show"),
        ("submit", "parent done"),
        ("submit", "buffer"),
    ]);
    let msgs = run_parent(&dir, &parent2, "its subagent is gone");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("[plan] P1 failed"), "{all}");
    let plan = plan_json(&dir);
    assert_eq!(status(&plan, "P1"), "failed", "{plan}");
    assert_eq!(status(&plan, "P2"), "blocked", "{plan}");
}
