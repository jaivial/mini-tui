//! Connected providers (`~/.config/mini-tui/providers.json`, written by `/connect` and the web
//! app): the model name alone picks its credentials, as `modelEnv` does for mini-tui's own
//! launches. Without this, a run started by the agent itself (a subagent on another model, a
//! model switch mid-run) had no key unless the caller exported it.

use serde_json::Value;
use std::path::PathBuf;

fn connections_path() -> PathBuf {
    std::env::var("MINITUI_CONNECTIONS_PATH")
        .map(PathBuf::from)
        .unwrap_or_else(|_| crate::config::home().join(".config/mini-tui/providers.json"))
}

/// Environment a saved connection contributes for `model` (empty when no connection serves it).
/// Mirrors `connectionEnv` in `src/providers.ts`.
pub fn model_env(model: &str, connections: &Value) -> Vec<(String, String)> {
    let Some(list) = connections.as_array() else { return Vec::new() };
    for c in list {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("");
        let Some(id) = model.strip_prefix(&format!("{}/", s("prefix"))) else { continue };
        let listed = c.get("models").and_then(Value::as_array).is_some_and(|m| m.iter().any(|v| v.as_str() == Some(id)));
        if !listed || s("key").is_empty() {
            continue;
        }
        if s("route") == "native" {
            let mut env = vec![(s("keyEnv").to_string(), s("key").to_string())];
            if let Some(extra) = c.get("extraEnv").and_then(Value::as_object) {
                env.extend(extra.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))));
            }
            return env.into_iter().filter(|(k, _)| !k.is_empty()).collect();
        }
        let (key, base) = (s("key").to_string(), s("baseUrl").to_string());
        return vec![
            ("OPENAI_API_KEY".into(), key.clone()),
            ("OPENAI_API_BASE".into(), base.clone()),
            ("MSWEA_OPENAI_API_KEY".into(), key),
            ("MSWEA_OPENAI_API_BASE".into(), base),
        ];
    }
    Vec::new()
}

/// Export the connection's credentials for `model` before its client is built. Variables the
/// caller already set win; children inherit the result, so a subagent needs only the model name.
pub fn apply(model: &str) {
    let Ok(text) = std::fs::read_to_string(connections_path()) else { return };
    let Ok(connections) = serde_json::from_str::<Value>(&text) else { return };
    for (key, value) in model_env(model, &connections) {
        if std::env::var(&key).map_or(true, |v| v.is_empty()) {
            std::env::set_var(key, value);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn saved() -> Value {
        json!([
            {"prefix": "minimax", "route": "native", "keyEnv": "MINIMAX_API_KEY", "key": "k1",
             "extraEnv": {"MINIMAX_API_BASE": "https://api.minimax.io/v1"}, "baseUrl": "https://api.minimax.io/v1",
             "models": ["MiniMax-M3.1-Flash-Preview"]},
            {"prefix": "openai", "route": "openai-compat", "keyEnv": "X", "key": "k2", "baseUrl": "https://compat/v1", "models": ["m"]}
        ])
    }

    #[test]
    fn native_connection_gives_key_and_base() {
        let env = model_env("minimax/MiniMax-M3.1-Flash-Preview", &saved());
        assert_eq!(env, vec![("MINIMAX_API_KEY".into(), "k1".into()), ("MINIMAX_API_BASE".into(), "https://api.minimax.io/v1".into())]);
    }

    #[test]
    fn compat_connection_uses_openai_slot() {
        let env = model_env("openai/m", &saved());
        assert!(env.contains(&("MSWEA_OPENAI_API_KEY".into(), "k2".into())));
        assert!(env.contains(&("OPENAI_API_BASE".into(), "https://compat/v1".into())));
    }

    #[test]
    fn unlisted_or_unknown_model_gives_nothing() {
        assert!(model_env("minimax/Other", &saved()).is_empty());
        assert!(model_env("rosetta/x", &saved()).is_empty());
    }
}
