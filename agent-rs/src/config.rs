//! Configuration: YAML files and `key=value` specs merged like `build_run_config`, the global
//! `.env`, and the built-in config directory (the Python agent's, so both read the same YAML).

use crate::util::{merge_into, Obj};
use serde_json::Value;
use std::path::{Path, PathBuf};

/// Where the built-in YAML configs live: `$MINI_AGENT_CONFIG_DIR`, else the vendored Python
/// agent's `config/` next to this binary's checkout, else `~/.config/mini-swe-agent/config`.
pub fn builtin_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MINI_AGENT_CONFIG_DIR") {
        return PathBuf::from(dir);
    }
    if let Ok(exe) = std::env::current_exe() {
        // agent-rs/target/{release,debug}/mini-agent-rs -> <repo>/agent/src/minisweagent/config
        for anc in exe.ancestors() {
            let cand = anc.join("agent/src/minisweagent/config");
            if cand.is_dir() {
                return cand;
            }
        }
        if let Some(dir) = exe.parent() {
            let cand = dir.join("config");
            if cand.is_dir() {
                return cand;
            }
        }
    }
    global_config_dir().join("config")
}

/// `MSWEA_GLOBAL_CONFIG_DIR`, else `~/.config/mini-swe-agent` (platformdirs on Linux).
pub fn global_config_dir() -> PathBuf {
    if let Ok(dir) = std::env::var("MSWEA_GLOBAL_CONFIG_DIR") {
        if !dir.is_empty() {
            return PathBuf::from(dir);
        }
    }
    let base = std::env::var("XDG_CONFIG_HOME")
        .ok()
        .filter(|s| !s.is_empty())
        .map(PathBuf::from)
        .unwrap_or_else(|| home().join(".config"));
    base.join("mini-swe-agent")
}

pub fn home() -> PathBuf {
    std::env::var("HOME").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/"))
}

pub fn expand_user(p: &str) -> PathBuf {
    if p == "~" {
        return home();
    }
    if let Some(rest) = p.strip_prefix("~/") {
        return home().join(rest);
    }
    PathBuf::from(p)
}

/// `load_dotenv(global .env)`: set variables that are not already in the environment.
pub fn load_dotenv() {
    let path = global_config_dir().join(".env");
    let Ok(text) = std::fs::read_to_string(&path) else { return };
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((key, value)) = line.split_once('=') else { continue };
        let key = key.trim();
        if key.is_empty() || std::env::var_os(key).is_some() {
            continue;
        }
        let mut value = value.trim().to_string();
        let quoted = value.len() >= 2
            && ((value.starts_with('"') && value.ends_with('"')) || (value.starts_with('\'') && value.ends_with('\'')));
        if quoted {
            value = value[1..value.len() - 1].to_string();
        } else if let Some(i) = value.find(" #") {
            value.truncate(i);
            value = value.trim_end().to_string();
        }
        std::env::set_var(key, value);
    }
}

/// `get_config_path`: the spec, then `$MSWEA_CONFIG_DIR/spec`, then the built-in dirs.
pub fn config_path(spec: &str) -> Result<PathBuf, String> {
    let mut p = PathBuf::from(spec);
    if p.extension().and_then(|e| e.to_str()) != Some("yaml") {
        p.set_extension("yaml");
    }
    let builtin = builtin_config_dir();
    let candidates = [
        p.clone(),
        PathBuf::from(std::env::var("MSWEA_CONFIG_DIR").unwrap_or_else(|_| ".".into())).join(&p),
        builtin.join(&p),
        builtin.join("extra").join(&p),
        builtin.join("benchmarks").join(&p),
    ];
    for c in &candidates {
        if c.exists() {
            return Ok(c.clone());
        }
    }
    Err(format!("Could not find config file for {} (tried: {:?})", p.display(), candidates))
}

fn yaml_file(path: &Path) -> Result<Obj, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let v: Value = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(match v {
        Value::Object(o) => o,
        Value::Null => Obj::new(),
        _ => return Err(format!("{}: top level must be a mapping", path.display())),
    })
}

