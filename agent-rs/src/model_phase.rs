//! Fusion: one session, several models, the strong model chooses who answers each step.
//!
//! Instead of delegating to a subagent (a new process with an empty context), the run keeps ONE
//! conversation and swaps the model that answers it. The base model (the run's `-m`, e.g. Opus)
//! reasons and plans. For each execution chunk it picks a worker model AND an effort from the
//! pool with `model_phase {model, effort, brief}`; the next steps are answered by that worker with
//! the full history in view. The worker calls `model_phase {model: "base", summary}` when done ---
//! or simply answers without a tool call, or runs out of its step budget --- and the base model
//! takes the conversation back to review and choose the next worker.
//!
//! Strict fusion (`MINI_AGENT_FUSION=1`, or a `strict` line in the config file): the base model
//! only thinks. It may `read` files and call `model_phase`; every shell or write action it issues
//! is refused with a pointer to hand it to a worker.
//!
//! The pool (first source found wins; `name=` is an optional alias, `| note` an optional hint):
//!   * `MINI_AGENT_FUSION_MODELS="build=zai/glm-5.3 | components, cliproxy/claude-haiku-5-5 | quick bash"`
//!   * `MINI_AGENT_MODEL_PHASES` (same format; the first version of this feature)
//!   * `~/.config/mini-tui/fusion` (one entry per line, `#` comments, `strict` line)
//!
//! `MINI_AGENT_MODEL_PHASE_MAX_STEPS` (default 40) bounds one worker turn. The tool only exists
//! when the pool is not empty, so a bare run is unchanged.

use serde_json::{json, Value};

pub const TOOL: &str = "model_phase";
pub const BASE: &str = "base";
pub const EFFORTS: [&str; 8] = ["auto", "off", "minimal", "low", "medium", "high", "xhigh", "max"];

#[derive(Debug, Clone, PartialEq)]
pub struct Worker {
    pub alias: Option<String>,
    pub model: String,
    pub note: String,
}

fn file_raw() -> Option<String> {
    std::fs::read_to_string(crate::config::home().join(".config/mini-tui/fusion")).ok()
}

fn raw() -> String {
    let env = |k: &str| std::env::var(k).ok().filter(|s| !s.trim().is_empty());
    env("MINI_AGENT_FUSION_MODELS").or_else(|| env("MINI_AGENT_MODEL_PHASES")).or_else(file_raw).unwrap_or_default()
}

pub fn pool() -> Vec<Worker> {
    parse(&raw())
}

pub fn parse(raw: &str) -> Vec<Worker> {
    raw.split([',', '\n'])
        .filter_map(|entry| {
            let entry = entry.trim();
            if entry.is_empty() || entry.starts_with('#') || entry.eq_ignore_ascii_case("strict") {
                return None;
            }
            let (head, note) = entry.split_once('|').map(|(h, n)| (h.trim(), n.trim())).unwrap_or((entry, ""));
            let (alias, model) = match head.split_once('=') {
                Some((a, m)) => (Some(a.trim().to_lowercase()).filter(|a| !a.is_empty()), m.trim()),
                None => (None, head),
            };
            if model.is_empty() || alias.as_deref() == Some(BASE) || model == BASE {
                return None;
            }
            Some(Worker { alias, model: model.to_string(), note: note.to_string() })
        })
        .collect()
}

/// The model a `model_phase` target names: a pool model id or one of its aliases.
pub fn resolve(target: &str) -> Option<String> {
    let t = target.trim();
    pool().into_iter().find(|w| w.model == t || w.alias.as_deref() == Some(&t.to_lowercase())).map(|w| w.model)
}

static SCRIPTED_RUN: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

/// A scripted (deterministic test) model is driving this run. The pool from the user's config
/// file must not change what such a run does; an explicit `MINI_AGENT_FUSION_MODELS` still applies.
pub fn mark_scripted_run() {
    SCRIPTED_RUN.store(true, std::sync::atomic::Ordering::SeqCst);
}

pub fn enabled() -> bool {
    if SCRIPTED_RUN.load(std::sync::atomic::Ordering::SeqCst) && std::env::var("MINI_AGENT_FUSION_MODELS").map_or(true, |v| v.trim().is_empty()) {
        return false;
    }
    std::env::var_os("MINI_AGENT_DEPTH").is_none() && !crate::queue_tools::dispatcher() && !pool().is_empty()
}

/// The base model only thinks: shell and write actions are refused outside a worker phase.
pub fn strict() -> bool {
    if !enabled() {
        return false;
    }
    match std::env::var("MINI_AGENT_FUSION").as_deref() {
        Ok("1") | Ok("true") | Ok("strict") => true,
        Ok("0") | Ok("false") => false,
        _ => file_raw().is_some_and(|r| r.lines().any(|l| l.trim().eq_ignore_ascii_case("strict"))),
    }
}

/// Tools the base model may still run itself under strict fusion. `code`/`codejs` scripts run
/// read-only: their `bash`, `write` and `edit` calls are refused (see `script_read_only`).
pub fn base_may_run(tool: Option<&str>) -> bool {
    matches!(tool, Some("read") | Some("code") | Some("codejs") | Some(TOOL))
}

pub const REFUSAL: &str = "Strict fusion: the main model does not run shell, write or edit actions (scripts are read-only for it). Call model_phase with the worker and effort that fit this step and a precise brief.";

static SCRIPT_READ_ONLY: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

static SCRIPT_REFUSED: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);

