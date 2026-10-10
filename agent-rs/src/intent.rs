//! Cheap local intent classification of the first task: is this a request that can be answered
//! straight away, or does it need the machine?
//!
//! Priority 1 of the pi-parity round-3: a greeting or a general question ("hola", "qué puedes
//! hacer?") used to make the agent go explore the repository --- globs and greps for nothing ---
//! because the instance prompt tells it to "locate the relevant files" and to finish with a tool
//! call. On the round-2 benchmark that is invisible (every task there is real work), but on the
//! interactive paths it is the difference between one model call and five.
//!
//! The test is deliberately local and free: a few regex-free keyword checks over the normalized
//! task, no model call, no extra tokens, no latency. A false negative costs exactly what the run
//! cost before this file existed (the normal loop handles it), so the classifier is tuned to be
//! eager: it only claims "trivial" when nothing in the text suggests work on a computer.
//!
//! `MINI_AGENT_FASTPATH=0` turns it off for a run that must always take the full loop.

use serde_json::Value;

/// What the first task looks like.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Intent {
    /// A greeting, thanks, small talk, a question about the assistant itself or general
    /// knowledge: answerable in one model call with no tools at all.
    Conversational,
    /// Real work on this machine: read, run, change, test, report numbers. The normal loop.
    Task,
}

/// The fast path is on unless a run turns it off (`MINI_AGENT_FASTPATH=0`).
pub fn enabled() -> bool {
    match std::env::var("MINI_AGENT_FASTPATH") {
        Ok(v) => v != "0",
        Err(_) => true,
    }
}

/// Words that mean "there is a machine involved". Any of them anywhere in the task forces the
/// full loop, whatever else the text looks like. They are matched on word boundaries against the
/// normalized text (lowercase, punctuation collapsed to single spaces).
const WORK_MARKERS: &[&str] = &[
    // files, code, the shell
    "file", "files", "code", "repo", "repository", "script", "program", "function", "class",
    "test", "tests", "compile", "build", "install", "dependency", "dependencies", "package",
    "module", "import", "variable", "syntax", "bug", "error", "exception", "stacktrace",
    "stack trace", "failing", "fails", "failed", "fix", "debug", "refactor", "implement",
    "patch", "commit", "branch", "merge", "rebase", "diff", "lint", "typecheck",
    // the shell / the machine
    "bash", "shell", "script", "terminal", "command", "run", "execute", "launch", "server",
    "service", "process", "docker", "git", "npm", "pip", "cargo", "make", "grep", "glob",
    "path", "directory", "folder", "disk", "cpu", "memory", "port", "log", "logs", "config",
    "configuration", "env", "environment variable", "database", "sql", "api", "endpoint",
    "deploy", "install", "upgrade", "python", "javascript", "typescript", "rust", "node", "npm",
    "json", "yaml", "toml", "csv", "regex", "stdout", "stderr", "permission", "chmod", "cron",
    // asking for a report of numbers about something on disk
    "report", "report.json", "summary", "count", "counts", "number of", "how many", "top",
    "answer.json", "output", "output.json", "csv", "analyze", "analyse", "compute", "calculate",
    "recalculate", "parse", "extract", "rewrite", "update", "change", "modify", "create",
    "generate", "produce", "write a", "write the", "convert", "migrate", "port", "clean up",
    "cleanup", "rename", "move", "delete", "remove", "add a", "add the", "apply", "restore",
];

/// Words that mark the text as a *question about the conversation or the assistant*, which is the
/// other half of the conversational set: they never imply a machine.
const CHAT_MARKERS: &[&str] = &[
    "hello", "hi", "hey", "hola", "buenas", "good morning", "good afternoon", "good evening",
    "good night", "thanks", "thank you", "cheers", "bye", "goodbye", "see you", "how are you",
    "how are things", "who are you", "what are you", "what can you do", "what do you do",
    "how do you work", "how do i use you", "help me understand", "nice to meet",
];