/// `model.model_name=foo` -> `{"model": {"model_name": "foo"}}` (JSON values parsed).
fn key_value_spec(spec: &str) -> Result<Obj, String> {
    let (key, raw) = spec.split_once('=').unwrap();
    let value: Value = serde_json::from_str(raw).unwrap_or_else(|_| Value::String(raw.to_string()));
    let keys: Vec<&str> = key.split('.').collect();
    if keys.iter().any(|k| k.is_empty()) {
        return Err(format!("Invalid config spec {spec:?}: empty config key"));
    }
    let mut leaf = value;
    for k in keys.iter().rev() {
        let mut o = Obj::new();
        o.insert((*k).to_string(), leaf);
        leaf = Value::Object(o);
    }
    Ok(leaf.as_object().cloned().unwrap_or_default())
}

pub fn config_from_spec(spec: &str) -> Result<Obj, String> {
    if spec.contains('=') {
        return key_value_spec(spec);
    }
    yaml_file(&config_path(spec)?)
}

/// Command-line overrides applied last (only the ones given).
pub struct Overrides {
    pub task: Option<String>,
    pub model_name: Option<String>,
    pub model_class: Option<String>,
    pub agent_class: Option<String>,
    pub environment_class: Option<String>,
    pub cost_limit: Option<f64>,
    pub output: Option<String>,
    pub yolo: bool,
    pub exit_immediately: bool,
}

pub fn build_run_config(specs: &[String], o: &Overrides) -> Result<Obj, String> {
    let mut out = Obj::new();
    for spec in specs {
        merge_into(&mut out, &config_from_spec(spec)?);
    }
    let mut cli = Obj::new();
    let section = |cli: &mut Obj, name: &str, key: &str, v: Value| {
        let entry = cli.entry(name.to_string()).or_insert_with(|| Value::Object(Obj::new()));
        entry.as_object_mut().unwrap().insert(key.to_string(), v);
    };
    if let Some(t) = o.task.as_ref().filter(|t| !t.is_empty()) {
        section(&mut cli, "run", "task", Value::String(t.clone()));
    }
    if let Some(v) = &o.agent_class {
        section(&mut cli, "agent", "agent_class", Value::String(v.clone()));
    }
    if o.yolo {
        section(&mut cli, "agent", "mode", Value::String("yolo".into()));
    }
    if let Some(c) = o.cost_limit {
        section(&mut cli, "agent", "cost_limit", serde_json::json!(c));
    }
    if o.exit_immediately {
        section(&mut cli, "agent", "confirm_exit", Value::Bool(false));
    }
    if let Some(p) = &o.output {
        section(&mut cli, "agent", "output_path", Value::String(p.clone()));
    }
    if let Some(v) = &o.model_class {
        section(&mut cli, "model", "model_class", Value::String(v.clone()));
    }
    if let Some(v) = &o.model_name {
        section(&mut cli, "model", "model_name", Value::String(v.clone()));
    }
    if let Some(v) = &o.environment_class {
        section(&mut cli, "environment", "environment_class", Value::String(v.clone()));
    }
    merge_into(&mut out, &cli);
    Ok(out)
}

pub fn env_or(key: &str, default: &str) -> String {
    std::env::var(key).unwrap_or_else(|_| default.to_string())
}

/// `os.getenv(a) or os.getenv(b, default)`: an empty first variable falls through.
pub fn env_first(keys: &[&str], default: &str) -> String {
    for (i, k) in keys.iter().enumerate() {
        match std::env::var(k) {
            Ok(v) if !v.is_empty() => return v,
            Ok(v) if i == keys.len() - 1 => return v,
            _ => {}
        }
    }
    default.to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn key_value_specs() {
        assert_eq!(Value::Object(key_value_spec("agent.step_limit=5").unwrap()), json!({"agent": {"step_limit": 5}}));
        assert_eq!(Value::Object(key_value_spec("model.model_name=a/b").unwrap()), json!({"model": {"model_name": "a/b"}}));
        assert!(key_value_spec("a..b=1").is_err());
    }
}
