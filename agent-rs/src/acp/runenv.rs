//! The environment of the agent a turn spawns: what `buildRunEnv` (src/mini/spawn.ts) and
//! `sessionRunEnv` (src/mini/sessionEnv.ts) give a mini-tui session, plus the MCP servers the
//! ACP client passed to `session/new`.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

/// What a turn needs to know to build its agent's environment.
pub struct RunSpec<'a> {
    pub session_id: &'a str,
    pub model: &'a str,
    pub control: &'a Path,
    /// Earlier turns' trajectories, newest first.
    pub trajectories: &'a [PathBuf],
    pub acp_mcp: &'a [Value],
}

/// ACP `McpServer` entries to the agent's `MINI_AGENT_MCP_SERVERS` shape: `env`/`headers` arrive
/// as `[{name, value}]` lists and leave as objects.
pub fn acp_servers(servers: &[Value]) -> Vec<Value> {
    let pairs = |v: Option<&Value>| -> serde_json::Map<String, Value> {
        v.and_then(Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|p| Some((p.get("name")?.as_str()?.to_string(), json!(p.get("value")?.as_str()?))))
            .collect()
    };
    let mut out = Vec::new();
    for s in servers {
        let Some(name) = s.get("name").and_then(Value::as_str).map(str::trim).filter(|n| !n.is_empty()) else { continue };
        // `cu` is the agent's built-in browser server; a client's server of that name gets another.
        let name = if name == "cu" { "cu-client".to_string() } else { name.to_string() };
        if let Some(command) = s.get("command").and_then(Value::as_str).filter(|c| !c.trim().is_empty()) {
            let args: Vec<Value> = s.get("args").and_then(Value::as_array).cloned().unwrap_or_default();
            out.push(json!({"name": name, "command": command, "args": args, "env": pairs(s.get("env"))}));
        } else if let Some(url) = s.get("url").and_then(Value::as_str).filter(|u| !u.trim().is_empty()) {
            // The agent speaks streamable HTTP only; an SSE-only server fails at its first call.
            out.push(json!({"name": name, "url": url, "headers": pairs(s.get("headers"))}));
        }
    }
    out
}

/// The servers installed in mini-tui (`mcp.json`), as `mcpRunEnv` passes them: enabled, not the
/// built-in `cu`, OAuth ones only once logged in. Their tokens are not copied here: the agent
/// reads them from the file (`MINI_AGENT_MCP_FILE`), which also keeps them fresh mid-run.
pub fn user_servers(file: &Value) -> Vec<Value> {
    let mut out = Vec::new();
    for s in file.get("servers").and_then(Value::as_array).into_iter().flatten() {
        let Some(id) = s.get("id").and_then(Value::as_str).filter(|i| !i.is_empty() && *i != "cu") else { continue };
        let Some(url) = s.get("url").and_then(Value::as_str) else { continue };
        if s.get("disabled").and_then(Value::as_bool) == Some(true) {
            continue;
        }
        if s.get("oauth").is_some_and(|o| o.is_object() && o.get("tokens").map_or(true, Value::is_null)) {
            continue;
        }
        let mut entry = json!({"name": id, "url": url, "headers": s.get("headers").cloned().filter(Value::is_object).unwrap_or(json!({}))});
        if let Some(tools) = s.get("tools").and_then(Value::as_array).filter(|t| !t.is_empty()) {
            entry["tools"] = json!(tools);
        }
        if let Some(hints) = s.get("hints").filter(|h| h.as_object().is_some_and(|o| !o.is_empty())) {
            entry["hints"] = hints.clone();
        }
        out.push(entry);
    }
    out
}

/// Base servers (the operator's `MINI_AGENT_MCP_SERVERS`, else mcp.json) plus the client's; a
/// client server replaces a base server of the same name.
pub fn merge_servers(base: Vec<Value>, client: Vec<Value>) -> Vec<Value> {
    let names: std::collections::HashSet<String> = client.iter().filter_map(|s| s.get("name").and_then(Value::as_str).map(str::to_string)).collect();
    let mut out: Vec<Value> = base.into_iter().filter(|s| s.get("name").and_then(Value::as_str).map_or(true, |n| !names.contains(n))).collect();
    out.extend(client);
    out
}

fn var(k: &str) -> Option<String> {
    std::env::var(k).ok().filter(|v| !v.is_empty())
}

/// The mini-tui checkout, when this binary runs from one (`agent-rs/target/release`) or
/// `MINITUI_HOME` names it.
pub fn minitui_home() -> Option<PathBuf> {
    if let Some(home) = var("MINITUI_HOME") {
        return Some(PathBuf::from(home));
    }
    let exe = std::env::current_exe().ok()?;
    exe.ancestors().skip(1).find(|d| d.join("agent/src/minisweagent/config").is_dir()).map(Path::to_path_buf)
}

fn mcp_file() -> PathBuf {
    var("MINITUI_MCP_PATH").map(PathBuf::from).unwrap_or_else(|| crate::config::home().join(".config/mini-tui/mcp.json"))
}

