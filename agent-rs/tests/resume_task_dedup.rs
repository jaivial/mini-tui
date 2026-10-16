//! A retried channel turn must not stack copies of its own task in the session it resumes.
//!
//! The consumer runs one turn per message and, when a turn dies (a provider failure, a restart
//! mid-turn), retries it against the same session: `runHeadless({resumeId})` with the SAME
//! prompt. Every resume appended `The user added a new task: …` without ever looking at what the
//! session already held, so one message became N copies of itself — the run that exposed this
//! (2026-10-15) reached 1205 steps, 36 copies of a one-line task and more than ten minutes of
//! agent, and every copy made the model redo the work.
//!
//! These tests drive the real binary the way the consumer drives it: a first turn, then a resume
//! from the session that turn left behind, with the retried copy still pending.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

/// The scripted answer every turn in these tests gives.
const ANSWER: &str = "aquí estoy";

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("resume-dedup-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

/// `turnPrompt`'s frame, verbatim from `src/channels/consumer.ts`: the task the consumer retries
/// is this whole string, byte for byte.
fn whatsapp_prompt(sender_text: &str) -> String {
    [
        "[WhatsApp message received in bound thread 120363411180584976@g.us — sender 242554100576489@lid]",
        sender_text,
        "",
        "Reply with your answer as your final plain-text answer; it is sent back to this chat",
        "as a quoted reply. Answer in the sender's language, concise enough for a chat message.",
    ]
    .join("\n")
}

/// The scripted model, with the instance template a real config uses, so a FRESH turn stores the
/// task inside a wrapper rather than as the bare text — the other encoding a resume has to know.
///
/// Two identical entries per run: with the goal oracle off, the FIRST plain-text reply is nudged
/// for a missing tool call and the second is the submission (`submission_pending`). Every process
/// reads `outputs` from the top, so one script serves the first turn and every retry of it.
fn script(outputs: &[&str]) -> String {
    let mut out = String::from(
        "agent:\n  system_template: s\n  instance_template: \"Please solve this issue: {{task}}\"\n  step_limit: 20\nmodel:\n  model_class: deterministic_toolcall\n  model_name: deterministic\n  cost_per_call: 0.01\n  outputs:\n",
    );
    for step in outputs {
        let text = serde_json::to_string(step).unwrap();
        out.push_str(&format!("    - {{role: assistant, content: {text}, extra: {{submission: {text}}}}}\n"));
    }
    out
}

fn run_turn(dir: &Path, task_file: &Path, resume: Option<&Path>, out: &str) -> Value {
    let mut cmd = Command::new(exe());
    cmd.arg("-y")
        .arg("-o")
        .arg(dir.join(out))
        .arg("-c")
        .arg(dir.join("agent.yaml"))
        .arg("-t")
        .arg(format!("@{}", task_file.display()))
        .env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_TASK_FILE", "1")
        .env("MINI_AGENT_GOAL_ORACLE", "off")
        // No fast path: the first turn then stores the instance message (`Please solve this
        // issue: …`), which is the encoding a failed first attempt leaves in the session.
        .env("MINI_AGENT_FASTPATH", "0")
        .env("MINI_CHANNEL_SUBJECT", "hola")
        .env("MINI_AGENT_RESERVE_MEM_MB", "64")
        .env_remove("MINI_AGENT_SOCKET")
        .env_remove("MINI_AGENT_PARENT_SOCKET")
        .env_remove("MINI_AGENT_DEPTH")
        .env_remove("MINI_AGENT_BIN")
        .env_remove("MINI_AGENT_CONFIG_DIR")
        .current_dir(dir);
    if let Some(resume) = resume {
        cmd.arg("--resume").arg(resume);
    }
    let _ = cmd.output().unwrap();
    serde_json::from_str(&std::fs::read_to_string(dir.join(out)).unwrap_or_else(|_| "{}".into())).unwrap_or(Value::Null)
}

fn messages(traj: &Value) -> &[Value] {
    match traj {
        Value::Array(v) => v,
        other => other["messages"].as_array().map(|v| v.as_slice()).unwrap_or(&[]),
    }
}

fn text(m: &Value) -> String {
    m["content"].as_str().map(String::from).unwrap_or_else(|| m["content"].to_string())
}

/// The copies of the task the resumed run appended: what the model reads as the thing to do.
fn pending_notes(traj: &Value, task: &str) -> usize {
    let note = format!("The user added a new task: {task}");
    messages(traj).iter().filter(|m| m["role"] == "user" && text(m) == note).count()
}

fn submission(traj: &Value) -> String {
    messages(traj)
        .iter()
        .rev()
        .find(|m| m["role"] == "exit")
        .and_then(|m| m["extra"]["submission"].as_str())
        .unwrap_or_default()
        .to_owned()
}

/// Setup shared by both tests: the first turn of a bound thread, then the session it left behind
/// with ONE more copy of the same task still pending — the shape a died-and-retried turn writes.
/// It returns (dir, task file, resume file, the task text).
///
/// The sender's words are conversational on purpose (`MINI_CHANNEL_SUBJECT` beside them): the turn
/// is answered in one model call, so what these tests measure is the task bookkeeping, not the
/// goal loop.
fn retried_session(name: &str) -> (PathBuf, PathBuf, PathBuf, String) {
    let dir = tmp(name);
    write(&dir.join("agent.yaml"), &script(&[ANSWER, ANSWER]));
    let task = whatsapp_prompt("hola");
    let task_file = dir.join("task.txt");
    write(&task_file, &task);

    let first = run_turn(&dir, &task_file, None, "first.json");
    assert_eq!(submission(&first), ANSWER, "the first turn answers: {:?}", messages(&first));
    let mut history: Vec<Value> = messages(&first).iter().filter(|m| m["role"] != "exit").cloned().collect();
    history.push(serde_json::json!({
        "role": "user",
        "content": format!("The user added a new task: {task}"),
        "extra": {"interrupt_type": "UserNewTask"},
    }));
    let resume = dir.join("resume.json");
    write(&resume, &serde_json::json!({ "messages": history }).to_string());
    (dir, task_file, resume, task)
}

/// THE BUG. On main the resumed run appended a second copy: the session held the retried task and
/// the model was handed it again, once per attempt. One copy is the whole task.
#[test]
fn a_retried_turn_does_not_stack_copies_of_its_own_task() {
    let (dir, task_file, resume, task) = retried_session("dedup");
    let second = run_turn(&dir, &task_file, Some(&resume), "second.json");
    let notes = pending_notes(&second, &task);
    assert_eq!(
        notes,
        1,
        "the resumed session already held one unfinished copy of this task, so the run must add one and only one: {:?}",
        messages(&second).iter().map(text).collect::<Vec<_>>()
    );
}

/// The copies already accumulated are collapsed too, not just the new one: a session that was
/// poisoned by five attempts (the real one held 36) must not keep feeding the model its own
/// task again and again.
#[test]
fn a_session_full_of_duplicate_copies_collapses_to_one() {
    let (dir, task_file, resume, task) = retried_session("collapse");
    let mut history: Vec<Value> = serde_json::from_str::<Value>(&std::fs::read_to_string(&resume).unwrap()).unwrap()["messages"]
        .as_array()
        .cloned()
        .unwrap();
    for _ in 0..4 {
        history.push(serde_json::json!({
            "role": "user",
            "content": format!("The user added a new task: {task}"),
            "extra": {"interrupt_type": "UserNewTask"},
        }));
    }
    let resume = dir.join("resume-many.json");
    write(&resume, &serde_json::json!({ "messages": history }).to_string());

    let second = run_turn(&dir, &task_file, Some(&resume), "second.json");
    let notes = pending_notes(&second, &task);
    assert_eq!(notes, 1, "five pending copies of one task must collapse into the single one this run adds");
    assert_eq!(submission(&second), ANSWER, "and the turn still answers");
}

/// The control: a task that was ANSWERED long ago is history. Its copy stays, and the new turn
/// gets its own — a repeated message is a repeated request, not a retry.
#[test]
fn an_answered_copy_is_not_touched() {
    let dir = tmp("answered");
    let task = whatsapp_prompt("hola");
    write(&dir.join("agent.yaml"), &script(&[ANSWER, ANSWER]));
    let task_file = dir.join("task.txt");
    write(&task_file, &task);

    let first = run_turn(&dir, &task_file, None, "first.json");
    assert_eq!(submission(&first), ANSWER);
    // The session as it stands after that answered turn: the instance message plus its answer.
    let mut history: Vec<Value> = messages(&first).iter().filter(|m| m["role"] != "exit").cloned().collect();
    history.push(serde_json::json!({
        "role": "user",
        "content": format!("The user added a new task: {task}"),
        "extra": {"interrupt_type": "UserNewTask"},
    }));
    let resume = dir.join("resume.json");
    write(&resume, &serde_json::json!({ "messages": history }).to_string());

    let second = run_turn(&dir, &task_file, Some(&resume), "second.json");
    let all = messages(&second).iter().map(text).collect::<Vec<_>>().join("\n---\n");
    // The answered instance message is still there, and the pending copy is the one replaced by
    // this run's own: one note, no loss of history.
    assert!(all.contains("Please solve this issue: "), "{all}");
    assert_eq!(pending_notes(&second, &task), 1, "{all}");
    assert_eq!(submission(&second), ANSWER, "{all}");
}
