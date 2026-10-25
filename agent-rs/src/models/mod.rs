//! Models: the direct HTTP clients (OpenAI chat completions, Anthropic Messages, OpenAI
//! Responses) behind the same routing the Python `get_model` does, plus the scripted
//! `deterministic` models the tests drive the agent with.

pub mod cache_control;
pub mod catalog;
pub mod connections;
pub mod deterministic;
pub mod go_catalog;
pub mod http;
pub mod prices;
pub mod shapes;
pub mod wire;

use crate::util::Obj;
use serde_json::{json, Value};

/// Why a model call failed. `abort` errors are not retried (bad key, unknown model, ...).
#[derive(Debug, Clone)]
pub struct ModelError {
    pub message: String,
    pub status: Option<u16>,
    pub abort: bool,
    /// The Python exception class name this corresponds to (for exit messages).
    pub kind: String,
    /// The TCP connect was refused: nothing is listening on that address. Retrying cannot
    /// start the service, and a local gateway comes back (or not) within seconds rather than
    /// minutes, so the retry policy treats it differently from a remote transport error.
    pub connect_refused: bool,
    /// Seconds the provider asked us to wait before trying again (`retry-after-ms` /
    /// `retry-after` on the error response), when it sent one. The server's own number beats
    /// any curve we could invent, so `with_retry` honours it verbatim (capped).
    pub retry_after: Option<f64>,
}

impl std::fmt::Display for ModelError {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.message)
    }
}

/// What one model call produced.
pub enum Reply {
    /// An assistant message (with `extra.actions`, `extra.cost`, maybe `extra.submission`).
    Message(Value),
    /// The reply was billed but unusable (no/invalid tool call): these messages go to the model.
    FormatError(Vec<Value>),
}

/// Receives streamed fragments ("thinking" | "text") while a reply is generated.
pub type DeltaSink<'a> = &'a mut dyn FnMut(&str, &str);

pub trait Model {
    fn query(&mut self, messages: &[Value], sink: Option<DeltaSink>) -> Result<Reply, ModelError>;
    /// One call with **no tool list at all** (the fast path of `src/intent.rs`): the model can
    /// only answer in text. Providers differ here --- GLM ignores `tool_choice: "none"` and would
    /// still emit tool calls (measured, speed8), which is why the flag is `text_only: "no_tools"`
    /// --- so the reply is still parsed by `query` and a caller that asked for text must check for
    /// `extra.actions` before believing it. The default is the normal call: a scripted model has no
    /// tool list to drop, and asking it the same question returns the same scripted answer.
    fn query_text(&mut self, messages: &[Value], sink: Option<DeltaSink>) -> Result<Reply, ModelError> {
        self.query(messages, sink)
    }
    /// Short tool-free closure judgement, with provider-specific output caps.
    fn query_judge(&mut self, messages: &[Value]) -> Result<Reply, ModelError> {
        self.query_text(messages, None)
    }
    fn format_message(&self, role: &str, content: &str, extra: Option<Obj>) -> Value;
    fn format_observation_messages(&self, message: &Value, outputs: &[Value], template_vars: &Value) -> Result<Vec<Value>, String>;
    fn template_vars(&self) -> Obj;
    fn serialize(&self) -> Value;
    fn model_name(&self) -> String;
    /// `config.context_window` (0 = look it up by id).
    fn context_window(&self) -> i64;
    /// `(chat base url, api key, the id the provider knows this model as)`.
    ///
    /// The verifier phase of `src/jev.rs` needs a reader and this is where it gets one for free: the
    /// model this run is already talking to, on the endpoint and with the credentials already in
    /// memory. A second provider to configure is the one thing an optional quality phase must not
    /// ask for. Scripted models return empty strings, which the phase treats as "no reader".
    fn reader_endpoint(&self) -> (String, String, String) {
        (String::new(), String::new(), String::new())
    }
    /// Streams partial output through the sink (the HTTP clients do; scripted models do not).
    fn streams(&self) -> bool {
        false
    }
    /// Replay the last request with a one-token output cap to keep its prompt-cache entry alive
    /// (the cache warmer, plan item 5). Returns the cost of the replay. The default is "not
    /// supported": a scripted model has no entry to keep warm, so the warmer stays idle for it.
    fn warm_cache(&mut self, _messages: &[Value]) -> Result<f64, String> {
        Err("this model cannot replay a request".into())
    }
    /// The price row that bills this model, as `(cache_read, cache_write, input, output)` per
    /// million tokens. Zeroes when unknown, which is the warmer's "economics unavailable" case.
    fn cache_prices(&self) -> (f64, f64, f64, f64) {
        (0.0, 0.0, 0.0, 0.0)
    }
    /// The prompt-cache TTL in seconds when the model's config pins one (`cache_ttl`), else
    /// `None`: without a known TTL the warmer would refresh on a guess.
    fn cache_ttl_secs(&self) -> Option<f64> {
        None
    }
}

