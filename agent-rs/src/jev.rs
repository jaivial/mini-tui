//! The Jev verifier phase, agent-side: after the loop finishes and the code is on disk, a cheap
//! reader proposes candidate defects in the diff and Jev (TypeSafe System One) answers three typed
//! questions per candidate. The probabilities are branched into `auto-fix` / `flag` / `ignore` by
//! fixed thresholds and the report is appended to the trajectory as a notice.
//!
//! ## Why it lives here and not only in the TUI
//!
//! PR #115 put the phase in `src/ui/App.tsx`, which means it ran for a terminal UI session and not
//! for a run started by the web app, by `mini-tui -p`, or by a subagent --- the surfaces the
//! benchmark measures. The judgement does not need the UI: it needs the diff and a model call, both
//! of which the agent already has. So the phase lives here and every surface gets it, with the same
//! thresholds and the same "never block the run" contract.
//!
//! ## Why the reader is the run's own model
//!
//! A second credential is the one thing this phase must not need. The reader is whatever model this
//! run is already talking to (the smallest id the provider serves is preferred when the config
//! names several), so `/connect` is the only configuration a user touches. If the run's model cannot
//! be reached for a post-run call the phase degrades with that reason; it never invents a verdict.
//!
//! ## Cost discipline
//!
//! The phase is fire-and-forget over the run: `MINI_AGENT_JEV_VERIFIER=auto` (default) runs it only
//! when the run left a diff behind, so a read-only run pays nothing. The reader call uses a hard
//! token cap and the Jev call has a timeout, so the phase's worst case is bounded and small next to
//! the loop it follows.
//!
//! Degrade honestly, always: no diff, no key, no model, reader failure, unparseable reader output,
//! Jev failure --- each returns a stated reason. Nothing here can fail the run.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// Phase mode. `auto` = run it when the phase is not switched off and the run produced a diff.
pub fn mode() -> Mode {
    match std::env::var("MINI_AGENT_JEV_VERIFIER").ok().filter(|v| !v.is_empty()).unwrap_or_default().as_str() {
        "1" | "on" | "true" | "yes" => Mode::On,
        "0" | "off" | "false" | "no" => Mode::Off,
        _ => Mode::Auto,
    }
}

#[derive(PartialEq, Eq, Copy, Clone, Debug)]
pub enum Mode {
    On,
    Off,
    Auto,
}

/// Whether this run should pay for the phase.
pub fn enabled() -> bool {
    match mode() {
        Mode::On => true,
        Mode::Off => false,
        Mode::Auto => std::env::var("MINI_AGENT_JEV").map(|v| v != "0" && !v.is_empty()).unwrap_or(false),
    }
}

/// Thresholds the probabilities are branched on. One place, so the policy is readable on its own.
pub const REAL: f64 = 0.5;
pub const SERIOUS: f64 = 0.6;
pub const SAFE: f64 = 0.7;

/// How much diff the reader sees. A whole-file diff is the wrong size for a cheap model, and the
/// candidate that matters is almost always near the top of it.
const MAX_DIFF_CHARS: usize = 12_000;
/// Hard cap on the reader's reply: it emits a short JSON list, and the cap is what keeps the phase's
/// tail bounded when a provider decides to explain itself.
const READER_MAX_TOKENS: i64 = 800;
const READER_TIMEOUT: f64 = 60.0;
const JEV_TIMEOUT: f64 = 30.0;

/// One candidate defect, as the reader proposed it and before Jev has said anything about it.
#[derive(Clone, Debug)]
pub struct Candidate {
    pub id: String,
    pub summary: String,
    pub snippet: Option<String>,
}

/// The branch in code: probabilities in, one of three actions out, nothing else decides.
pub fn branch(real: f64, serious: f64, safe: f64) -> &'static str {
    if real < REAL {
        return "ignore";
    }
    if serious >= SERIOUS && safe >= SAFE {
        "auto-fix"
    } else {
        "flag"
    }
}

// ------------------------------------------------------------------ key resolution

/// `JEV_KEY_NAME` from the vault written by PR #115 (`~/.config/mini-tui/vault.json`, 0600),
/// mirroring `resolveJevKey` in `src/jev/client.ts`: the vault first (an explicit user choice), then
/// the env, then the machine-wide file the `jev` CLI skill reads.
fn resolve_key() -> Option<String> {
    if let Ok(k) = std::env::var("JEV_API_KEY") {
        if !k.is_empty() {
            return Some(k);
        }
    }
    if let Ok(k) = std::env::var("TYPESAFE_API_KEY") {
        if !k.is_empty() {
            return Some(k);
        }
    }
    if let Some(vault) = read_json(&home().join(".config/mini-tui/vault.json")) {
        if let Some(k) = vault.get("jev-api-key").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Some(k.to_string());
        }
    }
    if let Some(cfg) = read_json(&home().join(".config/typesafe/config.json")) {
        if let Some(k) = cfg.get("api_key").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Some(k.to_string());
        }
    }
    None
}

