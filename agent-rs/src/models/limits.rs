//! Per-provider model limits shipped by mini-tui.
//!
//! The catalog is read on every model construction (including a mid-session model switch), so a
//! run never inherits the previous model's window or output cap. `MINITUI_HOME` selects the live
//! checkout; the embedded copy keeps standalone agent binaries working too.

use serde_json::Value;

const EMBEDDED: &str = include_str!("../../../config/model-limits.json");

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ModelLimits {
    pub context_window: i64,
    pub max_output_tokens: i64,
}

fn from_catalog(text: &str, model_name: &str) -> Option<ModelLimits> {
    let root: Value = serde_json::from_str(text).ok()?;
    let models = root.get("models")?.as_object()?;
    let lowered = model_name.to_lowercase();
    let bare = |prefix: &str| format!("{prefix}/{lowered}");
    let mut candidates = vec![lowered.clone()];
    // The Python and Rust routers also accept unqualified ids for these native providers.
    if lowered.starts_with("deepseek") && !lowered.contains('/') {
        candidates.push(bare("deepseek"));
    } else if lowered.starts_with("mimo") && !lowered.contains('/') {
        candidates.push(bare("xiaomi"));
    } else if ["claude", "sonnet", "opus"].iter().any(|part| lowered.contains(part)) && !lowered.contains('/') {
        candidates.push(bare("anthropic"));
    }
    let row = candidates.iter().find_map(|id| models.get(id))?;
    Some(ModelLimits {
        context_window: row.get("contextWindow")?.as_i64()?,
        max_output_tokens: row.get("maxOutputTokens")?.as_i64()?,
    })
}

pub fn model_limits(model_name: &str) -> Option<ModelLimits> {
    if let Some(root) = std::env::var("MINITUI_HOME").ok().filter(|s| !s.is_empty()) {
        let path = std::path::Path::new(&root).join("config/model-limits.json");
        if let Ok(text) = std::fs::read_to_string(path) {
            return from_catalog(&text, model_name);
        }
    }
    from_catalog(EMBEDDED, model_name)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn resolves_provider_specific_and_bare_ids_case_insensitively() {
        assert_eq!(model_limits("minimax/MiniMax-M3.1-Flash"), Some(ModelLimits { context_window: 1_000_000, max_output_tokens: 524_288 }));
        assert_eq!(model_limits("openai/gpt-4o-mini"), Some(ModelLimits { context_window: 128_000, max_output_tokens: 16_384 }));
        assert_eq!(model_limits("deepseek-chat"), model_limits("deepseek/deepseek-chat"));
        assert!(model_limits("ollama/some-local-model").is_none());
    }

    #[test]
    fn every_embedded_limit_is_positive() {
        let root: Value = serde_json::from_str(EMBEDDED).unwrap();
        for (id, row) in root["models"].as_object().unwrap() {
            assert!(row["contextWindow"].as_i64().unwrap_or(0) > 0, "{id}");
            assert!(row["maxOutputTokens"].as_i64().unwrap_or(0) > 0, "{id}");
        }
    }
}
