//! Subagents end to end: a scripted parent drives `mini-agent-rs agent …` from its bash tool;
//! scripted children answer. No model, no network.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("subagents-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

/// A scripted model config: each output either runs `cmd` or submits `answer`.
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

/// Run the parent until its journal holds `until` (in some message), then stop it like the UI.
fn run_parent(dir: &Path, parent_yaml: &str, child_yaml: Option<&str>, until: &str, control: bool) -> (Vec<Value>, std::process::ExitStatus) {
    write(&dir.join("parent.yaml"), parent_yaml);
    let mut cmd = Command::new(exe());
    cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(dir.join("traj.json")).arg("-c").arg(dir.join("parent.yaml")).arg("-t").arg("orchestrate");
    cmd.env("MSWEA_SILENT_STARTUP", "1").env_remove("MINI_AGENT_SOCKET").env_remove("MINI_AGENT_PARENT_SOCKET").env_remove("MINI_AGENT_DEPTH");
    cmd.env("MINI_AGENT_MONITOR_MS", "50").current_dir(dir);
    if control {
        write(&dir.join("control"), "");
        cmd.env("MSWEA_CONTROL_FILE", dir.join("control"));
    } else {
        cmd.env("MSWEA_CONTROL_FILE", "");
    }
    if let Some(c) = child_yaml {
        write(&dir.join("child.yaml"), c);
        cmd.env("MINI_AGENT_CHILD_CONFIG", dir.join("child.yaml"));
    }
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("parent.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let journal = dir.join("traj.jsonl");
    let deadline = Instant::now() + Duration::from_secs(25);
    loop {
        if let Ok(Some(status)) = child.try_wait() {
            return (messages(&journal), status);
        }
        if messages(&journal).iter().any(|m| text(m).contains(until)) || Instant::now() > deadline {
            std::thread::sleep(Duration::from_millis(300));
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let status = child.wait().unwrap();
            return (messages(&journal), status);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

fn joined(msgs: &[Value]) -> String {
    msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n")
}

#[test]
fn a_finished_subagent_wakes_its_parent_and_keeps_its_context() {
    let dir = tmp("wake");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent spawn worker 'say hi'"),
            ("submit", "parent turn one"),
            // woken by the report alone (no user message), on the same child process
            ("run", "cat pid_1; mini-agent-rs agent send worker 'second job'; mini-agent-rs agent wait worker --timeout 15; cat pid_2"),
            ("submit", "parent done"),
        ],
    );
    let child = script(
        "child",
        &[
            ("run", "echo $PPID > ../../pid_1; echo depth=$MINI_AGENT_DEPTH name=$MINI_AGENT_NAME"),
            ("submit", "hello from worker"),
            ("run", "echo $PPID > ../../pid_2"),
            ("submit", "second answer"),
        ],
    );
    // the child works in the parent's folder; its pid files land there
    let parent = parent.replace("cat pid_1", &format!("cat {}/pid_1", dir.display())).replace("cat pid_2", &format!("cat {}/pid_2", dir.display()));
    let child = child.replace("../../pid_1", &format!("{}/pid_1", dir.display())).replace("../../pid_2", &format!("{}/pid_2", dir.display()));
    let (msgs, _) = run_parent(&dir, &parent, Some(&child), "parent done", true);
    let all = joined(&msgs);
    assert!(all.contains("started subagent worker"), "{all}");
    let report = msgs.iter().find(|m| m["extra"]["interrupt_type"] == "Subagent").expect("a subagent report");
    assert!(text(report).contains("[subagent worker] finished its turn: Submitted"), "{}", text(report));
    assert!(text(report).contains("hello from worker"));
    // the parent continued on its own after its turn ended
    assert!(all.contains("parent done"), "{all}");
    // the follow-up ran in the SAME child process (no restart, no replayed history)
    let p1 = std::fs::read_to_string(dir.join("pid_1")).unwrap();
    let p2 = std::fs::read_to_string(dir.join("pid_2")).unwrap();
    assert_eq!(p1, p2, "the follow-up must reach the same process");
    assert!(all.contains("sent: worker continues with its full context"), "{all}");
    // the follow-up was waited for, so it is not reported a second time
    assert_eq!(msgs.iter().filter(|m| m["extra"]["interrupt_type"] == "Subagent").count(), 1, "{all}");
    // the child's conversation is one session: both turns, one system prompt
    let child_msgs = messages(&dir.join("subagents/worker/traj.jsonl"));
    assert_eq!(child_msgs.iter().filter(|m| m["role"] == "system").count(), 1);
    assert!(joined(&child_msgs).contains("second job"));
    // the index lists it for the UIs
    let index: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("subagents/index.json")).unwrap()).unwrap();
    assert_eq!(index["children"][0]["name"], "worker");
    // a child runs on its parent's model unless told otherwise
    assert_eq!(index["children"][0]["model"], "parent");
    assert_eq!(index["children"][0]["turns"], 2);
}