/// `GLOBAL_MODEL_STATS` (`MSWEA_GLOBAL_COST_LIMIT` / `MSWEA_GLOBAL_CALL_LIMIT`): every model call
/// of the process counts, whatever the model; past a limit the call is an error, as in Python.
/// Adaptive thinking (`MINI_AGENT_THINKING=adaptive`): the agent loop says, before each call,
/// whether this turn needs reasoning. Routine steps (read, write, run the check, answer) go out
/// with thinking disabled; the turn after a failure (a non-zero exit, a format error, a repeated
/// action) gets the model's configured thinking back. Measured on the pi-vs-mini corpus: thinking
/// off made 9 of 10 tasks ~2x faster, and the 10th looped without it on a failing fix.
static THINK_NEXT: std::sync::atomic::AtomicBool = std::sync::atomic::AtomicBool::new(false);

pub fn set_think_next(on: bool) {
    THINK_NEXT.store(on, std::sync::atomic::Ordering::SeqCst);
}

/// True when this call must go out with thinking disabled.
pub fn thinking_suppressed() -> bool {
    std::env::var("MINI_AGENT_THINKING").as_deref() == Ok("adaptive") && !THINK_NEXT.load(std::sync::atomic::Ordering::SeqCst)
}

pub fn global_stats_add(cost: f64) -> Result<(), ModelError> {
    use std::sync::Mutex;
    static STATS: Mutex<(f64, i64)> = Mutex::new((0.0, 0));
    let cost_limit: f64 = std::env::var("MSWEA_GLOBAL_COST_LIMIT").ok().and_then(|s| s.parse().ok()).unwrap_or(0.0);
    let call_limit: i64 = std::env::var("MSWEA_GLOBAL_CALL_LIMIT").ok().and_then(|s| s.parse().ok()).unwrap_or(0);
    let mut st = STATS.lock().unwrap();
    st.0 += cost;
    st.1 += 1;
    if (cost_limit > 0.0 && cost_limit < st.0) || (call_limit > 0 && call_limit < st.1 + 1) {
        return Err(ModelError {
            message: format!("Global cost/call limit exceeded: ${:.4} / {}", st.0, st.1),
            status: None,
            abort: true,
            kind: "RuntimeError".into(), connect_refused: false, retry_after: None,
        });
    }
    Ok(())
}

