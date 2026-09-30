//! Model routing (`models/__init__.py`, `routing.py`, `providers.py` and each client's
//! `__init__`): the model name picks the client and its defaults.

use super::deterministic::DeterministicModel;
use super::wire::{Flavor, Protocol, WireModel};
use super::Model;
use crate::config::{env_first, env_or};
use crate::util::Obj;
use serde_json::{json, Value};

const DEFAULT_OBSERVATION: &str = "{% if output.exception_info %}<exception>{{output.exception_info}}</exception>\n{% endif %}<returncode>{{output.returncode}}</returncode>\n<output>\n{{output.output}}</output>";

struct Provider {
    id: &'static str,
    prefix: &'static str,
    base_env: &'static str,
    default_base: &'static str,
    key_env: &'static str,
    protocol: Protocol,
}

const PROVIDERS: &[Provider] = &[
    Provider { id: "anthropic", prefix: "anthropic/", base_env: "ANTHROPIC_API_BASE", default_base: "https://api.anthropic.com/v1", key_env: "ANTHROPIC_API_KEY", protocol: Protocol::Messages },
    Provider { id: "moonshot", prefix: "moonshot/", base_env: "MOONSHOT_API_BASE", default_base: "https://api.moonshot.ai/v1", key_env: "MOONSHOT_API_KEY", protocol: Protocol::Chat },
    Provider { id: "zhipu", prefix: "zhipu/", base_env: "ZHIPU_API_BASE", default_base: "https://open.bigmodel.cn/api/paas/v4", key_env: "ZHIPUAI_API_KEY", protocol: Protocol::Chat },
    Provider { id: "groq", prefix: "groq/", base_env: "GROQ_API_BASE", default_base: "https://api.groq.com/openai/v1", key_env: "GROQ_API_KEY", protocol: Protocol::Chat },
    Provider { id: "zai", prefix: "zai/", base_env: "ZAI_API_BASE", default_base: "https://api.z.ai/api/coding/paas/v4", key_env: "ZAI_API_KEY", protocol: Protocol::Chat },
    Provider { id: "minimax", prefix: "minimax/", base_env: "MINIMAX_API_BASE", default_base: "https://api.minimax.io/v1", key_env: "MINIMAX_API_KEY", protocol: Protocol::Chat },
    Provider { id: "openrouter", prefix: "openrouter/", base_env: "OPENROUTER_API_BASE", default_base: "https://openrouter.ai/api/v1", key_env: "OPENROUTER_API_KEY", protocol: Protocol::Chat },
];

fn provider(name: &str) -> Option<&'static Provider> {
    let lower = name.to_lowercase();
    PROVIDERS.iter().find(|p| lower.starts_with(p.prefix))
}

fn lower(s: &str) -> String {
    s.to_lowercase()
}
fn has_prefix(name: &str, prefix: &str) -> bool {
    lower(name).starts_with(prefix)
}
pub fn is_cliproxy(n: &str) -> bool {
    has_prefix(n, "cliproxy/")
}
pub fn is_rosetta(n: &str) -> bool {
    has_prefix(n, "rosetta/")
}
pub fn is_xiaomi(n: &str) -> bool {
    let l = lower(n);
    l.starts_with("xiaomi/") || (!l.contains('/') && l.starts_with("mimo"))
}
pub fn is_deepseek(n: &str) -> bool {
    let l = lower(n);
    l.starts_with("deepseek/") || (!l.contains('/') && l.starts_with("deepseek"))
}
pub fn is_openai(n: &str) -> bool {
    has_prefix(n, "openai/")
}
pub fn is_opencode_go(n: &str) -> bool {
    has_prefix(n, "opencode-go/")
}
pub fn is_anthropic(n: &str) -> bool {
    let l = lower(n);
    if ["cliproxy/", "rosetta/", "xiaomi/", "deepseek/", "openai/", "opencode-go/"].iter().any(|p| l.starts_with(p)) {
        return false;
    }
    l.starts_with("anthropic/") || (!l.contains('/') && ["anthropic", "sonnet", "opus", "claude"].iter().any(|h| l.contains(h)))
}
fn openai_needs_responses(n: &str) -> bool {
    let bare = if is_openai(n) { &n["openai/".len()..] } else { n };
    regex::Regex::new(r"^gpt-6(?:$|[.-])").unwrap().is_match(bare)
}
fn strip(n: &str, prefix: &str) -> String {
    if has_prefix(n, prefix) { n[prefix.len()..].to_string() } else { n.to_string() }
}