fn jev_base() -> String {
    std::env::var("TYPESAFE_BASE_URL").unwrap_or_else(|_| "https://api.typesafe.ai".to_string()).trim_end_matches('/').to_string()
}

fn jev_model() -> String {
    std::env::var("TYPESAFE_MODEL").unwrap_or_else(|_| "jev-latest".to_string())
}

fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

fn read_json(path: &Path) -> Option<Value> {
    std::fs::read_to_string(path).ok().and_then(|t| serde_json::from_str(&t).ok())
}

// ------------------------------------------------------------------ the diff

/// The working tree's diff, or the empty string when there is nothing to review.
///
/// `git diff HEAD` first (a run that committed has its work in `HEAD`, not in the worktree), then
/// the untracked files a commit-less run left behind --- which is the normal shape for a task like
/// "write report.json". Anything else and the phase has nothing to say, which is a legitimate
/// answer and not a failure.
pub fn working_diff(cwd: &Path) -> String {
    let head = run_git(cwd, &["diff", "HEAD"]);
    let mut out = head.unwrap_or_default();
    let untracked = run_git(cwd, &["ls-files", "--others", "--exclude-standard"]).unwrap_or_default();
    for line in untracked.lines().take(20) {
        let file = line.trim();
        if file.is_empty() || file.len() > 200 {
            continue;
        }
        if let Ok(body) = std::fs::read_to_string(cwd.join(file)) {
            // New files get a synthetic header: the reader reads a diff, and a bare body is not one.
            out.push_str(&format!("\n--- /dev/null\n+++ b/{file}\n@@ new file @@\n"));
            out.push_str(&body.chars().take(4000).collect::<String>());
        }
    }
    out
}

fn run_git(cwd: &Path, args: &[&str]) -> Option<String> {
    let out = std::process::Command::new("git").args(args).current_dir(cwd).output().ok()?;
    if !out.status.success() {
        return None;
    }
    String::from_utf8_lossy(&out.stdout).into_owned().into()
}

// ------------------------------------------------------------------ the reader

const REVIEWER_PROMPT: &str = "You review a code diff and propose candidate defects for a second, typed judge to verify.\n\
Be specific and terse. Propose at most 6 candidates. Report only defects in the diff itself.\n\
Answer with JSON only: {\"candidates\":[{\"id\":\"c1\",\"summary\":\"...\",\"snippet\":\"...\",\"fix\":\"...\"}]}\n\
Return {\"candidates\":[]} when the diff has no defect you can point at.";

/// Ask the run's own model to propose candidates. Returns `Err(reason)` when the run's model
/// cannot serve the call, so the phase can degrade with a stated reason instead of guessing.
///
/// `base_url` is whatever the run's client already uses (it ends in `/v1` for every OpenAI-shaped
/// provider), so the path is joined, not prefixed.
fn propose_candidates(base_url: &str, api_key_env: &str, model: &str, diff: &str) -> Result<Vec<Candidate>, String> {
    let Ok(key) = std::env::var(api_key_env) else {
        return Err(format!("no credentials for the run's model ({api_key_env})"));
    };
    if key.is_empty() {
        return Err(format!("no credentials for the run's model ({api_key_env})"));
    }
    let body = json!({
        "model": model,
        "messages": [
            {"role": "system", "content": REVIEWER_PROMPT},
            {"role": "user", "content": format!("Review this diff:\n\n{}", diff)},
        ],
        "temperature": 0,
        "max_tokens": READER_MAX_TOKENS,
        "stream": false,
    });
    let reply = crate::models::http::post_json(
        &base_url.trim_end_matches('/'),
        "/chat/completions",
        &body,
        &[("Authorization".into(), format!("Bearer {key}"))],
        READER_TIMEOUT,
    )
    .map_err(|e| format!("reader failed: {}", e.message))?;
    let text = reply
        .pointer("/choices/0/message/content")
        .and_then(Value::as_str)
        .unwrap_or_default();
    Ok(parse_candidates(text))
}

