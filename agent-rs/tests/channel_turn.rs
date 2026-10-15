//! A channel turn must answer the chat, not argue with the goal-closure judge.
//!
//! The WhatsApp consumer wraps the sender's words in a transport frame (`turnPrompt`): the
//! thread header, the reply-format rules and the queue directives, ~176 words around the
//! message. The runner classified THAT, and two things followed:
//!
//!   - on a resumed turn (every turn after the first in a bound thread — the fast path only
//!     runs on a fresh session) a chat opener with no greeting word in it ("qué tal", "ok")
//!     read as work, so the closure judge judged the greeting, rejected the closure, and the
//!     model answered the judge instead of the user. That chatter is what reached the chat.
//!
//! These tests drive the real binary with a scripted model and the real frame, resumed the
//! way the consumer resumes:
//!   - a chat turn reaches the chat as the answer, with no judge and no closure chatter;
//!   - without the sender's words the same turn is judged — the bug this routes around;
//!   - work turns and queue/delegation turns still go through the judge, untouched.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("channel-turn-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

/// A scripted model: one reply per entry, in order. A plain-text reply with a `submission`
/// is a proposed final answer — and, with the judge on, the NEXT entry is what the judge
/// sees. A rejected verdict sends the gaps back to the worker, which spends the entry after.
fn script(steps: &[&str]) -> String {
    let mut out = String::from(
        "agent:\n  system_template: s\n  instance_template: \"{{task}}\"\n  step_limit: 20\nmodel:\n  model_class: deterministic_toolcall\n  model_name: deterministic\n  cost_per_call: 0.01\n  outputs:\n",
    );
    for step in steps {
        let text = serde_json::to_string(step).unwrap();
        out.push_str(&format!(
            "    - {{role: assistant, content: {text}, extra: {{submission: {text}}}}}\n"
        ));
    }
    out
}

const APPROVE: &str = r#"{"complete": true, "score": 100, "gaps": []}"#;
const REJECT: &str = r#"{"complete": false, "score": 40, "gaps": ["falta comprobar los errores"]}"#;

/// `turnPrompt`'s frame, verbatim from `src/channels/consumer.ts`.
fn whatsapp_prompt(sender_text: &str) -> String {
    [
        "[WhatsApp message received in bound thread 120363411180584976@g.us — sender 242554100576489@lid]",
        sender_text,
        "",
        "Reply with your answer as your final plain-text answer; it is sent back to this chat",
        "as a quoted reply. Answer in the sender's language, concise enough for a chat message.",
        "",
        "To hand work to the background queue you may end your reply with exactly ONE directive",
        "on its own last line — never inside the visible answer:",
        "[[mini-queue: <concise, self-contained goal>]] when the sender asks for work to be done in the background;",
        "[[mini-followup: <what to add or correct>]] when the sender adds to or corrects earlier queued work;",
        "[[mini-status]] when the sender only asks about the state of queued work.",
        "When the sender explicitly asks to start a brand-new dedicated session (\"nueva sesión\",",
        "\"new chat\"), end the reply with [[mini-newgroup: <short subject for the new chat>]] instead:",
        "a new isolated WhatsApp group bound to a fresh session is created for them.",
        "The bridge removes the directive line before sending and confirms the queueing itself.",
        "When the message is purely conversational, emit no directive.",
    ]
    .join("\n")
}

fn agent(dir: &Path, config: &str) -> Command {
    let mut cmd = Command::new(exe());
    cmd.arg("-y")
        .arg("-o")
        .arg(dir.join("traj.json"))
        .arg("-c")
        .arg(dir.join("agent.yaml"))
        .env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_TASK_FILE", "1")
        .env_remove("MINI_AGENT_SOCKET")
        .env_remove("MINI_AGENT_PARENT_SOCKET")
        .env_remove("MINI_AGENT_DEPTH")
        .env_remove("MINI_AGENT_BIN")
        .env_remove("MINI_AGENT_CONFIG_DIR")
        .env_remove("MINI_AGENT_CONTEXT")
        .env_remove("MINI_CHANNEL_SUBJECT")
        .env_remove("MINI_AGENT_GOAL_ORACLE")
        .env_remove("MINI_AGENT_FASTPATH")
        .env("MINI_AGENT_RESERVE_MEM_MB", "64")
        .current_dir(dir);
    cmd
}

fn run(dir: &Path, task_file: &Path, resume: Option<&Path>, subject: Option<&str>) -> Value {
    let mut cmd = agent(dir, "");
    cmd.arg("-t").arg(format!("@{}", task_file.display()));
    if let Some(resume) = resume {
        cmd.arg("--resume").arg(resume);
    }
    if let Some(subject) = subject {
        cmd.env("MINI_CHANNEL_SUBJECT", subject);
    }
    let _ = cmd.output().unwrap();
    serde_json::from_str(&std::fs::read_to_string(dir.join("traj.json")).unwrap_or_else(|_| "{}".into()))
        .unwrap_or(Value::Null)
}

