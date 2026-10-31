//! ACP sessions on disk: `~/.config/mini-tui/acp-sessions/<sessionId>/`.
//!
//! `meta.json` holds `{sessionId, cwd, model, title, createdAt, updatedAt, turns: [...]}`; each
//! turn records the prompt as the user wrote it, its trajectory (`turn-N.traj.json` with its
//! `.jsonl` journal beside it) and where in that journal the turn's own messages start. The
//! trajectories are ordinary mini-agent trajectories: `mini-tui` and `--resume` read them as is.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub fn root() -> PathBuf {
    std::env::var("MINI_AGENT_ACP_HOME")
        .ok()
        .filter(|v| !v.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| crate::config::home().join(".config/mini-tui/acp-sessions"))
}

/// Session ids name directories: only ids this server could have made are accepted.
pub fn valid_id(id: &str) -> bool {
    !id.is_empty() && id.len() <= 128 && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
}

pub fn new_id() -> String {
    format!("mini-{}", crate::util_hex(24))
}

pub fn dir(id: &str) -> PathBuf {
    root().join(id)
}

pub fn load(id: &str) -> Option<Value> {
    let text = std::fs::read_to_string(dir(id).join("meta.json")).ok()?;
    serde_json::from_str::<Value>(&text).ok().filter(Value::is_object)
}

/// Atomic write: a reader (another `acp` process listing sessions) never sees half a file.
pub fn save(id: &str, meta: &Value) -> std::io::Result<()> {
    let d = dir(id);
    std::fs::create_dir_all(&d)?;
    let tmp = d.join(format!("meta.json.{}.tmp", std::process::id()));
    std::fs::write(&tmp, serde_json::to_string_pretty(meta).unwrap_or_default())?;
    std::fs::rename(&tmp, d.join("meta.json"))
}

/// Sessions with at least one prompt, most recently updated first.
pub fn list(cwd: Option<&str>) -> Vec<Value> {
    let Ok(entries) = std::fs::read_dir(root()) else { return vec![] };
    let mut out: Vec<Value> = entries
        .flatten()
        .filter_map(|e| e.file_name().to_str().filter(|n| valid_id(n)).and_then(load))
        .filter(|m| cwd.map_or(true, |c| m.get("cwd").and_then(Value::as_str) == Some(c)))
        .collect();
    out.sort_by(|a, b| b["updatedAt"].as_str().unwrap_or("").cmp(a["updatedAt"].as_str().unwrap_or("")));
    out
}

/// The `SessionInfo` entry of `session/list`.
pub fn info(meta: &Value) -> Value {
    let mut info = json!({
        "sessionId": meta["sessionId"],
        "cwd": meta["cwd"],
        "updatedAt": meta["updatedAt"],
    });
    if let Some(title) = meta.get("title").and_then(Value::as_str).filter(|t| !t.is_empty()) {
        info["title"] = json!(title);
    }
    info
}

/// The journal beside a trajectory (`x.traj.json` -> `x.traj.jsonl`), as the agent names it.
pub fn journal_of(traj: &Path) -> PathBuf {
    traj.with_extension("jsonl")
}

/// The messages a turn's journal holds, in order (`{"t":"msg"}` lines).
pub fn journal_messages(journal: &Path) -> Vec<Value> {
    let Ok(text) = std::fs::read_to_string(journal) else { return vec![] };
    let mut msgs = Vec::new();
    for line in text.lines() {
        let Ok(rec) = serde_json::from_str::<Value>(line) else { continue };
        match rec.get("t").and_then(Value::as_str) {
            // A rewritten journal starts over with a new meta line and the whole history again.
            Some("meta") => msgs.clear(),
            Some("msg") => msgs.extend(rec.get("m").cloned()),
            _ => {}
        }
    }
    msgs
}

