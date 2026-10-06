//! Cold-start metrics: how much of a run (or a child) went to re-discovery.
//!
//! `mini-agent-rs metrics <traj.jsonl>` reads a journal and splits every step into **discovery**
//! (read-only commands: listing, searching, reading — what a child re-does from a cold start) and
//! **work** (edits, builds, tests, git…). It reports steps, calls and estimated tokens for each,
//! plus what a brief covering the discoveries would have cost instead. Measurement only: nothing
//! about how a run behaves changes here (Fase 0 of docs/orchestration-plan.md).

use crate::compaction::{message_chars, DEFAULT_CHARS_PER_TOKEN};
use serde_json::{json, Value};
use std::path::Path;

/// The label of a command for the report: `git log`, `cargo test`, `grep`… (binary plus the
/// subcommand where that is what decides, `git log` vs `git commit`).
fn command_label(command: &str) -> String {
    let mut it = command.trim().split_whitespace().peekable();
    while matches!(it.peek(), Some(&"sudo") | Some(&"env") | Some(&"time")) {
        it.next();
    }
    let Some(w) = it.next() else { return String::new() };
    if matches!(w, "git" | "docker" | "cargo" | "bun" | "npm" | "systemctl" | "gh") {
        if let Some(sub) = it.peek() {
            if !sub.starts_with('-') {
                return format!("{w} {}", sub.trim_start_matches('-'));
            }
        }
    }
    w.to_string()
}

/// Read-only by nature: listing, searching, reading, counting.
const READERS: &[&str] = &["ls", "cat", "grep", "rg", "find", "tree", "head", "tail", "wc", "less", "more", "file", "stat", "du", "df", "pwd", "which", "type", "echo", "printf", "basename", "dirname", "realpath", "readlink", "sed", "awk", "sort", "uniq", "cut", "tr", "column", "jq", "zcat", "xargs"];

/// `git` subcommands that only read the repository.
const GIT_READS: &[&str] = &["status", "log", "diff", "show", "branch", "blame", "describe", "remote", "stash", "ls-files", "rev-parse", "shortlog"];

/// Is this command discovery (read-only inspection) or work? A whole pipeline is discovery only
/// when every part is; anything that redirects, edits (`sed -i`) or builds counts as work.
fn is_discovery(command: &str) -> bool {
    command.split(['|', ';', '&']).filter(|p| !p.trim().is_empty()).all(|part| {
        // A redirection writes somewhere: not discovery (except `2>` error discards).
        if part.split_whitespace().any(|t| t.contains('>') && !t.starts_with("2>")) {
            return false;
        }
        let mut it = part.trim().split_whitespace().peekable();
        while matches!(it.peek(), Some(&"sudo") | Some(&"env") | Some(&"time")) {
            it.next();
        }
        let Some(w) = it.next() else { return false };
        match w {
            "git" => it.peek().map(|s| GIT_READS.contains(s)).unwrap_or(false),
            "sed" => !part.split_whitespace().any(|t| t == "-i"),
            "find" => !part.split_whitespace().any(|t| matches!(t, "-delete" | "-exec" | "-fls" | "-fprint")),
            // `xargs` runs whatever follows: classify that (`find . | xargs grep x` reads).
            "xargs" => is_discovery(part.trim().strip_prefix("xargs").unwrap_or("")),
            w => READERS.contains(&w),
        }
    })
}

/// One journal, measured.
pub fn measure(journal: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(journal).map_err(|e| format!("{}: {e}", journal.display()))?;
    let mut msgs: Vec<Value> = vec![];
    for line in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(line) else { continue };
        match v.get("t").and_then(Value::as_str) {
            Some("meta") => msgs.clear(), // a rewrite starts over
            Some("msg") => msgs.push(v["m"].clone()),
            _ => {}
        }
    }
    let chars_per_token = DEFAULT_CHARS_PER_TOKEN;
    let tokens = |m: &Value| (message_chars(m) as f64 / chars_per_token).round() as i64;
    let mut out = json!({
        "journal": journal.display().to_string(),
        "task_tokens": 0,
        "steps": 0,
        "discovery_steps": 0,
        "work_steps": 0,
        "discovery_tokens": 0,
        "work_tokens": 0,
        "output_tokens": 0,
        "commands": [],
    });
    let mut commands: Vec<(String, i64)> = vec![];
    for (i, m) in msgs.iter().enumerate() {
        match m.get("role").and_then(Value::as_str) {
            Some("user") if out["task_tokens"].as_i64().unwrap_or(0) == 0 => {
                out["task_tokens"] = json!(tokens(m)); // the first user message is the task
            }
            Some("assistant") => {
                out["steps"] = json!(out["steps"].as_i64().unwrap_or(0) + 1);
                let mut step_tokens = tokens(m);
                // The tool output that follows the step is what the step made the context carry.
                if let Some(next) = msgs.get(i + 1) {
                    if matches!(next.get("role").and_then(Value::as_str), Some("tool") | Some("user")) {
                        step_tokens += tokens(next);
                    }
                }
                let actions: Vec<Value> = m.pointer("/extra/actions").and_then(Value::as_array).cloned().unwrap_or_default();
                let commands_here: Vec<String> = actions.iter().filter_map(|a| a.get("command").and_then(Value::as_str).map(String::from)).collect();
                let discovery = !commands_here.is_empty() && commands_here.iter().all(|c| is_discovery(c));
                if discovery {
                    out["discovery_steps"] = json!(out["discovery_steps"].as_i64().unwrap_or(0) + 1);
                    out["discovery_tokens"] = json!(out["discovery_tokens"].as_i64().unwrap_or(0) + step_tokens);
                } else {
                    out["work_steps"] = json!(out["work_steps"].as_i64().unwrap_or(0) + 1);
                    out["work_tokens"] = json!(out["work_tokens"].as_i64().unwrap_or(0) + step_tokens);
                }
                out["output_tokens"] = json!(out["output_tokens"].as_i64().unwrap_or(0) + step_tokens);
                for c in commands_here {
                    let label = command_label(&c);
                    match commands.iter_mut().find(|(w, _)| *w == label) {
                        Some((_, n)) => *n += 1,
                        None => commands.push((label, 1)),
                    }
                }
            }
            _ => {}
        }
    }
    commands.sort_by(|a, b| b.1.cmp(&a.1).then(a.0.cmp(&b.0)));
    out["commands"] = json!(commands.iter().map(|(w, n)| json!({"command": w, "count": n})).collect::<Vec<_>>());
    // A brief that hands the discoveries over costs a fraction of re-discovering them: the
    // rule of thumb of the plan is one line of brief per finding (~10% of the discovery tokens).
    let discovery = out["discovery_tokens"].as_i64().unwrap_or(0);
    out["brief_tokens_estimate"] = json!((discovery as f64 * 0.1).round() as i64);
    out["cold_start_waste_tokens"] = json!(discovery);
    Ok(out)
}