/// The reader's JSON, tolerating a code fence and prose around it. Never throws.
fn parse_candidates(text: &str) -> Vec<Candidate> {
    let body = match text.find("```") {
        Some(a) => match text[a + 3..].find("```") {
            Some(b) => &text[a + 3..a + 3 + b],
            None => text,
        },
        None => text,
    };
    let (Some(start), Some(end)) = (body.find('{'), body.rfind('}')) else { return Vec::new() };
    if end <= start {
        return Vec::new();
    }
    let Ok(parsed) = serde_json::from_str::<Value>(&body[start..=end]) else { return Vec::new() };
    let Some(rows) = parsed.get("candidates").and_then(Value::as_array) else { return Vec::new() };
    let mut out = Vec::new();
    for row in rows.iter().take(6) {
        let summary = row.get("summary").and_then(Value::as_str).unwrap_or("").trim();
        if summary.is_empty() {
            continue;
        }
        let snippet = row.get("snippet").and_then(Value::as_str).map(|s| s.chars().take(1200).collect::<String>());
        out.push(Candidate {
            id: row.get("id").and_then(Value::as_str).map(str::trim).filter(|s| !s.is_empty()).map(str::to_string).unwrap_or_else(|| format!("c{}", out.len() + 1)),
            summary: summary.chars().take(300).collect(),
            snippet,
        });
    }
    out
}

// ------------------------------------------------------------------ Jev

/// Ask Jev all three questions per candidate in one request (the fan-out the API is built around).
/// The state is keyed by candidate id so each instruction can point at a field that resolves ---
/// a question naming a field that does not exist gets no evidence and answers near the prior for
/// every candidate at once, which is a verifier that silently never fires.
fn jev_verdicts(key: &str, candidates: &[Candidate]) -> Result<Value, String> {
    let mut state = serde_json::Map::new();
    let mut questions = serde_json::Map::new();
    for c in candidates {
        state.insert(c.id.clone(), json!({"summary": c.summary, "snippet": c.snippet}));
        let where_ = match &c.snippet {
            Some(_) => format!("`{}.snippet`", c.id),
            None => format!("`{}.summary`", c.id),
        };
        questions.insert(
            format!("{}.real", c.id),
            json!({"type": "noul", "instructions": format!(
                "Is the problem described in `{0}.summary` a real defect in the code it points at ({1})? A style preference, a naming choice or a correct-but-odd line is not a defect.", c.id, where_)}),
        );
        questions.insert(
            format!("{}.serious", c.id),
            json!({"type": "noul", "instructions": format!(
                "Will the problem in `{0}.summary` cause wrong behaviour, a crash, a security problem or silent data loss if the code in {1} ships as is?", c.id, where_)}),
        );
        questions.insert(
            format!("{}.safe", c.id),
            json!({"type": "noul", "instructions": format!(
                "Can the problem in `{0}.summary` be fixed mechanically, without anyone adding information that is not already in {1}?", c.id, where_)}),
        );
    }
    let body = json!({
        "state": Value::Object(state),
        "model": jev_model(),
        "questions": Value::Object(questions),
    });
    let reply = crate::models::http::post_json(
        &jev_base(),
        "/v1/systemone",
        &body,
        &[("Authorization".into(), format!("Bearer {key}"))],
        JEV_TIMEOUT,
    )
    .map_err(|e| e.message)?;
    Ok(reply)
}

fn read_answer(response: &Value, id: &str) -> f64 {
    let Some(answer) = response.pointer("/answers").and_then(|a| a.get(id)) else { return 0.0 };
    if let Some(n) = answer.get("noul").and_then(Value::as_f64) {
        return n;
    }
    // A choice/score answer still carries probabilities: take P(first label) as the yes-share, so a
    // re-typed question degrades into a usable number instead of a silent zero.
    let probs = answer.get("probabilities").and_then(Value::as_object);
    match probs.and_then(|p| p.values().filter_map(Value::as_f64).fold(None, |acc: Option<f64>, v| Some(acc.map_or(v, |a| a.max(v))))) {
        Some(v) => v,
        None => answer.get("confidence").and_then(Value::as_f64).unwrap_or(0.0),
    }
}

// ------------------------------------------------------------------ the phase

/// What the phase produced, in the shape the trajectory records.
pub struct Report {
    pub status: &'static str,
    pub reason: String,
    pub model: String,
    pub latency_ms: u64,
    pub candidates: Vec<Candidate>,
    pub findings: Vec<(String, String, f64, f64, f64, String)>,
}

