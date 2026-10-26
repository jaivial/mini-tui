//! Message shapes shared by the models: parsing bash tool calls, formatting observations,
//! and the multimodal expansion, exactly as `actions_toolcall*.py` / `actions_text.py` do.

use crate::templates::render;
use crate::util::{get, get_str, now, py_json, Obj};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicU64, Ordering};

static RECOVERED_XML_ID: AtomicU64 = AtomicU64::new(1);

pub fn bash_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Execute a bash command",
            "parameters": {
                "type": "object",
                "properties": {"command": {"type": "string", "description": "The bash command to execute"}},
                "required": ["command"],
            },
        },
    })
}

pub fn bash_tool_responses() -> Value {
    json!({
        "type": "function",
        "name": "bash",
        "description": "Execute a bash command",
        "parameters": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The bash command to execute"}},
            "required": ["command"],
        },
    })
}

pub fn anthropic_bash_tool() -> Value {
    json!({
        "name": "bash",
        "description": "Execute a bash command",
        "input_schema": {
            "type": "object",
            "properties": {"command": {"type": "string", "description": "The bash command to execute"}},
            "required": ["command"],
        },
    })
}

/// What the model reads about the `cu` tool. It names only commands the `cu` CLI has: an earlier
/// text taught `tab open --lease`, `tab close` and `batch` from an unmerged branch, and the CLI
/// answers an unknown command with its help and exit status 0, so those calls failed silently.
/// The Python agent sends the same text (wire parity).
pub const CU_TOOL_DESCRIPTION: &str = "Run one `cu` CLI command against the persistent browser daemon (one Chrome shared by every agent). When the mcp__cu__* tools are present, browse with them: they keep one page for the whole run and attach screenshots as images. Use this tool for what they do not cover (`vault ...`, `otp ...`, `diagnostics`, `challenge ...`) or when they are absent. Page commands: `navigate URL --new-tab` opens a page of this run's own and prints its id (`cu: working in a fresh tab (ID)`); pass `--tab ID` to every later command: `snapshot`, `text`, `click e3`, `type e2 TEXT [--submit]`, `act JSON`, `shot FILE.png`, `console --level warn+`; close it with `tabs close ID` at the end. Never type a password or a one-time code: `login` prints the link where the human signs in.";
pub const CU_ARGS_DESCRIPTION: &str = "cu arguments, e.g. snapshot --tab ID";

/// The `cu` custom tool: one call runs one `cu` command against the persistent
/// browser daemon (one Chrome for every agent; the mcp__cu__* tools, when present,
/// are the typed way to browse). Executed as `cu <args>` through the same shell
/// path as `bash`.
pub fn cu_tool() -> Value {
    json!({
        "type": "function",
        "function": {
            "name": "cu",
            "description": CU_TOOL_DESCRIPTION,
            "parameters": {
                "type": "object",
                "properties": {"args": {"type": "string", "description": CU_ARGS_DESCRIPTION}},
                "required": ["args"],
            },
        },
    })
}

pub fn cu_tool_responses() -> Value {
    json!({
        "type": "function",
        "name": "cu",
        "description": CU_TOOL_DESCRIPTION,
        "parameters": {
            "type": "object",
            "properties": {"args": {"type": "string", "description": CU_ARGS_DESCRIPTION}},
            "required": ["args"],
        },
    })
}

pub fn anthropic_cu_tool() -> Value {
    json!({
        "name": "cu",
        "description": CU_TOOL_DESCRIPTION,
        "input_schema": {
            "type": "object",
            "properties": {"args": {"type": "string", "description": CU_ARGS_DESCRIPTION}},
            "required": ["args"],
        },
    })
}