pub fn text(v: &Value) -> String {
    let n = |k: &str| v[k].as_i64().unwrap_or(0);
    let mut out = format!(
        "cold-start metrics for {}\n  steps {} (discovery {}, work {}) · ~{} tokens (discovery ~{}, work ~{}, task ~{})\n  a brief with the discoveries would cost ~{} tokens instead of ~{} of re-discovery\n  commands:",
        v["journal"].as_str().unwrap_or(""),
        n("steps"),
        n("discovery_steps"),
        n("work_steps"),
        n("output_tokens"),
        n("discovery_tokens"),
        n("work_tokens"),
        n("task_tokens"),
        n("brief_tokens_estimate"),
        n("cold_start_waste_tokens"),
    );
    for c in v["commands"].as_array().cloned().unwrap_or_default() {
        out.push_str(&format!(" {}×{}", c["command"].as_str().unwrap_or(""), c["count"].as_i64().unwrap_or(0)));
    }
    out
}

pub fn client(args: &[String]) -> i32 {
    let mut json_out = false;
    let mut journal = None;
    for a in args {
        match a.as_str() {
            "--json" => json_out = true,
            "-h" | "--help" => {
                println!("mini-agent-rs metrics <traj.jsonl> [--json] — cold-start metrics of a journal:\n  discovery (read-only commands) vs work: steps, ~tokens, and what a brief would cost");
                return 0;
            }
            _ if journal.is_none() => journal = Some(a.clone()),
            other => {
                eprintln!("error: unexpected argument {other:?}");
                return 2;
            }
        }
    }
    let Some(journal) = journal else {
        eprintln!("error: metrics needs a journal (traj.jsonl)\n\nmini-agent-rs metrics <traj.jsonl> [--json]");
        return 2;
    };
    match measure(Path::new(&journal)) {
        Ok(v) => {
            if json_out {
                println!("{}", serde_json::to_string_pretty(&v).unwrap());
            } else {
                println!("{}", text(&v));
            }
            0
        }
        Err(e) => {
            eprintln!("error: {e}");
            1
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn discovery_vs_work() {
        assert!(is_discovery("ls -la"));
        assert!(is_discovery("grep -rn foo src"));
        assert!(is_discovery("cat a.rs | wc -l"));
        assert!(is_discovery("sed -n '1,5p' x"));
        assert!(is_discovery("git log --oneline -5"));
        assert!(!is_discovery("sed -i 's/a/b/' x"));
        assert!(!is_discovery("git commit -m x"));
        assert!(!is_discovery("cargo test"));
        assert!(!is_discovery("echo hi > f"));
        assert!(!is_discovery("rg foo && cargo build"));
        assert!(is_discovery("find . | xargs grep foo"));
        assert!(!is_discovery("find . | xargs rm -rf x"));
    }

    #[test]
    fn measures_a_journal() {
        let dir = std::env::temp_dir().join(format!("metrics-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let journal = dir.join("traj.jsonl");
        let msg = |m: Value| format!("{}\n", json!({"t": "msg", "m": m}));
        let mut lines = String::new();
        lines.push_str(&msg(json!({"role": "user", "content": "investigate the spawn code path"})));
        lines.push_str(&msg(json!({"role": "assistant", "content": "looking", "extra": {"actions": [{"command": "grep -rn spawn agent-rs/src"}]}})));
        lines.push_str(&msg(json!({"role": "tool", "content": "found 12 matches in 4 files ..."})));
        lines.push_str(&msg(json!({"role": "assistant", "content": "editing", "extra": {"actions": [{"command": "cargo test"}]}})));
        lines.push_str(&msg(json!({"role": "tool", "content": "test result: ok"})));
        std::fs::write(&journal, lines).unwrap();
        let v = measure(&journal).unwrap();
        assert_eq!(v["steps"].as_i64().unwrap(), 2);
        assert_eq!(v["discovery_steps"].as_i64().unwrap(), 1);
        assert_eq!(v["work_steps"].as_i64().unwrap(), 1);
        assert!(v["discovery_tokens"].as_i64().unwrap() > 0);
        assert_eq!(v["task_tokens"].as_i64().unwrap() > 0, true);
        assert_eq!(v["commands"][0]["command"].as_str().unwrap(), "cargo test");
        assert_eq!(command_label("git log --oneline -5"), "git log");
    }
}