/// Apply one abstract UI effort level using the selected provider's actual wire vocabulary.
/// Unknown/unsupported combinations are ignored: the deny-by-default TypeScript catalogue is
/// the UI boundary, and this second check keeps hand-written environment settings safe.
pub fn apply_effort(model: &str, effort: &str, config: &mut Obj) {
    if effort.is_empty() || effort == "auto" { return; }
    let lower = model.to_ascii_lowercase();
    let provider = lower.split('/').next().unwrap_or("");
    let bare = lower.split_once('/').map(|(_, id)| id).unwrap_or(lower.as_str());
    // Native Claude Messages takes output_config; cli-proxy's OpenAI-compatible endpoint
    // instead accepts reasoning_effort and performs the upstream conversion itself.
    let claude = provider == "anthropic" || (provider == "opencode-go" && bare.contains("claude"));
    let glm = ["zai", "zhipu"].contains(&provider) || bare.split('/').any(|p| p.starts_with("glm-"));
    let kimi = ["kimi-coding", "moonshot"].contains(&provider) || bare.contains("kimi-") || bare.split('/').any(|p| p == "k3" || p.starts_with("k3-"));
    let deepseek = provider == "deepseek" || bare.split('/').any(|p| p.starts_with("deepseek-"));
    let xiaomi = provider == "xiaomi" || bare.split('/').any(|p| p.starts_with("mimo-"));
    let kwargs = config.entry("model_kwargs".to_string()).or_insert_with(|| json!({}));
    let Some(k) = kwargs.as_object_mut() else { return; };

    if claude {
        if ["low", "medium", "high", "xhigh", "max"].contains(&effort) {
            k.insert("output_config".into(), json!({"effort": effort}));
        }
        return;
    }
    if provider == "openrouter" {
        k.insert("reasoning".into(), if effort == "off" { json!({"enabled": false}) } else { json!({"effort": effort}) });
        return;
    }
    if provider == "ollama" {
        k.insert("think".into(), if effort == "off" { json!(false) } else { json!(effort) });
        return;
    }
    if glm || kimi || deepseek || xiaomi {
        // GLM-5.3, Kimi K3 and K2.7-code cannot disable thinking; their catalogue never offers off.
        if effort == "off" {
            if !(bare.contains("glm-5.3") || bare.contains("k3") || bare.contains("k2.7-code")) {
                k.insert("thinking".into(), json!({"type": "disabled"}));
                k.shift_remove("reasoning_effort");
            }
        } else if effort == "on" {
            k.insert("thinking".into(), json!({"type": "enabled"}));
        } else if ["low", "medium", "high", "max"].contains(&effort) && !xiaomi {
            let k3 = bare.split('/').any(|p| p == "k3" || p.starts_with("k3-")) || bare.contains("kimi-k3");
            // K3 always thinks and only accepts reasoning_effort; thinking.type belongs to K2.x.
            if !k3 { k.insert("thinking".into(), json!({"type": "enabled"})); }
            k.insert("reasoning_effort".into(), json!(effort));
        }
        return;
    }
    // OpenAI chat, OpenCode Go Responses/Chat, Groq and other OpenAI-compatible routes.
    // query_responses translates this to reasoning.effort; Chat sends reasoning_effort directly.
    if ["off", "minimal", "low", "medium", "high", "xhigh", "max"].contains(&effort) {
        k.insert("reasoning_effort".into(), json!(if effort == "off" { "none" } else { effort }));
    }
}

/// `get_model(name, config)`: the same class choice and defaults as the Python agent.
pub fn get_model(name: Option<&str>, config: &Obj) -> Result<Box<dyn Model>, String> {
    let mut config = config.clone();
    let resolved = match name.filter(|n| !n.is_empty()) {
        Some(n) => n.to_string(),
        None => match config.get("model_name").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            Some(n) => n.to_string(),
            None => match std::env::var("MSWEA_MODEL_NAME").ok().filter(|s| !s.is_empty()) {
                Some(n) => n,
                None => return Err("No default model set. Please run `mini-extra config setup` to set one.".into()),
            },
        },
    };
    config.insert("model_name".into(), Value::String(resolved.clone()));
    if let Ok(raw) = std::env::var("MINI_AGENT_MODEL_EFFORTS") {
        if let Ok(map) = serde_json::from_str::<Obj>(&raw) {
            if let Some(effort) = map.get(&resolved).and_then(Value::as_str) {
                apply_effort(&resolved, effort, &mut config);
            }
        }
    }
    connections::apply(&resolved);
    let class = config.shift_remove("model_class").and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    catalog::build(&resolved, &class, config)
}

/// The read tool's wire shapes, re-exported for the clients that build tool lists.
pub mod read_tools {
    pub use crate::tools::{with_read, with_read_anthropic, with_read_responses};
}

#[cfg(test)]
mod effort_tests {
    use super::*;

    fn kwargs(model: &str, effort: &str) -> Obj {
        let mut config = Obj::new();
        apply_effort(model, effort, &mut config);
        config.shift_remove("model_kwargs").unwrap().as_object().cloned().unwrap()
    }

    #[test]
    fn translates_each_provider_vocabulary() {
        assert_eq!(kwargs("openai/gpt-6-astra", "high")["reasoning_effort"], json!("high"));
        assert_eq!(kwargs("anthropic/claude-opus-5-5", "max")["output_config"], json!({"effort":"max"}));
        assert_eq!(kwargs("cliproxy/claude-opus-5-5", "max")["reasoning_effort"], json!("max"));
        assert_eq!(kwargs("openrouter/anthropic/claude-opus-5-5", "low")["reasoning"], json!({"effort":"low"}));
        assert_eq!(kwargs("ollama/gpt-oss", "off")["think"], json!(false));
    }

    #[test]
    fn mandatory_reasoning_is_never_disabled() {
        assert!(!kwargs("zai/glm-5.3", "off").contains_key("thinking"));
        assert!(!kwargs("moonshot/kimi-k3", "off").contains_key("thinking"));
        assert_eq!(kwargs("zai/glm-5.3", "low")["reasoning_effort"], json!("low"));
    }
}