pub fn deepseek_alias(bare: &str) -> Option<&'static str> {
    match bare.to_lowercase().as_str() {
        "deepseek-v4.1-flash" | "deepseek-v41-flash" => Some("deepseek-v4-flash"),
        _ => None,
    }
}

fn resolve_deepseek(name: &str) -> String {
    if has_prefix(name, "deepseek/") {
        let (prefix, bare) = name.split_at("deepseek/".len());
        return format!("{prefix}{}", deepseek_alias(bare).unwrap_or(bare));
    }
    deepseek_alias(name).map(String::from).unwrap_or_else(|| name.to_string())
}

pub fn go_info(id: &str) -> Option<&'static super::go_catalog::GoModel> {
    let bare = strip(id, "opencode-go/").to_lowercase();
    super::go_catalog::GO_MODELS.iter().find(|m| m.id == bare)
}

/// The Python config's field defaults (`OpenaiCompatModelConfig`), then the given config.
fn base_config(config: &Obj, cost_default: &str) -> Obj {
    let mut c = Obj::new();
    c.insert("model_name".into(), config.get("model_name").cloned().unwrap_or(json!("")));
    c.insert("api_base".into(), json!(""));
    c.insert("api_key".into(), json!(""));
    c.insert("model_kwargs".into(), json!({}));
    let timeout: f64 = env_or("MSWEA_MODEL_TIMEOUT", "600").parse().unwrap_or(600.0);
    c.insert("request_timeout".into(), json!(timeout));
    c.insert("set_cache_control".into(), Value::Null);
    let ttl = std::env::var("MSWEA_CACHE_TTL").ok().filter(|s| !s.is_empty());
    c.insert("cache_ttl".into(), ttl.map(Value::String).unwrap_or(Value::Null));
    c.insert("context_window".into(), json!(0));
    c.insert("cost_tracking".into(), json!(env_or("MSWEA_COST_TRACKING", cost_default)));
    c.insert("format_error_template".into(), json!("{{ error }}"));
    c.insert("observation_template".into(), json!(DEFAULT_OBSERVATION));
    c.insert("multimodal_regex".into(), json!(""));
    for (k, v) in config {
        c.insert(k.clone(), v.clone());
    }
    c
}

fn kwargs(c: &Obj) -> Obj {
    c.get("model_kwargs").and_then(Value::as_object).cloned().unwrap_or_default()
}

/// `gateway_settings`: explicit `model_kwargs.api_base/api_key`, else env, else defaults;
/// both removed from the kwargs.
fn gateway(c: &mut Obj, base_env: &str, default_base: &str, key_env: &str, default_key: &str) -> (String, String) {
    let mut kw = kwargs(c);
    let base = kw.get("api_base").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| env_or(base_env, default_base));
    let key = kw.get("api_key").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| env_or(key_env, default_key));
    kw.shift_remove("api_base");
    kw.shift_remove("api_key");
    c.insert("model_kwargs".into(), Value::Object(kw));
    let base = base.trim_end_matches('/').to_string();
    c.insert("api_base".into(), json!(base));
    c.insert("api_key".into(), json!(key));
    (base, key)
}

fn wire(config: Obj, protocol: Protocol, flavor: Flavor, model_type: &str, price: &str, wire_name: String) -> Box<dyn Model> {
    let api_base = config.get("api_base").and_then(Value::as_str).unwrap_or("").to_string();
    let api_key = config.get("api_key").and_then(Value::as_str).unwrap_or("").to_string();
    Box::new(WireModel { config, protocol, flavor, model_type: model_type.into(), price_provider: price.into(), wire_name, api_base, api_key })
}

