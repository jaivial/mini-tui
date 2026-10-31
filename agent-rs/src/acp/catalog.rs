//! The model picker the ACP server offers and the credentials a turn's agent needs.
//!
//! The list is what mini-tui's web picker shows: the curated models of `src/models.ts`, then every
//! model of every connected provider (`~/.config/mini-tui/providers.json`). Credentials follow
//! `modelEnv` in `src/providers.ts`, so a session started from an ACP client authenticates the same
//! way a mini-tui session does.

use serde_json::{json, Value};
use std::path::PathBuf;

/// Kept in sync with `MODELS` in src/models.ts: `(id, description)`.
const CURATED: &[(&str, &str)] = &[
    ("cliproxy/claude-opus-5-5", "cli-proxy · Claude Opus 5.5 (Claude subscription)"),
    ("cliproxy/claude-sonnet-5-5", "cli-proxy · Claude Sonnet 5.5 (Claude subscription)"),
    ("cliproxy/claude-haiku-5-5", "cli-proxy · Claude Haiku 5.5 (Claude subscription)"),
    ("xiaomi/mimo-v2.6-pro", "Xiaomi MiMo V2.6 Pro"),
    ("xiaomi/mimo-v2.6-flash", "Xiaomi MiMo V2.6 Flash (fast)"),
    ("deepseek/deepseek-chat", "DeepSeek chat"),
    ("deepseek/deepseek-flash", "DeepSeek flash (fast)"),
    ("opencode-go/glm-5.3-flash", "OpenCode Go · GLM 5.3 flash"),
    ("opencode-go/mimo-v2.5", "OpenCode Go · MiMo V2.5"),
    ("rosetta/zai-glm/glm-5.3-flash", "Rosetta · GLM 5.3 flash"),
    ("rosetta/minimax/claude-minimax-m3", "Rosetta · MiniMax M3"),
    ("openai/gpt-6-astra", "OpenAI GPT-6 Astra (Responses API)"),
    ("ollama/maternion/minicpm5-heretic:2b-q4_K_M", "Ollama local · MiniCPM5 Heretic 2B Q4_K_M"),
];

/// A picker with hundreds of entries is unusable in a client's select.
const MAX_OPTIONS: usize = 200;

fn env_path(var: &str, default: &str) -> PathBuf {
    std::env::var(var).ok().filter(|v| !v.is_empty()).map(PathBuf::from).unwrap_or_else(|| crate::config::home().join(default))
}

fn read_json(path: PathBuf) -> Option<Value> {
    serde_json::from_str(&std::fs::read_to_string(path).ok()?).ok()
}

pub fn connections() -> Value {
    read_json(env_path("MINITUI_CONNECTIONS_PATH", ".config/mini-tui/providers.json")).filter(Value::is_array).unwrap_or(json!([]))
}

fn settings() -> Value {
    read_json(env_path("MINITUI_SETTINGS_PATH", ".config/mini-tui/settings.json")).unwrap_or(json!({}))
}

/// The model a new session starts on: `MINITUI_MODEL`, else the model mini-tui used last, else the
/// first entry of the picker.
pub fn default_model(options: &[Value]) -> String {
    if let Some(m) = std::env::var("MINITUI_MODEL").ok().map(|m| m.trim().to_string()).filter(|m| !m.is_empty()) {
        return m;
    }
    let last = read_json(env_path("MINITUI_LAST_MODEL_PATH", ".config/mini-tui/last-model.json"))
        .and_then(|v| v.get("model").and_then(Value::as_str).map(str::to_string))
        .filter(|m| !m.trim().is_empty());
    last.or_else(|| options.first().and_then(|o| o.get("value")).and_then(Value::as_str).map(str::to_string)).unwrap_or_default()
}

/// Picker entries (`{value, name, description}`), curated first, deduplicated, capped.
pub fn options(connections: &Value) -> Vec<Value> {
    let mut out: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut push = |value: String, name: String, description: String| {
        if !value.is_empty() && seen.insert(value.clone()) {
            out.push(json!({"value": value, "name": name, "description": description}));
        }
    };
    for (id, description) in CURATED {
        push(id.to_string(), id.to_string(), description.to_string());
    }
    for c in connections.as_array().into_iter().flatten() {
        let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let route = if s("route") == "native" { "direct" } else { "openai-compat" };
        for id in c.get("models").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
            push(format!("{}/{id}", s("prefix")), format!("{} · {id}", s("name")), format!("{route} · {}", s("baseUrl")));
        }
    }
    out.truncate(MAX_OPTIONS);
    out
}

/// Ensure `model` is selectable even when it is in no list (an env default, a model set by a client).
pub fn with_current(mut options: Vec<Value>, model: &str) -> Vec<Value> {
    if !model.is_empty() && !options.iter().any(|o| o.get("value").and_then(Value::as_str) == Some(model)) {
        options.insert(0, json!({"value": model, "name": model}));
    }
    options
}

fn connection_env(c: &Value) -> Vec<(String, String)> {
    let s = |k: &str| c.get(k).and_then(Value::as_str).unwrap_or("").to_string();
    if s("route") == "native" {
        let mut env = vec![(s("keyEnv"), s("key"))];
        if let Some(extra) = c.get("extraEnv").and_then(Value::as_object) {
            env.extend(extra.iter().filter_map(|(k, v)| v.as_str().map(|v| (k.clone(), v.to_string()))));
        }
        return env.into_iter().filter(|(k, _)| !k.is_empty()).collect();
    }
    vec![
        ("OPENAI_API_KEY".into(), s("key")),
        ("OPENAI_API_BASE".into(), s("baseUrl")),
        ("MSWEA_OPENAI_API_KEY".into(), s("key")),
        ("MSWEA_OPENAI_API_BASE".into(), s("baseUrl")),
    ]
}