/// The action a parsed tool call becomes. A native tool call (`read`, `write`, `edit`, `code`)
/// carries structured arguments rather than a command string, so the agent loop can execute it
/// without a shell; everything else is the command the shell will run.
fn action_value(command: &Value, tool_call_id: Value) -> Value {
    let mut a = Obj::new();
    match command {
        Value::Object(fields) if fields.get("tool").and_then(Value::as_str).is_some_and(|t| is_native_tool(t)) => {
            let tool = fields.get("tool").and_then(Value::as_str).unwrap_or_default().to_string();
            a.insert("tool".into(), json!(tool));
            if let Some(args) = fields.get("args") {
                a.insert("args".into(), args.clone());
            }
            if let Some(path) = fields.get("args").and_then(|x| x.get("path")).cloned() {
                a.insert("command".into(), path);
            }
            if crate::queue_tools::is_tool(&tool) {
                a.insert("command".into(), json!(format!("{tool} {}", fields.get("args").map(|v| v.to_string()).unwrap_or_default())));
            }
        }
        other => {
            a.insert("command".into(), other.clone());
        }
    }
    a.insert("tool_call_id".into(), tool_call_id);
    Value::Object(a)
}

/// The tools the agent loop executes itself, without a shell. All of them are behind the
/// `MINITUI_AGENT_TOOLS=1` gate, so a bare run --- and the parity suite --- still sees only
/// `bash` + `cu`, and a call to any of these without the gate is the usual unknown-tool error.
pub fn is_native_tool(name: &str) -> bool {
    crate::mcp::is_tool(name) || crate::queue_tools::is_tool(name) || (name == "codejs" && crate::codejs::enabled()) || matches!(name, "read") || (matches!(name, "write" | "edit" | "code") && crate::writing::write_enabled())
        || (name == "computer_use" && crate::computer_use::enabled())
}

fn command_for(name: &str, args: &Value) -> Result<Value, String> {
    if crate::mcp::is_tool(name) {
        return Ok(json!({"tool": name, "args": args}));
    }
    if crate::queue_tools::is_tool(name) {
        return Ok(json!({"tool": name, "args": args}));
    }
    if crate::queue_tools::active() && crate::agents::is_tool(name) {
        return Err(format!("Unknown tool '{name}'."));
    }
    if crate::queue_tools::dispatcher() {
        return Err(format!("Unknown tool '{name}'. You have no shell or file tools: create or redirect a task with task_create / task_redirect, or answer in plain text."));
    }
    if crate::agents::is_tool(name) && crate::agents::tools_enabled() {
        return Ok(crate::agents::command_for(name, args));
    }
    if name == "read" && crate::tools::read_enabled() {
        // The action keeps its parsed arguments (not a flattened command) so the loop can page
        // through the file directly; `tool` records which path executes it.
        let path = args.get("path").and_then(Value::as_str).unwrap_or("");
        if path.trim().is_empty() {
            return Err("Missing 'path' argument in read tool call.".into());
        }
        return Ok(json!({"tool": "read", "args": args}));
    }
    if (matches!(name, "write" | "edit" | "code") && crate::writing::write_enabled()) || (name == "codejs" && crate::codejs::enabled()) {
        // The same shape for the writing tools: the loop executes them natively.
        let empty = |k: &str| !args.get(k).and_then(Value::as_str).map(|v| !v.trim().is_empty()).unwrap_or(false);
        if !matches!(name, "code" | "codejs") && empty("path") {
            return Err(format!("Missing 'path' argument in {name} tool call."));
        }
        if name == "write" && args.get("content").and_then(Value::as_str).is_none() {
            return Err("Missing 'content' argument in write tool call.".into());
        }
        if matches!(name, "code" | "codejs") && args.get("code").and_then(Value::as_str).map(|c| c.trim().is_empty()).unwrap_or(true) {
            return Err("Missing 'code' argument in code tool call.".into());
        }
        return Ok(json!({"tool": name, "args": args}));
    }
    if name == "computer_use" && crate::computer_use::enabled() {
        // Structured browser actions against the managed cu daemon pool; the
        // loop executes them natively (screenshots come back as images).
        if args.get("action").and_then(Value::as_str).map(|a| a.trim().is_empty()).unwrap_or(true) {
            return Err("Missing 'action' argument in computer_use tool call.".into());
        }
        return Ok(json!({"tool": name, "args": args}));
    }
    let mut error = String::new();
    if name != "bash" && name != "cu" {
        error.push_str(&format!("Unknown tool '{name}'."));
    }
    let command = match name {
        "cu" => match args.get("args").and_then(Value::as_str) {
            Some(a) if !a.is_empty() => Some(Value::String(format!("cu {a}"))),
            _ => {
                error.push_str("Missing 'args' argument in cu tool call.");
                None
            }
        },
        _ => {
            if args.as_object().is_some_and(|o| o.contains_key("command")) {
                Some(args["command"].clone())
            } else {
                error.push_str("Missing 'command' argument in bash tool call.");
                None
            }
        }
    };
    match command {
        Some(command) if error.is_empty() => Ok(command),
        _ => Err(error),
    }
}

