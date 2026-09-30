//! Models: the direct HTTP clients (OpenAI chat completions, Anthropic Messages, OpenAI
//! Responses) behind the same routing the Python `get_model` does, plus the scripted
//! `deterministic` models the tests drive the agent with.

pub mod cache_control;
pub mod catalog;
pub mod deterministic;
pub mod go_catalog;
pub mod http;
pub mod prices;
pub mod shapes;
pub mod wire;

use crate::util::Obj;
use serde_json::Value;

/// Why a model call failed. `abort` errors are not retried (bad key, unknown model, ...).
#[derive(Debug, Clone)]
pub struct ModelError {
    pub message: String,
    pub status: Option<u16>,
    pub abort: bool,
    /// The Python exception class name this corresponds to (for exit messages).
    pub kind: String,
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
    fn format_message(&self, role: &str, content: &str, extra: Option<Obj>) -> Value;
    fn format_observation_messages(&self, message: &Value, outputs: &[Value], template_vars: &Value) -> Result<Vec<Value>, String>;
    fn template_vars(&self) -> Obj;
    fn serialize(&self) -> Value;
    fn model_name(&self) -> String;
    /// `config.context_window` (0 = look it up by id).
    fn context_window(&self) -> i64;
    /// Streams partial output through the sink (the HTTP clients do; scripted models do not).
    fn streams(&self) -> bool {
        false
    }
}

/// `GLOBAL_MODEL_STATS` (`MSWEA_GLOBAL_COST_LIMIT` / `MSWEA_GLOBAL_CALL_LIMIT`): every model call
/// of the process counts, whatever the model; past a limit the call is an error, as in Python.
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
            kind: "RuntimeError".into(),
        });
    }
    Ok(())
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
    let class = config.shift_remove("model_class").and_then(|v| v.as_str().map(String::from)).unwrap_or_default();
    catalog::build(&resolved, &class, config)
}