/// True while the main model's script runs under strict fusion: writes and shell are refused.
/// Each check that answers true is a refused call, counted for the script's observation.
pub fn script_read_only() -> bool {
    let on = SCRIPT_READ_ONLY.load(std::sync::atomic::Ordering::SeqCst);
    if on {
        SCRIPT_REFUSED.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
    }
    on
}

/// Calls refused in the current read-only script (reset by `ReadOnlyScript::begin`).
pub fn script_refused() -> usize {
    SCRIPT_REFUSED.load(std::sync::atomic::Ordering::SeqCst)
}

/// Mark the main model's script as read-only until the guard drops.
pub struct ReadOnlyScript;
impl ReadOnlyScript {
    pub fn begin() -> Self {
        SCRIPT_REFUSED.store(0, std::sync::atomic::Ordering::SeqCst);
        SCRIPT_READ_ONLY.store(true, std::sync::atomic::Ordering::SeqCst);
        ReadOnlyScript
    }
}
impl Drop for ReadOnlyScript {
    fn drop(&mut self) {
        SCRIPT_READ_ONLY.store(false, std::sync::atomic::Ordering::SeqCst);
    }
}

/// Appended to the run's system prompt (and to a resumed turn's task) under strict fusion, so
/// the main model plans with workers from its first step instead of learning by refusal.
pub fn system_note() -> String {
    if !strict() {
        return String::new();
    }
    "\n\n<fusion>You are the main model of a fusion run: you reason, plan, read files (read, or read-only code/codejs scripts) and review. You never run shell commands, writes or edits yourself. For every execution step call model_phase with the worker and effort that fit that step (cheapest that can do it well) and a precise brief; review when control returns: the return note lists the files the worker changed, so read the ones that matter before you accept its summary. These limits bind only the main model: a worker named in a [fusion handoff] has full tools until it hands back.</fusion>".into()
}

pub fn is_tool(name: &str) -> bool {
    name == TOOL && enabled()
}

pub fn max_steps() -> usize {
    std::env::var("MINI_AGENT_MODEL_PHASE_MAX_STEPS").ok().and_then(|v| v.parse().ok()).filter(|n: &usize| *n > 0).unwrap_or(40)
}

fn description() -> String {
    let list = pool()
        .iter()
        .map(|w| {
            let alias = w.alias.as_ref().map(|a| format!(" (alias `{a}`)")).unwrap_or_default();
            let note = if w.note.is_empty() { String::new() } else { format!(": {}", w.note) };
            format!("- `{}`{alias}{note}", w.model)
        })
        .collect::<Vec<_>>()
        .join("\n");
    let strict = if strict() {
        "\nSTRICT FUSION: as the main model you only think and read. Every shell command, write or edit must be done by a worker you choose here."
    } else {
        ""
    };
    format!(
        "Fusion: hand the SAME conversation to a worker model for one bounded chunk, then take it back. \
No subagent, no new context: the next steps are answered by the chosen model with this full history.\n\
Main model: reason and plan yourself. For each execution step choose the cheapest worker AND effort that can do it well \
(trivial bash/listing: fastest model, effort low; a component or refactor: a strong coder, effort medium/high), \
and give a precise `brief` (files, contract, acceptance check). Review after control returns.\n\
Worker: do only the brief, then call this with model `{BASE}` and a short `summary` of what changed and how it was checked.\n\
Workers:\n{list}{strict}\nCall it alone, not batched with other tools."
    )
}

fn params() -> Value {
    let mut names: Vec<String> = pool().into_iter().flat_map(|w| std::iter::once(w.model).chain(w.alias)).collect();
    names.push(BASE.into());
    json!({
        "type": "object",
        "properties": {
            "model": {"type": "string", "enum": names, "description": "The worker model to hand the next steps to, or `base` to return."},
            "effort": {"type": "string", "enum": EFFORTS, "description": "Reasoning effort for the worker; `auto` keeps the provider default."},
            "brief": {"type": "string", "description": "Entering a worker: exactly what it must do and how to check it."},
            "summary": {"type": "string", "description": "Returning to base: what was done, files touched, checks run."}
        },
        "required": ["model"]
    })
}

pub fn with_chat(mut base: Vec<Value>) -> Vec<Value> {
    if enabled() {
        base.push(json!({"type": "function", "function": {"name": TOOL, "description": description(), "parameters": params()}}));
    }
    base
}
pub fn with_responses(mut base: Vec<Value>) -> Vec<Value> {
    if enabled() {
        base.push(json!({"type": "function", "name": TOOL, "description": description(), "parameters": params()}));
    }
    base
}
pub fn with_anthropic(mut base: Vec<Value>) -> Vec<Value> {
    if enabled() {
        base.push(json!({"name": TOOL, "description": description(), "input_schema": params()}));
    }
    base
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parses_aliases_notes_and_skips_base() {
        let p = parse("build=glm-5.3 | components, cliproxy/claude-haiku-5-5\nbase=x\n# c\nstrict\n");
        assert_eq!(p, vec![
            Worker { alias: Some("build".into()), model: "glm-5.3".into(), note: "components".into() },
            Worker { alias: None, model: "cliproxy/claude-haiku-5-5".into(), note: String::new() },
        ]);
    }

    #[test]
    fn base_whitelist() {
        assert!(base_may_run(Some("read")) && base_may_run(Some(TOOL)) && base_may_run(Some("codejs")));
        assert!(!base_may_run(None) && !base_may_run(Some("write")));
    }
}