/// Variables to set on top of the inherited environment.
pub fn run_env(spec: &RunSpec) -> Vec<(String, String)> {
    let mut env: Vec<(String, String)> = Vec::new();
    let mut set = |k: &str, v: String| {
        env.retain(|(key, _)| key != k);
        env.push((k.to_string(), v));
    };

    let connections = super::catalog::connections();
    for (k, v) in super::catalog::model_env(spec.model, &connections) {
        set(&k, v);
    }
    if var("MINI_AGENT_MODEL_EFFORTS").is_none() {
        if let Some((k, v)) = super::catalog::effort_env() {
            set(&k, v);
        }
    }

    let client = acp_servers(spec.acp_mcp);
    let base = match var("MINI_AGENT_MCP_SERVERS") {
        Some(raw) => serde_json::from_str::<Value>(&raw).ok().and_then(|v| v.as_array().cloned()).unwrap_or_default(),
        None => {
            let file = mcp_file();
            let servers = std::fs::read_to_string(&file).ok().and_then(|t| serde_json::from_str::<Value>(&t).ok()).map(|v| user_servers(&v)).unwrap_or_default();
            if !servers.is_empty() && var("MINI_AGENT_MCP_FILE").is_none() {
                set("MINI_AGENT_MCP_FILE", file.display().to_string());
            }
            servers
        }
    };
    let servers = merge_servers(base, client);
    if !servers.is_empty() {
        set("MINI_AGENT_MCP_SERVERS", Value::Array(servers).to_string());
    }

    let home = minitui_home();
    if let Some(home) = &home {
        if var("MINITUI_HOME").is_none() {
            set("MINITUI_HOME", home.display().to_string());
        }
        let config = home.join("agent/src/minisweagent/config");
        if var("MINI_AGENT_CONFIG_DIR").is_none() && config.is_dir() {
            set("MINI_AGENT_CONFIG_DIR", config.display().to_string());
        }
    }
    let user_home = crate::config::home();
    let path = format!("{}:{}:{}", user_home.join(".local/bin").display(), user_home.join(".bun/bin").display(), std::env::var("PATH").unwrap_or_default());
    set("PATH", path);
    if var("MINITUI_AGENT_TOOLS").is_none() {
        set("MINITUI_AGENT_TOOLS", "1".into());
    }
    set("MINI_AGENT_TASK_FILE", "1".into());
    set("MSWEA_CONTROL_FILE", spec.control.display().to_string());
    set("MSWEA_SILENT_STARTUP", "1".into());
    // Tool calls are shown when they start, not only once the step's commands have returned.
    set("MINI_AGENT_JOURNAL_ACTIONS", "1".into());
    if var("MINI_AGENT_CU_MCP").is_none() {
        set("MINI_AGENT_CU_MCP", "1".into());
    }
    set("MINITUI_SESSION_ID", spec.session_id.to_string());
    if var("MINI_AGENT_ORCHESTRATOR").is_none() {
        set("MINI_AGENT_ORCHESTRATOR", "1".into());
    }
    if var("MINI_AGENT_MAX_DEPTH").is_none() {
        set("MINI_AGENT_MAX_DEPTH", "10".into());
    }
    if !spec.trajectories.is_empty() {
        let paths: Vec<String> = spec.trajectories.iter().map(|p| p.display().to_string()).collect();
        set("MINI_AGENT_RECOVERY_TRAJECTORIES", json!(paths).to_string());
        if var("MINI_AGENT_CONTEXT_DIR").is_none() {
            let dir_of = |p: &PathBuf| p.parent().map(|d| d.join("context"));
            let root = spec.trajectories.iter().filter_map(dir_of).find(|c| c.join("contracts.md").exists())
                .or_else(|| spec.trajectories.iter().filter_map(dir_of).find(|c| c.is_dir()));
            if let Some(root) = root {
                set("MINI_AGENT_CONTEXT_DIR", root.display().to_string());
            }
        }
    }
    env
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn acp_servers_become_agent_specs() {
        let acp = vec![
            json!({"name": "paseo", "command": "node", "args": ["mcp.js"], "env": [{"name": "TOKEN", "value": "t"}]}),
            json!({"type": "http", "name": "docs", "url": "https://docs/mcp", "headers": [{"name": "Authorization", "value": "Bearer x"}]}),
            json!({"name": "cu", "url": "http://x"}),
            json!({"name": "", "url": "http://nameless"}),
            json!({"name": "broken"}),
        ];
        assert_eq!(acp_servers(&acp), vec![
            json!({"name": "paseo", "command": "node", "args": ["mcp.js"], "env": {"TOKEN": "t"}}),
            json!({"name": "docs", "url": "https://docs/mcp", "headers": {"Authorization": "Bearer x"}}),
            json!({"name": "cu-client", "url": "http://x", "headers": {}}),
        ]);
    }

    #[test]
    fn user_servers_follow_mcp_run_env_rules() {
        let file = json!({"servers": [
            {"id": "cu", "url": "http://builtin"},
            {"id": "off", "url": "http://off", "disabled": true},
            {"id": "pending", "url": "http://p", "oauth": {}},
            {"id": "gsc", "url": "https://gsc/mcp", "oauth": {"tokens": {"accessToken": "secret"}}, "tools": ["a"]},
            {"id": "plain", "url": "https://plain/mcp", "headers": {"X-Key": "k"}, "hints": {"a": "b"}}
        ]});
        let servers = user_servers(&file);
        assert_eq!(servers, vec![
            json!({"name": "gsc", "url": "https://gsc/mcp", "headers": {}, "tools": ["a"]}),
            json!({"name": "plain", "url": "https://plain/mcp", "headers": {"X-Key": "k"}, "hints": {"a": "b"}}),
        ]);
        assert!(!serde_json::to_string(&servers).unwrap().contains("secret"));
    }

    #[test]
    fn client_servers_replace_same_named_base_servers() {
        let merged = merge_servers(vec![json!({"name": "a", "url": "http://old"}), json!({"name": "b", "url": "http://b"})], vec![json!({"name": "a", "url": "http://new"})]);
        assert_eq!(merged, vec![json!({"name": "b", "url": "http://b"}), json!({"name": "a", "url": "http://new"})]);
    }
}