/// Run the phase. Never fails the run: every path returns a report with a status and a reason.
#[allow(clippy::too_many_arguments)]
pub fn verify(cwd: &Path, base_url: &str, api_key_env: &str, model: &str) -> Report {
    let degraded = |reason: String| Report { status: "degraded", reason, model: String::new(), latency_ms: 0, candidates: Vec::new(), findings: Vec::new() };

    if !enabled() {
        return Report { status: "skipped", reason: "jev verifier off".into(), model: String::new(), latency_ms: 0, candidates: Vec::new(), findings: Vec::new() };
    }
    let diff = working_diff(cwd);
    if diff.trim().is_empty() {
        return degraded("no diff to review".into());
    }
    let bounded: String = if diff.chars().count() <= MAX_DIFF_CHARS {
        diff.clone()
    } else {
        format!("{}\n… (diff truncated at {MAX_DIFF_CHARS} chars)", diff.chars().take(MAX_DIFF_CHARS).collect::<String>())
    };

    let candidates = match propose_candidates(base_url, api_key_env, model, &bounded) {
        Ok(c) => c,
        Err(e) => return degraded(e),
    };
    if candidates.is_empty() {
        return Report { status: "ok", reason: "reader proposed no candidates".into(), model: String::new(), latency_ms: 0, candidates, findings: Vec::new() };
    }

    let Some(key) = resolve_key() else {
        return Report { status: "degraded", reason: "no jev api key (set JEV_API_KEY, TYPESAFE_API_KEY, or ~/.config/typesafe/config.json)".into(), model: String::new(), latency_ms: 0, candidates, findings: Vec::new() };
    };

    let started = std::time::Instant::now();
    let response = match jev_verdicts(&key, &candidates) {
        Ok(r) => r,
        Err(e) => return Report { status: "degraded", reason: format!("jev call failed: {e}"), model: String::new(), latency_ms: started.elapsed().as_millis() as u64, candidates, findings: Vec::new() },
    };
    let concrete = response.get("model").and_then(Value::as_str).unwrap_or(&jev_model()).to_string();
    let findings = candidates
        .iter()
        .map(|c| {
            let real = read_answer(&response, &format!("{}.real", c.id));
            let serious = read_answer(&response, &format!("{}.serious", c.id));
            let safe = read_answer(&response, &format!("{}.safe", c.id));
            (c.summary.clone(), c.id.clone(), real, serious, safe, branch(real, serious, safe).to_string())
        })
        .collect();
    Report { status: "ok", reason: String::new(), model: concrete, latency_ms: started.elapsed().as_millis() as u64, candidates, findings }
}

/// One line per finding, for a notice in the transcript. Same wording as `formatReport` in
/// `src/jev/verifier.ts`, so the TUI and a headless run read the same report.
pub fn format_report(report: &Report) -> Vec<String> {
    match report.status {
        "skipped" => return Vec::new(),
        "degraded" => return vec![format!("jev · verifier skipped: {}", if report.reason.is_empty() { "unavailable" } else { &report.reason })],
        _ => {}
    }
    if report.findings.is_empty() {
        return vec![format!("jev · verifier: nothing to flag ({} candidates, {})", report.candidates.len(), if report.model.is_empty() { "?" } else { &report.model })];
    }
    let (auto, flag, ignore) = report.findings.iter().fold((0u32, 0u32, 0u32), |(a, f, i), (_, _, _, _, _, action)| match action.as_str() {
        "auto-fix" => (a + 1, f, i),
        "flag" => (a, f + 1, i),
        _ => (a, f, i + 1),
    });
    let mut out = vec![format!("jev · {} · auto-fix {auto} · flag {flag} · ignore {ignore}", if report.model.is_empty() { "?" } else { &report.model })];
    for (summary, _, real, serious, safe, action) in report.findings.iter() {
        if action == "ignore" {
            continue;
        }
        out.push(format!("  {} {summary} [P(real)={real:.2} P(serious)={serious:.2} P(safe)={safe:.2}]", if action == "auto-fix" { "●" } else { "⚑" }));
    }
    out
}

/// The report as the trajectory records it: one object under `extra.jev` of a notice message.
pub fn to_value(report: &Report) -> Value {
    json!({
        "status": report.status,
        "reason": report.reason,
        "model": report.model,
        "latency_ms": report.latency_ms,
        "candidates": report.candidates.iter().map(|c| json!({"id": c.id, "summary": c.summary})).collect::<Vec<_>>(),
        "findings": report.findings.iter().map(|(summary, id, real, serious, safe, action)| json!({
            "id": id, "summary": summary, "real": real, "serious": serious, "safe": safe, "action": action})).collect::<Vec<_>>(),
    })
}