pub(crate) fn format_error_text(template: &str, error: &str, has_tool_calls: bool, finish_reason: &Value) -> Result<String, String> {
    // The model classes always pass `finish_reason` (possibly None), so it is always defined.
    let vars = json!({"error": error, "actions": [], "has_tool_calls": has_tool_calls, "finish_reason": finish_reason});
    render(template, &vars)
}

/// Python's `json.loads` error text for the common cases a model produces.
fn json_error_text(raw: &str, e: &serde_json::Error) -> String {
    // serde_json reports line/column; Python reports "Expecting value: line 1 column 1 (char 0)".
    let line = e.line();
    let col = e.column();
    let char_index = raw.split('\n').take(line.saturating_sub(1)).map(|l| l.chars().count() + 1).sum::<usize>() + col.saturating_sub(1);
    let what = match e.classify() {
        serde_json::error::Category::Eof if raw.trim().is_empty() => "Expecting value",
        serde_json::error::Category::Eof => "Unterminated string starting at",
        serde_json::error::Category::Syntax => "Expecting value",
        _ => "Invalid JSON",
    };
    format!("{what}: line {line} column {col} (char {char_index})")
}

/// MiMo can answer `stop_reason=tool_use` while serializing calls as
/// `<tool_call><function=name><parameter=key>value</parameter>…` text. Recover that wire bug into
/// the native shape; execution still goes through `command_for`, so unknown tools and bad arguments
/// are rejected exactly as they are for provider-native calls.
pub fn recover_xml_tool_calls(text: &str) -> Result<Vec<Value>, String> {
    fn between<'a>(text: &'a str, from: usize, open: &str, close: &str) -> Result<(String, &'a str, usize), String> {
        let start = text[from..].find(open).map(|i| from + i).ok_or_else(|| format!("missing {open}"))?;
        let name = start + open.len();
        let value = text[name..].find('>').map(|i| name + i + 1).ok_or_else(|| format!("missing > after {open}"))?;
        let end = text[value..].find(close).map(|i| value + i).ok_or_else(|| format!("missing {close}"))?;
        Ok((text[name..value - 1].to_string(), &text[value..end], end + close.len()))
    }
    fn value(raw: &str) -> Result<Value, String> {
        let trimmed = raw.trim();
        if trimmed.starts_with('{') || trimmed.starts_with('[') {
            // Linear titles commonly start with [GH ...], [DEBUG], [P0], etc. Only valid JSON is
            // structured; bracketed prose stays a string instead of rejecting the whole tool call.
            return Ok(serde_json::from_str(trimmed).unwrap_or_else(|_| Value::String(raw.to_string())));
        }
        Ok(match trimmed {
            "true" => Value::Bool(true),
            "false" => Value::Bool(false),
            "null" => Value::Null,
            _ => serde_json::from_str::<i64>(trimmed).map(Value::from)
                .or_else(|_| serde_json::from_str::<f64>(trimmed).map(Value::from))
                .unwrap_or_else(|_| Value::String(raw.to_string())),
        })
    }
    let mut calls = Vec::new();
    let mut rest = text;
    while let Some(start) = rest.find("<tool_call>") {
        if !rest[..start].trim().is_empty() && !calls.is_empty() {
            return Err("unexpected text between recovered tool calls".into());
        }
        let after_open = &rest[start + "<tool_call>".len()..];
        let end = after_open.find("</tool_call>").ok_or("missing </tool_call>")?;
        let body = &after_open[..end];
        let (name, mut params, _) = between(body, 0, "<function=", "</function>")?;
        if name.is_empty() {
            return Err("empty recovered function name".into());
        }
        let mut args = Obj::new();
        while let Some(at) = params.find("<parameter=") {
            if !params[..at].trim().is_empty() {
                return Err("unexpected content between recovered parameters".into());
            }
            params = &params[at..];
            let (key, raw, after) = between(params, 0, "<parameter=", "</parameter>")?;
            if key.is_empty() || args.contains_key(&key) {
                return Err(format!("empty or duplicate recovered parameter {key}"));
            }
            args.insert(key, value(raw)?);
            params = &params[after..];
        }
        if !params.trim().is_empty() {
            return Err("malformed recovered parameter list".into());
        }
        let id = format!("recovered_xml_{}", RECOVERED_XML_ID.fetch_add(1, Ordering::SeqCst));
        calls.push(json!({"id": id, "type": "function", "function": {"name": name, "arguments": Value::Object(args).to_string()}}));
        rest = &after_open[end + "</tool_call>".len()..];
    }
    if calls.is_empty() { Err("no XML tool calls found".into()) } else { Ok(calls) }
}