/// `modelEnv` of src/providers.ts: the matched connection's env, plus every other native
/// connection's variables that no second connection also sets (so a mid-run `/model` switch
/// still has its key).
pub fn model_env(model: &str, connections: &Value) -> Vec<(String, String)> {
    let list: Vec<&Value> = connections.as_array().map(|a| a.iter().collect()).unwrap_or_default();
    let prefix = |c: &Value| c.get("prefix").and_then(Value::as_str).unwrap_or("").to_string();
    let owns = |c: &Value| model.starts_with(&format!("{}/", prefix(c)));
    let native = |c: &Value| c.get("route").and_then(Value::as_str) == Some("native");
    let listed = |c: &Value| {
        let id = &model[prefix(c).len() + 1..];
        c.get("models").and_then(Value::as_array).is_some_and(|m| m.iter().any(|v| v.as_str() == Some(id)))
    };
    let matched = list.iter().position(|c| owns(c) && listed(c)).or_else(|| list.iter().position(|c| owns(c) && native(c)));
    let others: Vec<&Value> = list.iter().enumerate().filter(|(i, c)| native(c) && Some(*i) != matched).map(|(_, c)| *c).collect();
    let mut owners: std::collections::HashMap<String, usize> = Default::default();
    for c in &others {
        for (k, _) in connection_env(c) {
            *owners.entry(k).or_default() += 1;
        }
    }
    let mut env: Vec<(String, String)> = Vec::new();
    let mut set = |k: String, v: String| {
        env.retain(|(key, _)| *key != k);
        env.push((k, v));
    };
    for c in &others {
        for (k, v) in connection_env(c) {
            if owners.get(&k) == Some(&1) {
                set(k, v);
            }
        }
    }
    if let Some(i) = matched {
        for (k, v) in connection_env(list[i]) {
            set(k, v);
        }
    }
    env
}

/// `MINI_AGENT_MODEL_EFFORTS` from the reasoning levels picked in mini-tui (`modelEfforts` in
/// settings.json). mini-tui only stores levels a model supports, so they pass through as stored.
pub fn effort_env() -> Option<(String, String)> {
    let prefs = settings().get("modelEfforts").and_then(Value::as_object).cloned()?;
    let clean: serde_json::Map<String, Value> = prefs.into_iter().filter(|(_, v)| v.as_str().is_some_and(|l| !l.is_empty() && l != "auto")).collect();
    (!clean.is_empty()).then(|| ("MINI_AGENT_MODEL_EFFORTS".to_string(), Value::Object(clean).to_string()))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn saved() -> Value {
        json!([
            {"id": "x", "name": "Xiaomi", "prefix": "xiaomi", "route": "native", "keyEnv": "XIAOMI_API_KEY", "key": "kx", "baseUrl": "https://x/v1", "models": ["mimo-v2.6-pro"]},
            {"id": "k", "name": "Kimi", "prefix": "kimi", "route": "native", "keyEnv": "KIMI_API_KEY", "key": "kk", "extraEnv": {"SHARED_BASE": "k"}, "baseUrl": "https://k/v1", "models": ["k2"]},
            {"id": "m", "name": "Moon", "prefix": "moon", "route": "native", "keyEnv": "MOON_KEY", "key": "km", "extraEnv": {"SHARED_BASE": "m"}, "baseUrl": "https://m/v1", "models": []},
            {"id": "p", "name": "Proxy", "prefix": "openai", "route": "openai-compat", "keyEnv": "", "key": "kp", "baseUrl": "https://proxy/v1", "models": ["gpt-x", "mimo-v2.6-pro"]}
        ])
    }

    #[test]
    fn options_put_curated_first_then_connections_without_duplicates() {
        let opts = options(&saved());
        assert_eq!(opts[0]["value"], json!("cliproxy/claude-opus-5-5"));
        let values: Vec<&str> = opts.iter().map(|o| o["value"].as_str().unwrap()).collect();
        assert_eq!(values.iter().filter(|v| **v == "xiaomi/mimo-v2.6-pro").count(), 1);
        let proxy = opts.iter().find(|o| o["value"] == json!("openai/gpt-x")).unwrap();
        assert_eq!(proxy["name"], json!("Proxy · gpt-x"));
        assert_eq!(proxy["description"], json!("openai-compat · https://proxy/v1"));
        assert_eq!(with_current(opts.clone(), "openai/gpt-mock")[0]["value"], json!("openai/gpt-mock"));
        assert_eq!(with_current(opts.clone(), "openai/gpt-x").len(), opts.len());
    }

    #[test]
    fn model_env_matches_listed_models_and_keeps_unique_native_keys() {
        let env = model_env("openai/gpt-x", &saved());
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("MSWEA_OPENAI_API_BASE"), Some("https://proxy/v1"));
        assert_eq!(get("XIAOMI_API_KEY"), Some("kx"));
        assert_eq!(get("KIMI_API_KEY"), Some("kk"));
        // Two natives set SHARED_BASE: neither wins when neither is the model's provider.
        assert_eq!(get("SHARED_BASE"), None);
        let env = model_env("moon/anything", &saved());
        let get = |k: &str| env.iter().find(|(key, _)| key == k).map(|(_, v)| v.as_str());
        assert_eq!(get("MOON_KEY"), Some("km"));
        assert_eq!(get("SHARED_BASE"), Some("m"));
        assert_eq!(get("OPENAI_API_KEY"), None);
    }

    #[test]
    fn unknown_models_get_only_the_native_keys() {
        let env = model_env("rosetta/x", &saved());
        assert!(env.iter().all(|(k, _)| !k.contains("OPENAI")));
        assert!(model_env("openai/m", &json!(null)).is_empty());
    }
}