/// Lowercase, collapse whitespace and punctuation runs to single spaces, strip markdown fences.
fn normalize(task: &str) -> String {
    let mut out = String::with_capacity(task.len());
    let mut space = false;
    for ch in task.chars() {
        if ch.is_alphanumeric() {
            out.extend(ch.to_lowercase());
            space = false;
        } else if ch == '\'' || ch == '\u{2019}' {
            // keep intra-word apostrophes ("what's") together
        } else if ch == '.' || ch == '/' || ch == '-' || ch == '_' || ch == '@' || ch == '#' {
            // a separator, but one that may sit inside a marker ("top-5", "node.js")
            if !space {
                out.push(' ');
                space = true;
            }
        } else {
            if !space && !out.is_empty() {
                out.push(' ');
                space = true;
            }
        }
    }
    out.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// True when `needle` appears in `hay` on word boundaries.
fn contains_word(hay: &str, needle: &str) -> bool {
    if needle.contains(' ') {
        // Multi-word markers: a substring check against the space-padded text is enough,
        // because the haystack was normalized to single spaces.
        return hay.contains(needle);
    }
    let padded = format!(" {hay} ");
    let mut from = 0usize;
    while let Some(at) = padded[from..].find(needle) {
        let start = from + at;
        let end = start + needle.len();
        let left_ok = start == 0 || padded.as_bytes()[start - 1] == b' ';
        let right_ok = end == padded.len() || padded.as_bytes()[end] == b' ';
        if left_ok && right_ok {
            return true;
        }
        from = start + 1;
        if from >= padded.len() {
            break;
        }
    }
    false
}

/// Classify the first task. `Conversational` only when there is no work marker anywhere and the
/// text is either a chat marker, a short question, or clearly conversational in shape.
pub fn classify(task: &str) -> Intent {
    if !enabled() {
        return Intent::Task;
    }
    let text = normalize(task);
    if text.is_empty() {
        return Intent::Task;
    }
    // Any work marker anywhere wins: one "run the tests" in a greeting is still a task.
    if WORK_MARKERS.iter().any(|m| contains_word(&text, m)) {
        return Intent::Task;
    }
    // A code fence, a path or an explicit tool name is work even without a keyword.
    if task.contains("```") || task.contains("~/") || task.contains("/home/") || task.contains("$ ") {
        return Intent::Task;
    }
    let words = text.split(' ').count();
    if CHAT_MARKERS.iter().any(|m| contains_word(&text, m)) {
        return Intent::Conversational;
    }
    // A short question with no work marker is a question about the world, not about the machine.
    let question = task.contains('?') || text.starts_with("que ") || text.starts_with("qué ")
        || text.starts_with("como ") || text.starts_with("qué ") || text.starts_with("cuanto ")
        || text.starts_with("cuál") || text.starts_with("which ") || text.starts_with("what ")
        || text.starts_with("who ") || text.starts_with("when ") || text.starts_with("where ")
        || text.starts_with("why ") || text.starts_with("how ") || text.starts_with("can you ")
        || text.starts_with("do you ") || text.starts_with("are you ") || text.starts_with("is ");
    if question && words <= 40 {
        return Intent::Conversational;
    }
    // A very short imperative with no work marker ("hola", "gracias", "eres una IA?") is chat.
    if words <= 6 && !task.contains('\n') {
        return Intent::Conversational;
    }
    Intent::Task
}

/// The system prompt of the fast path: no tool list, no workflow, no "you must call a tool".
/// Keeping it minimal matters --- it is the whole prompt a trivial turn pays for.
pub fn direct_system() -> &'static str {
    "You are a helpful assistant. Answer the user's message directly, in plain text. \
     You have no tools and cannot read or change files, so never claim to have: if the message \
     needs the machine, say what you would need instead."
}

/// The user message of the fast path: the task as it arrived, plus the one line that makes the
/// no-tool request explicit so the model does not invent a tool call or an apology loop.
pub fn direct_user(task: &str) -> String {
    format!("{task}\n\n(Answer in plain text. No tools are available in this reply.)")
}

/// Whether the fast path produced something usable as the run's final answer.
pub fn usable_answer(text: &str) -> bool {
    let trimmed = text.trim();
    !trimmed.is_empty() && trimmed.chars().count() > 1
}

/// The `extra` a fast-path answer carries, so a trajectory read by the same tools (the web UI,
/// the benchmark's `mini_info`, the journal) sees a normal finished run: no actions (the model
/// called nothing) and the marker that says which path answered.
pub fn answer_extra(cost: f64) -> Value {
    serde_json::json!({
        "actions": [],
        "cost": cost,
        "fastpath": true,
        "fastpath_intent": "conversational",
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn is_conv(task: &str) -> bool {
        classify(task) == Intent::Conversational
    }

    #[test]
    fn greetings_and_questions_are_conversational() {
        assert!(is_conv("hola"));
        assert!(is_conv("hello!"));
        assert!(is_conv("Hi there, how are you?"));
        assert!(is_conv("thanks, that was useful"));
        assert!(is_conv("who are you?"));
        assert!(is_conv("what can you do?"));
        assert!(is_conv("¿Qué puedes hacer?"));
    }

    #[test]
    fn work_always_wins() {
        assert!(!is_conv("hola, run the tests please"));
        assert!(!is_conv("hello, can you fix the bug in cart.js?"));
        assert!(!is_conv("what does this repo do? read the README and tell me"));
        assert!(!is_conv("hi\n\nplease list the files in the current directory"));
    }

    #[test]
    fn benchmark_tasks_are_never_conversational() {
        let tasks = [
            "# Task: top-5 words in a stress log\n\nWrite answer.json with the five most frequent tokens.",
            "Make `shop/prices.py` match its docstring: raise ValueError and round to 2 decimals.",
            "Fix the discount tiers in cart.js: the boundary is >= not >.",
            "Finish the wordcount.py CLI: it has TODOs in the skeleton.",
            "Produce report.json with the ERROR breakdown of logs/service.log.",
        ];
        for t in tasks {
            assert_eq!(classify(t), Intent::Task, "{t}");
        }
    }

    #[test]
    fn the_env_switch_turns_it_off() {
        std::env::set_var("MINI_AGENT_FASTPATH", "0");
        assert_eq!(classify("hola"), Intent::Task);
        std::env::remove_var("MINI_AGENT_FASTPATH");
        assert_eq!(classify("hola"), Intent::Conversational);
    }

    #[test]
    fn answers_must_carry_text() {
        assert!(usable_answer("hello there"));
        assert!(!usable_answer("   "));
    }
}