/// `parse_toolcall_actions`: chat-completions tool calls -> `[{command, tool_call_id}]`.
pub fn parse_toolcall_actions(tool_calls: &[Value], format_error_template: &str, finish_reason: &Value) -> Result<Vec<Value>, Value> {
    let err = |text: String| json!({"role": "user", "content": text, "extra": {"interrupt_type": "FormatError"}});
    if tool_calls.is_empty() {
        let text = format_error_text(format_error_template, "No tool calls found in the response. Every response MUST include at least one tool call.", false, finish_reason)
            .unwrap_or_else(|e| e);
        return Err(err(text));
    }
    let mut actions = Vec::new();
    for call in tool_calls {
        let function = get(call, "function").cloned().unwrap_or(Value::Null);
        let name = get_str(&function, "name").unwrap_or("");
        let raw = get(&function, "arguments").cloned().unwrap_or(Value::Null);
        let mut error = String::new();
        let args: Value = match &raw {
            Value::String(s) => match serde_json::from_str::<Value>(s) {
                Ok(v) => v,
                Err(e) => {
                    error = format!("Error parsing tool call arguments: {}.", json_error_text(s, &e));
                    Value::Object(Obj::new())
                }
            },
            _ => {
                error = "Error parsing tool call arguments: the JSON object must be str, bytes or bytearray, not NoneType.".into();
                Value::Object(Obj::new())
            }
        };
        let command = match command_for(name, &args) {
            Ok(command) => command,
            Err(e) => {
                error.push_str(&e);
                Value::Null
            }
        };
        if !error.is_empty() {
            let text = format_error_text(format_error_template, error.trim(), true, finish_reason).unwrap_or_else(|e| e);
            return Err(err(text));
        }
        actions.push(action_value(&command, get(call, "id").cloned().unwrap_or(Value::Null)));
    }
    Ok(actions)
}