#[test]
fn a_subagent_can_message_its_parent_and_children_stop_with_it() {
    let dir = tmp("ask");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent spawn slow 'work slowly' && sleep 1"),
            ("submit", "parent waits"),
            ("run", "mini-agent-rs agent ls"),
            ("submit", "parent saw the question"),
        ],
    );
    let child = script(
        "child",
        &[
            ("run", "mini-agent-rs agent ask 'which branch should I use?'"),
            ("run", "sleep 60"),
            ("submit", "never"),
        ],
    );
    let (msgs, _) = run_parent(&dir, &parent, Some(&child), "parent saw the question", true);
    let all = joined(&msgs);
    assert!(all.contains("[subagent slow] says: which branch should I use?"), "{all}");
    // the parent was stopped: its child must not outlive it
    std::thread::sleep(Duration::from_millis(500));
    let index: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("subagents/index.json")).unwrap()).unwrap();
    let pid = index["children"][0]["pid"].as_i64().unwrap() as i32;
    assert!(unsafe { libc::kill(pid, 0) } != 0, "the subagent outlived its parent");
}

#[test]
fn a_stopped_subagent_continues_from_its_saved_conversation() {
    let dir = tmp("resume");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent spawn w 'first' && mini-agent-rs agent wait w --timeout 15 && mini-agent-rs agent stop w && sleep 1 && mini-agent-rs agent send w 'again' && mini-agent-rs agent wait w --timeout 15 && mini-agent-rs agent result w"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "first answer"), ("submit", "answer after resume")]);
    let (msgs, _) = run_parent(&dir, &parent, Some(&child), "parent done", false);
    let all = joined(&msgs);
    assert!(all.contains("restarted it on its saved conversation"), "{all}");
    // (a resumed scripted model starts its outputs over, so the answer text repeats: what matters
    // is that the new process carries the old conversation and the new task, in one session)
    let child_msgs = messages(&dir.join("subagents/w/traj.jsonl"));
    let roles: Vec<String> = child_msgs.iter().map(|m| format!("{}:{}", m["role"].as_str().unwrap(), text(m))).collect();
    assert_eq!(child_msgs.iter().filter(|m| m["role"] == "system").count(), 1, "{roles:?}");
    let first = roles.iter().position(|r| r.starts_with("user:first")).expect("the first task");
    let again = roles.iter().position(|r| r.ends_with("new task: again")).expect("the new task");
    assert!(first < again, "{roles:?}");
    // the replayed history is not counted as a new turn: two turns in all
    let index: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("subagents/index.json")).unwrap()).unwrap();
    assert_eq!(index["children"][0]["turns"], 2, "{index}");
}

#[test]
fn a_headless_parent_waits_for_its_children_before_it_exits() {
    let dir = tmp("headless");
    let parent = script("parent", &[("run", "mini-agent-rs agent spawn w 'job'"), ("submit", "parent turn"), ("submit", "parent read the report")]);
    let child = script("child", &[("run", "sleep 1"), ("submit", "child answer")]);
    // No control file: a headless run. It must not exit (killing the child) while the child works.
    let (msgs, status) = run_parent(&dir, &parent, Some(&child), "never-appears", false);
    assert!(status.success(), "{status:?}");
    let all = joined(&msgs);
    assert!(all.contains("child answer"), "{all}");
    assert!(all.contains("parent read the report"), "{all}");
}

#[test]
fn children_spend_counts_toward_the_parent_and_limits_are_enforced() {
    let dir = tmp("limits");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent spawn bad/name x; echo rc=$?; mini-agent-rs agent send nobody hi; echo rc=$?; mini-agent-rs agent spawn ok 'x' --cost-limit 50"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "fine")]);
    let parent = parent.replace("step_limit: 40", "step_limit: 40\n  cost_limit: 1.5");
    let (msgs, _) = run_parent(&dir, &parent, Some(&child), "parent done", false);
    let all = joined(&msgs);
    assert!(all.contains("invalid subagent name"), "{all}");
    assert!(all.contains("no subagent named nobody"), "{all}");
    assert!(all.contains("budget capped to the $1.50 this session has left"), "{all}");
    let traj: Value = serde_json::from_str(&std::fs::read_to_string(dir.join("traj.json")).unwrap()).unwrap();
    assert_eq!(traj["info"]["subagents"][0]["name"], "ok");
    assert!(traj["info"]["subagents_cost"].as_f64().is_some());
}

#[test]
fn the_client_explains_where_it_works() {
    let out = Command::new(exe()).arg("agent").arg("ls").env_remove("MINI_AGENT_SOCKET").output().unwrap();
    assert_eq!(out.status.code(), Some(2));
    assert!(String::from_utf8_lossy(&out.stderr).contains("MINI_AGENT_SOCKET is not set"));
    let help = Command::new(exe()).arg("agent").arg("--help").output().unwrap();
    assert!(String::from_utf8_lossy(&help.stdout).contains("agent spawn"));
}