/// Plain `OpenaiCompatModel`: a registry row or the generic OpenAI-compatible slot.
fn openai_compat(mut c: Obj, protocol: Protocol, model_type: &str) -> Box<dyn Model> {
    let name = c["model_name"].as_str().unwrap_or("").to_string();
    let mut price = "generic";
    let has_base = c.get("api_base").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
    if !has_base {
        if let Some(p) = provider(&name) {
            price = p.id;
            c.insert("api_base".into(), json!(env_or(p.base_env, p.default_base).trim_end_matches('/')));
            let key = c.get("api_key").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| env_or(p.key_env, ""));
            c.insert("api_key".into(), json!(key));
        } else {
            c.insert("api_base".into(), json!(env_first(&["MSWEA_OPENAI_API_BASE", "OPENAI_API_BASE"], "https://api.openai.com/v1").trim_end_matches('/')));
            let key = c.get("api_key").and_then(Value::as_str).filter(|s| !s.is_empty()).map(String::from).unwrap_or_else(|| env_first(&["MSWEA_OPENAI_API_KEY", "OPENAI_API_KEY"], ""));
            c.insert("api_key".into(), json!(key));
        }
    }
    let wire_name = provider(&name).map(|p| strip(&name, p.prefix)).unwrap_or(name);
    wire(c, protocol, Flavor::Plain, model_type, price, wire_name)
}

fn anthropic_compat(config: &Obj) -> Box<dyn Model> {
    let mut c = base_config(&Obj::new(), "ignore_errors");
    c.insert("api_base".into(), json!(env_or("ANTHROPIC_API_BASE", "https://api.anthropic.com/v1")));
    c.insert("api_key".into(), json!(env_or("ANTHROPIC_API_KEY", "")));
    c.insert("set_cache_control".into(), json!("rolling"));
    c.insert("api_version".into(), json!("2023-06-01"));
    let max_tokens: i64 = env_or("MSWEA_MAX_TOKENS", "8192").parse().unwrap_or(8192);
    c.insert("max_tokens".into(), json!(max_tokens));
    for (k, v) in config {
        c.insert(k.clone(), v.clone());
    }
    let name = c["model_name"].as_str().unwrap_or("").to_string();
    let wire_name = strip(&name, "anthropic/");
    let api_base = c["api_base"].as_str().unwrap_or("").to_string();
    let api_key = c["api_key"].as_str().unwrap_or("").to_string();
    Box::new(WireModel { config: c, protocol: Protocol::Messages, flavor: Flavor::Plain, model_type: "minisweagent.models.anthropic_compat_model.AnthropicCompatModel".into(), price_provider: "anthropic".into(), wire_name, api_base, api_key })
}

fn openai_model(config: &Obj, responses: bool) -> Box<dyn Model> {
    let mut c = base_config(config, "ignore_errors");
    let mut kw = kwargs(&c);
    let base = env_first(&["MSWEA_OPENAI_API_BASE", "OPENAI_API_BASE"], "https://api.openai.com/v1");
    kw.entry("api_base").or_insert(json!(base.trim_end_matches('/')));
    let key = env_first(&["MSWEA_OPENAI_API_KEY", "OPENAI_API_KEY"], "");
    if !key.is_empty() {
        kw.entry("api_key").or_insert(json!(key));
    }
    kw.entry("drop_params").or_insert(json!(true));
    let base = kw.shift_remove("api_base").and_then(|v| v.as_str().map(String::from)).unwrap_or_else(|| "https://api.openai.com/v1".into());
    c.insert("api_base".into(), json!(base.trim_end_matches('/')));
    if let Some(k) = kw.shift_remove("api_key").and_then(|v| v.as_str().map(String::from)).filter(|k| !k.is_empty()) {
        c.insert("api_key".into(), json!(k));
    }
    c.insert("model_kwargs".into(), Value::Object(kw));
    let name = c["model_name"].as_str().unwrap_or("").to_string();
    let (protocol, ty) = if responses {
        (Protocol::Responses, "minisweagent.models.openai_model.OpenaiResponseModel")
    } else {
        (Protocol::Chat, "minisweagent.models.openai_model.OpenaiModel")
    };
    wire(c, protocol, Flavor::Openai, ty, "openai", strip(&name, "openai/"))
}