/// One RESUMED turn in a bound thread, exactly as the consumer runs it: a first turn that
/// opens the conversation, then the message under test with the sender's words beside it.
fn resumed_turn(name: &str, sender_text: &str, subject: Option<&str>, outputs: &[&str]) -> Value {
    let dir = tmp(name);
    write(&dir.join("agent.yaml"), &script(outputs));
    let first = dir.join("first.txt");
    let second = dir.join("second.txt");
    write(&first, &whatsapp_prompt("primer turno"));
    write(&second, &whatsapp_prompt(sender_text));
    // The opening turn, resumed-from by the turn under test: this is what makes it a
    // continuation, and the fast path only ever runs on a fresh session.
    let _ = agent(&dir, "")
        .arg("-o")
        .arg(dir.join("first.json"))
        .arg("-t")
        .arg(format!("@{}", first.display()))
        .output()
        .unwrap();
    run(&dir, &second, Some(&dir.join("first.json")), subject)
}

fn messages(traj: &Value) -> &[Value] {
    match traj {
        Value::Array(v) => v,
        other => other["messages"].as_array().map(|v| v.as_slice()).unwrap_or(&[]),
    }
}

/// What this turn contributed: the messages after the first turn's own answer. The resumed
/// history is not evidence about the turn under test.
fn turn_messages(traj: &Value) -> Vec<Value> {
    let all = messages(traj);
    let second_task = all
        .iter()
        .rposition(|m| m["extra"]["interrupt_type"] == "UserNewTask")
        .unwrap_or(0);
    all[second_task..].to_vec()
}

fn text(m: &Value) -> String {
    m["content"].as_str().map(String::from).unwrap_or_else(|| m["content"].to_string())
}

fn joined(msgs: &[Value]) -> String {
    msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n")
}

/// The reply WhatsApp would receive: the run's submitted exit text.
fn submission(traj: &Value) -> String {
    turn_messages(traj)
        .iter()
        .rev()
        .find(|m| m["role"] == "exit")
        .and_then(|m| m["extra"]["submission"].as_str())
        .unwrap_or_default()
        .to_owned()
}

fn judged(traj: &Value) -> bool {
    traj["info"]["goal_oracle"]["attempts"].as_array().is_some_and(|a| !a.is_empty())
}

/// THE BUG, and the fix. A chat opener with no greeting word in it — "qué tal" is what the
/// QA group actually sent — reads as work once it is wrapped in the transport frame, so the
/// judge rejects the closure and the model answers the judge. The sender's own words travel
/// beside the prompt (`MINI_CHANNEL_SUBJECT`), and the chat turn is answered, not judged.
#[test]
fn a_resumed_chat_turn_is_answered_not_judged() {
    let traj = resumed_turn(
        "chat-fixed",
        "qué tal",
        Some("qué tal"),
        // One answer and nothing after it: a second reply means the judge ran.
        &["todo bien, aquí estoy"],
    );
    let all = joined(&turn_messages(&traj));
    assert_eq!(submission(&traj), "todo bien, aquí estoy", "{all}");
    assert!(!judged(&traj), "a chat turn must not be judged: {all}");
    assert!(!all.contains("Goal oracle"), "{all}");
    assert!(!all.contains("cierre incompleto"), "{all}");
    assert_eq!(
        turn_messages(&traj).iter().filter(|m| m["role"] == "assistant").count(),
        1,
        "one model call, the answer: {all}"
    );
}

/// The same turn WITHOUT the sender's words: the frame alone is what defeated the classifier,
/// so the judge runs and the closure chatter is what the run submits. This is the failure the
/// subject hint exists to prevent, pinned so a future change cannot quietly restore it.
#[test]
fn without_the_senders_words_the_frame_alone_is_judged() {
    let traj = resumed_turn(
        "chat-unfixed",
        "qué tal",
        None,
        &["respuesta", REJECT, "⚠️ Posible cierre incompleto detectado", APPROVE],
    );
    let all = joined(&turn_messages(&traj));
    assert!(judged(&traj), "the 176-word frame hides a chat opener: {all}");
    assert!(all.contains("Goal oracle"), "{all}");
    assert!(
        submission(&traj).contains("cierre incompleto"),
        "and the chatter, not the answer, is what reaches the chat: {all}"
    );
}

/// The other half of the contract: a work turn still goes through the judge, gaps and all.
#[test]
fn a_channel_work_turn_still_goes_through_the_judge() {
    let traj = resumed_turn(
        "work",
        "mira los logs del servidor y dime si hay errores",
        Some("mira los logs del servidor y dime si hay errores"),
        &[
            "he revisado los logs",
            REJECT,
            "he revisado los logs: dos errores de timeout",
            APPROVE,
        ],
    );
    let all = joined(&turn_messages(&traj));
    assert!(judged(&traj), "a work turn must still be judged: {all}");
    assert!(all.contains("falta comprobar los errores"), "the gaps go back to the worker: {all}");
    assert_eq!(submission(&traj), "he revisado los logs: dos errores de timeout", "{all}");
}

/// A queue/delegation turn — the machinery this fix must not break — still closes on the
/// judge's approval, and the reply keeps the directive the bridge consumes.
#[test]
fn a_queue_directive_turn_still_closes_through_the_judge() {
    let traj = resumed_turn(
        "queue",
        "busca los archivos modificados y crea un resumen",
        Some("busca los archivos modificados y crea un resumen"),
        &["voy a encolarlo\n[[mini-queue: resumir los archivos modificados]]", APPROVE],
    );
    let all = joined(&turn_messages(&traj));
    assert!(judged(&traj), "a delegation turn is still judged: {all}");
    assert!(
        submission(&traj).contains("[[mini-queue:"),
        "and the bridge still gets its directive: {all}"
    );
    assert_eq!(submission(&traj), "voy a encolarlo\n[[mini-queue: resumir los archivos modificados]]", "{all}");
}