/// The conversation a turn ended with, and whether the exported trajectory holds all of it.
///
/// A turn that finished exports its whole conversation (it ends with the `exit` message). An
/// interrupted one only journals: its export is whatever the throttle last wrote, possibly
/// steps behind, so the journal is the record.
pub fn turn_conversation(traj: &Path) -> (Vec<Value>, bool) {
    let exported = std::fs::read_to_string(traj)
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| v.get("messages").and_then(Value::as_array).cloned())
        .unwrap_or_default();
    if exported.last().and_then(|m| m.get("role")).and_then(Value::as_str) == Some("exit") {
        return (exported, true);
    }
    let journaled = journal_messages(&journal_of(traj));
    if journaled.len() >= exported.len() && !journaled.is_empty() {
        return (journaled, false);
    }
    let complete = !exported.is_empty();
    (exported, complete)
}

pub fn turn_messages(traj: &Path) -> Vec<Value> {
    turn_conversation(traj).0
}

/// Index of the first message that belongs to the turn whose task is `task`, in a conversation
/// that may start with the resumed history: right after the last user message carrying the task.
pub fn turn_start(messages: &[Value], task: &str, history_len: usize) -> Option<usize> {
    let task = task.trim();
    let follow_up = format!("The user added a new task: {task}");
    let carries = |m: &Value| {
        m.get("role").and_then(Value::as_str) == Some("user") && {
            let text = super::events::content_text(m.get("content"));
            text == follow_up || text.trim() == task || text.contains(task)
        }
    };
    messages.iter().enumerate().skip(history_len.min(messages.len())).find(|(_, m)| carries(m)).map(|(i, _)| i + 1)
        .or_else(|| messages.iter().rposition(carries).map(|i| i + 1))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ids_are_path_safe() {
        assert!(valid_id(&new_id()));
        assert!(valid_id("abc-DEF_1"));
        for bad in ["", "../x", "a/b", "a b", "x.y"] {
            assert!(!valid_id(bad), "{bad}");
        }
    }

    #[test]
    fn turn_start_skips_resumed_history() {
        let msgs = vec![
            json!({"role": "system", "content": "s"}),
            json!({"role": "user", "content": "Please solve this issue: fix it\n\nmore"}),
            json!({"role": "assistant", "content": "done"}),
            json!({"role": "user", "content": "The user added a new task: fix it", "extra": {"interrupt_type": "UserNewTask"}}),
            json!({"role": "assistant", "content": "again"}),
        ];
        assert_eq!(turn_start(&msgs, "fix it", 0), Some(2));
        assert_eq!(turn_start(&msgs, "fix it", 3), Some(4));
        assert_eq!(turn_start(&msgs, "other", 0), None);
    }

    #[test]
    fn journal_messages_restart_on_a_rewritten_journal() {
        let d = std::env::temp_dir().join(format!("acp-store-test-{}", std::process::id()));
        std::fs::create_dir_all(&d).unwrap();
        let j = d.join("t.traj.jsonl");
        std::fs::write(&j, concat!(
            "{\"t\":\"meta\"}\n{\"t\":\"msg\",\"m\":{\"role\":\"user\",\"content\":\"a\"}}\n{\"t\":\"info\",\"i\":{}}\n",
            "{\"t\":\"meta\"}\n{\"t\":\"msg\",\"m\":{\"role\":\"user\",\"content\":\"a\"}}\n{\"t\":\"msg\",\"m\":{\"role\":\"assistant\",\"content\":\"b\"}}\n{\"t\":\"delta\",\"k\":\"text\",\"x\":\"c\"}\n"
        )).unwrap();
        assert_eq!(journal_messages(&j).len(), 2);
        assert_eq!(turn_messages(&d.join("t.traj.json")).len(), 2);
        // An interrupted turn's stale export loses to its journal; a finished turn's export wins.
        std::fs::write(d.join("t.traj.json"), r#"{"messages":[{"role":"user","content":"a"}]}"#).unwrap();
        assert_eq!(turn_conversation(&d.join("t.traj.json")), (journal_messages(&j), false));
        std::fs::write(d.join("t.traj.json"), r#"{"messages":[{"role":"user","content":"a"},{"role":"exit","content":""}]}"#).unwrap();
        assert!(turn_conversation(&d.join("t.traj.json")).1);
        assert_eq!(journal_of(Path::new("/x/turn-1.traj.json")), PathBuf::from("/x/turn-1.traj.jsonl"));
        let _ = std::fs::remove_dir_all(&d);
    }
}