fn opencode_go(config: &Obj, force_responses: bool) -> Box<dyn Model> {
    let requested = base_config(config, "ignore_errors");
    let model_id = strip(requested["model_name"].as_str().unwrap_or(""), "opencode-go/");
    let info = go_info(&model_id);
    if info.is_none() {
        eprintln!("WARNING: checkpoint=unknown_go_model model={model_id}: id not in the documented table, served as OpenAI compatible /chat/completions; run `mini-extra opencode-go-models` to list the ids your key accepts.");
    }
    let endpoint = if force_responses { "responses" } else { info.map(|i| i.endpoint).unwrap_or("chat") };
    // `_normalize_model_kwargs`
    let mut kw = kwargs(&requested);
    if kw.contains_key("max_completion_tokens") && !kw.contains_key("max_tokens") {
        let v = kw.shift_remove("max_completion_tokens").unwrap();
        kw.insert("max_tokens".into(), v);
    }
    kw.shift_remove("store");
    if super::go_catalog::NO_REASONING_EFFORT_MODELS.contains(&model_id.to_lowercase().as_str()) {
        kw.shift_remove("reasoning_effort");
    }
    if info.map(|i| i.endpoint) != Some("responses") {
        kw.entry("parallel_tool_calls").or_insert(json!(false));
    }
    let openai_base = env_or("OPENCODE_GO_API_BASE", "https://opencode.ai/zen/go/v1").trim_end_matches('/').to_string();
    let default_base = if endpoint == "messages" {
        let base = match std::env::var("OPENCODE_GO_ANTHROPIC_API_BASE").ok().filter(|s| !s.is_empty()) {
            Some(b) => b.trim_end_matches('/').to_string(),
            None => openai_base.strip_suffix("/v1").map(String::from).unwrap_or(openai_base.clone()),
        };
        if base.ends_with("/v1") { base } else { format!("{base}/v1") }
    } else {
        openai_base
    };
    let api_base = kw.shift_remove("api_base").and_then(|v| v.as_str().map(String::from)).filter(|s| !s.is_empty()).unwrap_or(default_base).trim_end_matches('/').to_string();
    let api_key = kw.shift_remove("api_key").and_then(|v| v.as_str().map(String::from)).filter(|s| !s.is_empty()).unwrap_or_else(|| env_first(&["MSWEA_OPENCODE_GO_API_KEY", "OPENCODE_GO_API_KEY", "OPENCODE_API_KEY"], ""));
    kw.entry("drop_params").or_insert(json!(true));
    let mut headers = kw.get("extra_headers").and_then(Value::as_object).cloned().unwrap_or_default();
    let session = std::env::var("OPENCODE_GO_SESSION").ok().filter(|s| !s.is_empty()).unwrap_or_else(|| format!("mini-swe-agent-{}", crate::util_hex(16)));
    headers.entry("x-opencode-session").or_insert(json!(session));
    headers.entry("x-opencode-client").or_insert(json!("mini-swe-agent"));
    kw.insert("extra_headers".into(), Value::Object(headers));
    // The impl's config: only these fields carry over from the facade's config.
    let mut impl_cfg = Obj::new();
    impl_cfg.insert("model_name".into(), json!(model_id));
    impl_cfg.insert("api_base".into(), json!(api_base));
    impl_cfg.insert("api_key".into(), json!(api_key));
    impl_cfg.insert("model_kwargs".into(), Value::Object(kw));
    for k in ["set_cache_control", "cost_tracking", "format_error_template", "observation_template", "multimodal_regex"] {
        impl_cfg.insert(k.into(), requested.get(k).cloned().unwrap_or(Value::Null));
    }
    let (protocol, c) = match endpoint {
        "messages" => {
            let mut c = base_config(&Obj::new(), "ignore_errors");
            c.insert("set_cache_control".into(), json!("rolling"));
            c.insert("api_version".into(), json!("2023-06-01"));
            let max_tokens: i64 = env_or("MSWEA_MAX_TOKENS", "8192").parse().unwrap_or(8192);
            c.insert("max_tokens".into(), json!(max_tokens));
            for (k, v) in impl_cfg {
                c.insert(k, v);
            }
            (Protocol::Messages, c)
        }
        "responses" => (Protocol::Responses, base_config(&impl_cfg, "ignore_errors")),
        _ => (Protocol::Chat, base_config(&impl_cfg, "ignore_errors")),
    };
    let ty = if force_responses { "minisweagent.models.opencode_go_model.OpencodeGoResponseModel" } else { "minisweagent.models.opencode_go_model.OpencodeGoModel" };
    let api_base = c["api_base"].as_str().unwrap_or("").to_string();
    let api_key = c["api_key"].as_str().unwrap_or("").to_string();
    Box::new(WireModel { config: c, protocol, flavor: Flavor::OpencodeGo, model_type: ty.into(), price_provider: "opencode-go".into(), wire_name: model_id, api_base, api_key })
}