/// `parse_toolcall_actions_response`: Responses-API `function_call` items -> actions.
pub fn parse_response_actions(output: &[Value], format_error_template: &str, finish_reason: &Value) -> Result<Vec<Value>, Value> {
    let err = |text: String| json!({"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}], "extra": {"interrupt_type": "FormatError"}});
    let calls: Vec<&Value> = output.iter().filter(|i| get_str(i, "type") == Some("function_call")).collect();
    if calls.is_empty() {
        let text = format_error_text(format_error_template, "No tool calls found in the response. Every response MUST include at least one tool call.", false, finish_reason).unwrap_or_else(|e| e);
        return Err(err(text));
    }
    let mut actions = Vec::new();
    for call in calls {
        let raw = get_str(call, "arguments").unwrap_or("{}");
        let mut error = String::new();
        let args: Value = serde_json::from_str(raw).unwrap_or_else(|e| {
            error = format!("Error parsing tool call arguments: {}.", json_error_text(raw, &e));
            Value::Object(Obj::new())
        });
        let name = get_str(call, "name").unwrap_or("");
        let command = match command_for(name, &args) {
            Ok(command) => command,
            Err(e) => {
                error.push_str(&e);
                Value::Null
            }
        };
        if !error.is_empty() {
            let text = format_error_text(format_error_template, error.trim(), true, finish_reason).unwrap_or_else(|e| e);
            return Err(err(text));
        }
        let id = get(call, "call_id").filter(|v| !v.is_null() && v.as_str() != Some("")).or_else(|| get(call, "id")).cloned().unwrap_or(Value::Null);
        actions.push(action_value(&command, id));
    }
    Ok(actions)
}

pub fn not_executed() -> Value {
    json!({"output": "", "returncode": -1, "exception_info": "action was not executed"})
}

fn observation_extra(output: &Value) -> Obj {
    let mut extra = Obj::new();
    extra.insert("raw_output".into(), get(output, "output").cloned().unwrap_or(json!("")));
    extra.insert("returncode".into(), get(output, "returncode").cloned().unwrap_or(Value::Null));
    extra.insert("timestamp".into(), json!(now()));
    extra.insert("exception_info".into(), get(output, "exception_info").cloned().unwrap_or(Value::Null));
    if let Some(Value::Object(more)) = get(output, "extra") {
        for (k, v) in more {
            extra.insert(k.clone(), v.clone());
        }
    }
    extra
}

fn observation_vars(output: &Value, template_vars: &Value) -> Value {
    let mut vars = template_vars.as_object().cloned().unwrap_or_default();
    vars.insert("output".into(), output.clone());
    Value::Object(vars)
}

/// Images are a separate user turn after the tool result. Chat gateways often stringify
/// role=tool content, so putting pixels inside that result would silently destroy vision.
fn visual_observation(output: &Value, responses: bool) -> Option<Value> {
    let mut urls=Vec::new();
    if output.get("returncode").and_then(Value::as_i64)==Some(0) {
        if let Some(url)=output.get("image_url").and_then(Value::as_str) {urls.push(url);}
    }
    // codejs has already validated these as native image reads. Preserve explicitly
    // emitted images even if a later script action failed, like printed output.
    if output.pointer("/extra/tool").and_then(Value::as_str)==Some("codejs") {
        if let Some(items)=output.get("image_urls").and_then(Value::as_array) {
            urls.extend(items.iter().take(4).filter_map(Value::as_str));
        }
    }
    if urls.is_empty() {return None;}
    let caption=output.get("output").and_then(Value::as_str).unwrap_or("Image attachment from the preceding tool result.");
    let mut content=vec![if responses {json!({"type":"input_text","text":caption})} else {json!({"type":"text","text":caption})}];
    for url in urls {
        content.push(if responses {json!({"type":"input_image","image_url":url})} else {json!({"type":"image_url","image_url":{"url":url}})});
    }
    Some(json!({"role":"user","content":content,"extra":{"visual_attachment":true}}))
}

/// `format_toolcall_observation_messages` (chat completions): `role: tool` results.
pub fn toolcall_observations(message: &Value, outputs: &[Value], template: &str, template_vars: &Value, multimodal_regex: &str) -> Result<Vec<Value>, String> {
    let actions: Vec<Value> = get(message, "extra").and_then(|e| e.get("actions")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut results = Vec::new();
    let mut images = Vec::new();
    for (i, action) in actions.iter().enumerate() {
        let output = outputs.get(i).cloned().unwrap_or_else(not_executed);
        let content = render(template, &observation_vars(&output, template_vars))?;
        let mut msg = Obj::new();
        msg.insert("content".into(), json!(content));
        msg.insert("extra".into(), Value::Object(observation_extra(&output)));
        if let Some(id) = action.as_object().and_then(|a| a.get("tool_call_id")) {
            msg.insert("tool_call_id".into(), id.clone());
            msg.insert("role".into(), json!("tool"));
        } else {
            msg.insert("role".into(), json!("user"));
        }
        let mut msg = Value::Object(msg);
        if !multimodal_regex.is_empty() {
            msg = expand_multimodal(&msg, multimodal_regex);
        }
        results.push(msg);
        if let Some(image) = visual_observation(&output, false) { images.push(image); }
    }
    results.extend(images);
    Ok(results)
}

/// Responses API observations: `function_call_output` items.
pub fn response_observations(message: &Value, outputs: &[Value], template: &str, template_vars: &Value) -> Result<Vec<Value>, String> {
    let actions: Vec<Value> = get(message, "extra").and_then(|e| e.get("actions")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut results = Vec::new();
    let mut images = Vec::new();
    for (i, action) in actions.iter().enumerate() {
        let output = outputs.get(i).cloned().unwrap_or_else(not_executed);
        let content = render(template, &observation_vars(&output, template_vars))?;
        let mut msg = Obj::new();
        msg.insert("extra".into(), Value::Object(observation_extra(&output)));
        if let Some(id) = action.as_object().and_then(|a| a.get("tool_call_id")) {
            msg.insert("type".into(), json!("function_call_output"));
            msg.insert("call_id".into(), id.clone());
            msg.insert("output".into(), json!(content));
        } else {
            msg.insert("type".into(), json!("message"));
            msg.insert("role".into(), json!("user"));
            msg.insert("content".into(), json!([{"type": "input_text", "text": content}]));
        }
        results.push(Value::Object(msg));
        if let Some(image) = visual_observation(&output, true) { images.push(image); }
    }
    results.extend(images);
    Ok(results)
}

/// `actions_text.format_observation_messages`: one `user` message per output.
pub fn text_observations(outputs: &[Value], template: &str, template_vars: &Value, multimodal_regex: &str) -> Result<Vec<Value>, String> {
    let mut results = Vec::new();
    for output in outputs {
        let content = render(template, &observation_vars(output, template_vars))?;
        let mut msg = json!({"role": "user", "content": content, "extra": observation_extra(output)});
        if !multimodal_regex.is_empty() {
            msg = expand_multimodal(&msg, multimodal_regex);
        }
        results.push(msg);
        if let Some(image) = visual_observation(&output, false) { results.push(image); }
    }
    Ok(results)
}

/// `expand_multimodal_content` on a message dict (or content string/list).
pub fn expand_multimodal(value: &Value, pattern: &str) -> Value {
    if pattern.is_empty() {
        return value.clone();
    }
    let re = match regex::Regex::new(pattern) {
        Ok(r) => r,
        Err(_) => return value.clone(),
    };
    fn expand(v: &Value, re: &regex::Regex) -> Value {
        match v {
            Value::String(s) => {
                let mut out = Vec::new();
                let mut last = 0;
                let mut any = false;
                for caps in re.captures_iter(s) {
                    any = true;
                    let m = caps.get(0).unwrap();
                    if m.start() > last {
                        out.push(json!({"type": "text", "text": &s[last..m.start()]}));
                    }
                    let kind = caps.get(1).map(|c| c.as_str().trim()).unwrap_or("");
                    let body = caps.get(2).map(|c| c.as_str().trim()).unwrap_or("");
                    if kind == "image_url" {
                        out.push(json!({"type": "image_url", "image_url": {"url": body}}));
                    }
                    last = m.end();
                }
                if !any {
                    return json!([{"type": "text", "text": s}]);
                }
                if last < s.len() {
                    out.push(json!({"type": "text", "text": &s[last..]}));
                }
                Value::Array(out)
            }
            Value::Array(a) => Value::Array(a.iter().map(|x| expand(x, re)).collect()),
            Value::Object(o) => {
                if !o.contains_key("content") {
                    return v.clone();
                }
                let mut o = o.clone();
                let c = expand(&o["content"], re);
                o.insert("content".into(), c);
                Value::Object(o)
            }
            other => Value::String(match other {
                Value::Null => "None".into(),
                x => py_json(x, false),
            }),
        }
    }
    expand(value, &re)
}

/// Text of a content (string, or text/thinking blocks), like `compaction.text_of`.
pub fn text_of(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a
            .iter()
            .filter_map(|b| b.as_object())
            .map(|b| {
                b.get("text").and_then(Value::as_str).filter(|s| !s.is_empty()).or_else(|| b.get("thinking").and_then(Value::as_str)).unwrap_or("").to_string()
            })
            .collect(),
        _ => String::new(),
    }
}

#[cfg(test)]
mod tests {
    /// The dispatcher has no shell: bash, cu and the file tools are refused before anything runs,
    /// and the subagent tools are not offered to either queue profile.
    #[test]
    fn queue_profiles_gate_the_tools() {
        let _g = crate::queue_tools::TEST_ENV.lock().unwrap();
        std::env::set_var("MINITUI_AGENT_TOOLS", "1");
        std::env::set_var("MINI_AGENT_TOOLSET", "dispatcher");
        for (name, args) in [("bash", json!({"command": "touch /tmp/x"})), ("cu", json!({"args": "snapshot"})), ("write", json!({"path": "a", "content": "b"})), ("agent_delegate", json!({"task": "t"}))] {
            assert!(command_for(name, &args).is_err(), "{name} must be refused for the dispatcher");
        }
        assert!(command_for("task_create", &json!({"title": "t"})).is_ok());
        std::env::set_var("MINI_AGENT_TOOLSET", "worker");
        std::env::set_var("MINITUI_TASK_ID", "t1");
        assert!(command_for("bash", &json!({"command": "ls"})).is_ok());
        assert!(command_for("agent_delegate", &json!({"task": "t"})).is_err(), "workers do not delegate");
        assert!(command_for("task_create", &json!({"title": "t"})).is_err(), "workers do not create tasks");
        assert!(command_for("task_update", &json!({"description": "d"})).is_ok());
        for k in ["MINI_AGENT_TOOLSET", "MINITUI_TASK_ID", "MINITUI_AGENT_TOOLS"] {
            std::env::remove_var(k);
        }
    }

    use super::*;

    const TPL: &str = "{{error}}|{{has_tool_calls}}";

    #[test]
    fn cu_tool_calls_become_cu_commands() {
        let calls = vec![json!({"id": "c1", "type": "function", "function": {"name": "cu", "arguments": "{\"args\": \"snapshot --tab t3\"}"}})];
        let actions = parse_toolcall_actions(&calls, TPL, &Value::Null).unwrap();
        assert_eq!(actions[0]["command"], json!("cu snapshot --tab t3"));
        assert_eq!(actions[0]["tool_call_id"], json!("c1"));
    }

    #[test]
    fn cu_tool_in_responses_shape() {
        let out = vec![json!({"type": "function_call", "call_id": "c1", "name": "cu", "arguments": "{\"args\": \"tab open https://example.com\"}"})];
        let actions = parse_response_actions(&out, TPL, &Value::Null).unwrap();
        assert_eq!(actions[0]["command"], json!("cu tab open https://example.com"));
        assert_eq!(actions[0]["tool_call_id"], json!("c1"));
    }

    #[test]
    fn cu_tool_needs_args_and_unknown_still_errors() {
        for args in ["{}", "{\"args\": \"\"}", "{\"args\": 5}"] {
            let calls = vec![json!({"id": "c1", "function": {"name": "cu", "arguments": args}})];
            let e = parse_toolcall_actions(&calls, TPL, &Value::Null).unwrap_err();
            assert_eq!(e["content"], "Missing 'args' argument in cu tool call.|True", "{args}");
        }
        let no_args = vec![json!({"type": "function_call", "call_id": "c1", "name": "cu", "arguments": "{}"})];
        let e = parse_response_actions(&no_args, TPL, &Value::Null).unwrap_err();
        assert_eq!(e["content"][0]["text"], "Missing 'args' argument in cu tool call.|True");
        let unknown = vec![json!({"id": "c1", "function": {"name": "grep", "arguments": "{}"}})];
        let e = parse_toolcall_actions(&unknown, TPL, &Value::Null).unwrap_err();
        assert_eq!(e["content"], "Unknown tool 'grep'.Missing 'command' argument in bash tool call.|True");
    }

    #[test]
    fn parses_bash_calls() {
        let calls = vec![json!({"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\": \"ls\"}"}})];
        let actions = parse_toolcall_actions(&calls, TPL, &Value::Null).unwrap();
        assert_eq!(actions, vec![json!({"command": "ls", "tool_call_id": "c1"})]);
    }

    #[test]
    fn recovers_mimo_xml_with_linear_parameter_types() {
        let text = concat!(
            "<tool_call><function=mcp__linear__save_issue>",
            "<parameter=team>BIZ</parameter>",
            "<parameter=priority>1</parameter>",
            "<parameter=addLabels>[\"Bug\"]</parameter>",
            "<parameter=links>[{\"url\":\"https://github.com/o/r/issues/191\",\"title\":\"GH #191\"}]</parameter>",
            "<parameter=description>Primera línea\nSegunda línea</parameter>",
            "</function></tool_call>",
            "<tool_call><function=mcp__linear__list_issues><parameter=limit>5</parameter><parameter=query>DEBUG</parameter></function></tool_call>"
        );
        let calls = recover_xml_tool_calls(text).unwrap();
        assert_eq!(calls.len(), 2);
        let args: Value = serde_json::from_str(calls[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["team"], "BIZ");
        assert_eq!(args["priority"], 1);
        assert_eq!(args["addLabels"], json!(["Bug"]));
        assert_eq!(args["links"][0]["url"], "https://github.com/o/r/issues/191");
        assert_eq!(args["description"], "Primera línea\nSegunda línea");
        assert_eq!(calls[1]["function"]["name"], "mcp__linear__list_issues");
        assert!(recover_xml_tool_calls("<tool_call><function=bash>").is_err());
        let from_t14 = "<tool_call><function=mcp__linear__save_issue><parameter=description>Prueba secuencial simple: proyecto y milestone por nombre.</parameter><parameter=milestone>SEO: cimientos técnicos (rastreo, i18n, metadatos, render, medición)</parameter><parameter=project>NewVillacarmen</parameter><parameter=team>BIZ</parameter><parameter=title>[DEBUG3] save_issue con proyecto y milestone</parameter></function></tool_call>";
        let recovered = recover_xml_tool_calls(from_t14).unwrap();
        let args: Value = serde_json::from_str(recovered[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["project"], "NewVillacarmen");
        assert_eq!(args["milestone"], "SEO: cimientos técnicos (rastreo, i18n, metadatos, render, medición)");
        let gh_title = "<tool_call><function=mcp__linear__save_issue><parameter=project>NewVillacarmen</parameter><parameter=team>BIZ</parameter><parameter=title>[GH preactvillacarmen #191] [P0] Corregir rastreo</parameter></function></tool_call>";
        let recovered = recover_xml_tool_calls(gh_title).unwrap();
        let args: Value = serde_json::from_str(recovered[0]["function"]["arguments"].as_str().unwrap()).unwrap();
        assert_eq!(args["title"], "[GH preactvillacarmen #191] [P0] Corregir rastreo");
    }

    #[test]
    fn format_errors() {
        let e = parse_toolcall_actions(&[], TPL, &Value::Null).unwrap_err();
        assert_eq!(e["content"], "No tool calls found in the response. Every response MUST include at least one tool call.|False");
        let calls = vec![json!({"id": "c1", "function": {"name": "python", "arguments": "{}"}})];
        let e = parse_toolcall_actions(&calls, TPL, &Value::Null).unwrap_err();
        assert_eq!(e["content"], "Unknown tool 'python'.Missing 'command' argument in bash tool call.|True");
        let calls = vec![json!({"id": "c1", "function": {"name": "bash", "arguments": "not json"}})];
        let e = parse_toolcall_actions(&calls, TPL, &Value::Null).unwrap_err();
        // The JSON decoder's own wording differs from Python's; the structure is the same.
        let text = e["content"].as_str().unwrap();
        assert!(text.starts_with("Error parsing tool call arguments: "), "{text}");
        assert!(text.ends_with(".Missing 'command' argument in bash tool call.|True"), "{text}");
    }

    #[test]
    fn observations_pad_missing_outputs() {
        let msg = json!({"extra": {"actions": [{"command": "a", "tool_call_id": "1"}, {"command": "b", "tool_call_id": "2"}]}});
        let out = toolcall_observations(&msg, &[json!({"output": "x", "returncode": 0, "exception_info": ""})], "{{output.returncode}}:{{output.output}}", &json!({}), "").unwrap();
        assert_eq!(out.len(), 2);
        assert_eq!(out[0]["content"], "0:x");
        assert_eq!(out[1]["content"], "-1:");
        assert_eq!(out[1]["extra"]["exception_info"], "action was not executed");
        assert_eq!(out[1]["role"], "tool");
    }

    #[test]
    fn multimodal() {
        let re = r"(?s)<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>(.+?)</CONTENT_TYPE>(.+?)</MSWEA_MULTIMODAL_CONTENT>";
        let v = expand_multimodal(&json!({"role": "user", "content": "a<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>image_url</CONTENT_TYPE>http://x</MSWEA_MULTIMODAL_CONTENT>b"}), re);
        assert_eq!(v["content"], json!([{"type": "text", "text": "a"}, {"type": "image_url", "image_url": {"url": "http://x"}}, {"type": "text", "text": "b"}]));
    }
}