/// `get_model_class` + the constructor: routing by explicit class, else by model name.
pub fn build(name: &str, class: &str, mut config: Obj) -> Result<Box<dyn Model>, String> {
    // `get_model` adds rolling cache markers for Anthropic-served ids and for Claude behind
    // cli-proxy (the gateway translates them into Anthropic breakpoints).
    if !config.contains_key("set_cache_control") {
        let l = lower(name);
        let claudeish = ["anthropic", "sonnet", "opus", "claude"].iter().any(|h| l.contains(h));
        if claudeish && !is_rosetta(name) && !is_cliproxy(name) && !is_deepseek(name) && !is_openai(name) && !is_opencode_go(name) && !is_xiaomi(name) {
            config.insert("set_cache_control".into(), json!("rolling"));
        } else if (l.contains("claude") || l.contains("anthropic")) && is_cliproxy(name) {
            config.insert("set_cache_control".into(), json!("rolling"));
        }
    }
    let class = class.rsplit('.').next().map(|c| c.to_string()).filter(|_| class.contains('.')).map(|last| {
        match last.as_str() {
            "DeterministicModel" => "deterministic".to_string(),
            "DeterministicToolcallModel" => "deterministic_toolcall".to_string(),
            "DeterministicResponseAPIToolcallModel" => "deterministic_response".to_string(),
            "OpenaiCompatModel" => "openai_compat".into(),
            "AnthropicCompatModel" => "anthropic_compat".into(),
            "ResponsesCompatModel" => "responses_compat".into(),
            "CliproxyModel" => "cliproxy".into(),
            "RosettaModel" => "rosetta".into(),
            "DeepseekModel" => "deepseek".into(),
            "XiaomiModel" => "xiaomi".into(),
            "OpenaiModel" => "openai".into(),
            "OpenaiResponseModel" => "openai_response".into(),
            "OpencodeGoModel" => "opencode_go".into(),
            "OpencodeGoResponseModel" => "opencode_go_response".into(),
            other => other.to_string(),
        }
    }).unwrap_or_else(|| class.to_string());
    let class = if class.is_empty() {
        if is_opencode_go(name) {
            if go_info(name).map(|i| i.endpoint) == Some("responses") { "opencode_go_response" } else { "opencode_go" }
        } else if is_rosetta(name) {
            "rosetta"
        } else if is_cliproxy(name) {
            "cliproxy"
        } else if is_deepseek(name) {
            "deepseek"
        } else if is_xiaomi(name) {
            "xiaomi"
        } else if is_openai(name) {
            if openai_needs_responses(name) { "openai_response" } else { "openai" }
        } else if is_anthropic(name) {
            "anthropic_compat"
        } else {
            match provider(name).map(|p| p.protocol) {
                Some(Protocol::Messages) => "anthropic_compat",
                Some(Protocol::Responses) => "responses_compat",
                _ => "openai_compat",
            }
        }
        .to_string()
    } else {
        class
    };
    Ok(match class.as_str() {
        "deterministic" | "deterministic_toolcall" | "deterministic_response" => Box::new(DeterministicModel::new(&class, &config)?),
        "openai_compat" => openai_compat(base_config(&config, "ignore_errors"), Protocol::Chat, "minisweagent.models.openai_compat_model.OpenaiCompatModel"),
        "responses_compat" => openai_compat(base_config(&config, "ignore_errors"), Protocol::Responses, "minisweagent.models.responses_compat_model.ResponsesCompatModel"),
        "anthropic_compat" => anthropic_compat(&config),
        "cliproxy" | "rosetta" | "xiaomi" => {
            let (base_env, default_base, key_env, default_key, prefix, ty) = match class.as_str() {
                "cliproxy" => ("CLIPROXY_API_BASE", "http://127.0.0.1:8317/v1", "CLIPROXY_API_KEY", "sk-cliproxy-local-2026", "cliproxy/", "minisweagent.models.cliproxy_model.CliproxyModel"),
                "rosetta" => ("ROSETTA_API_BASE", "http://127.0.0.1:9120/v1", "ROSETTA_API_KEY", "rosetta-local", "rosetta/", "minisweagent.models.rosetta_model.RosettaModel"),
                _ => ("XIAOMI_API_BASE", "https://token-plan-sgp.xiaomimimo.com/v1", "XIAOMI_API_KEY", "", "xiaomi/", "minisweagent.models.xiaomi_model.XiaomiModel"),
            };
            let mut c = base_config(&config, "ignore_errors");
            gateway(&mut c, base_env, default_base, key_env, default_key);
            let stripped = strip(c["model_name"].as_str().unwrap_or(""), prefix);
            c.insert("model_name".into(), json!(stripped));
            // The wire name: a registry row's prefix would be stripped again (e.g. rosetta/zai/x).
            let wire_name = provider(&stripped).map(|p| strip(&stripped, p.prefix)).unwrap_or(stripped.clone());
            wire(c, Protocol::Chat, Flavor::Plain, ty, "generic", wire_name)
        }
        "deepseek" => {
            let mut c = base_config(&config, "ignore_errors");
            c.entry("resolve_aliases").or_insert(json!(true));
            gateway(&mut c, "DEEPSEEK_API_BASE", "https://api.deepseek.com/v1", "DEEPSEEK_API_KEY", "");
            let mut name = c["model_name"].as_str().unwrap_or("").to_string();
            if !name.contains('/') {
                name = format!("deepseek/{name}");
            }
            if c["resolve_aliases"].as_bool().unwrap_or(true) {
                name = resolve_deepseek(&name);
            }
            c.insert("model_name".into(), json!(name));
            let wire_name = strip(&name, "deepseek/");
            wire(c, Protocol::Chat, Flavor::Deepseek, "minisweagent.models.deepseek_model.DeepseekModel", "deepseek", wire_name)
        }
        "openai" => openai_model(&config, false),
        "openai_response" => openai_model(&config, true),
        "opencode_go" => opencode_go(&config, false),
        "opencode_go_response" => opencode_go(&config, true),
        other => return Err(format!("Unknown model class: {other} (the Rust agent supports: openai_compat, anthropic_compat, responses_compat, cliproxy, rosetta, deepseek, xiaomi, openai, openai_response, opencode_go, opencode_go_response, deterministic). litellm, openrouter, portkey and requesty classes need the Python agent.")),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn ty(name: &str) -> String {
        let mut c = Obj::new();
        c.insert("model_name".into(), json!(name));
        let m = build(name, "", c).unwrap();
        m.serialize()["info"]["config"]["model_type"].as_str().unwrap().rsplit('.').next().unwrap().to_string()
    }

    #[test]
    fn routing_matches_python() {
        assert_eq!(ty("cliproxy/claude-sonnet-4-5"), "CliproxyModel");
        assert_eq!(ty("rosetta/x"), "RosettaModel");
        assert_eq!(ty("deepseek-chat"), "DeepseekModel");
        assert_eq!(ty("xiaomi/mimo-v2"), "XiaomiModel");
        assert_eq!(ty("mimo-x"), "XiaomiModel");
        assert_eq!(ty("openai/gpt-5.4"), "OpenaiModel");
        assert_eq!(ty("openai/gpt-6-astra"), "OpenaiResponseModel");
        assert_eq!(ty("anthropic/claude-sonnet-4-5"), "AnthropicCompatModel");
        assert_eq!(ty("claude-sonnet-4-5"), "AnthropicCompatModel");
        assert_eq!(ty("moonshot/kimi"), "OpenaiCompatModel");
        assert_eq!(ty("plainmodel"), "OpenaiCompatModel");
        assert_eq!(ty("opencode-go/grok-4.7"), "OpencodeGoResponseModel");
        assert_eq!(ty("opencode-go/unknownid"), "OpencodeGoModel");
    }

    #[test]
    fn deepseek_aliases() {
        assert_eq!(resolve_deepseek("deepseek/deepseek-v41-flash"), "deepseek/deepseek-v4-flash");
        assert_eq!(resolve_deepseek("deepseek-v4.1-flash"), "deepseek-v4-flash");
    }
}
