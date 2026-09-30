//! Message shapes shared by the models: parsing bash tool calls, formatting observations,
//! and the multimodal expansion, exactly as `actions_toolcall*.py` / `actions_text.py` do.

use crate::templates::render;
use crate::util::{get, get_str, now, py_json, Obj};
use serde_json::{json, Value};

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

fn format_error_text(template: &str, error: &str, has_tool_calls: bool, finish_reason: &Value) -> Result<String, String> {
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
        if name != "bash" {
            error.push_str(&format!("Unknown tool '{name}'."));
        }
        if !args.as_object().is_some_and(|o| o.contains_key("command")) {
            error.push_str("Missing 'command' argument in bash tool call.");
        }
        if !error.is_empty() {
            let text = format_error_text(format_error_template, error.trim(), true, finish_reason).unwrap_or_else(|e| e);
            return Err(err(text));
        }
        actions.push(json!({"command": args["command"], "tool_call_id": get(call, "id").cloned().unwrap_or(Value::Null)}));
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
        if name != "bash" {
            error.push_str(&format!("Unknown tool '{name}'."));
        }
        if !args.as_object().is_some_and(|o| o.contains_key("command")) {
            error.push_str("Missing 'command' argument in bash tool call.");
        }
        if !error.is_empty() {
            let text = format_error_text(format_error_template, error.trim(), true, finish_reason).unwrap_or_else(|e| e);
            return Err(err(text));
        }
        let id = get(call, "call_id").filter(|v| !v.is_null() && v.as_str() != Some("")).or_else(|| get(call, "id")).cloned().unwrap_or(Value::Null);
        actions.push(json!({"command": args["command"], "tool_call_id": id}));
    }
    Ok(actions)
}

fn not_executed() -> Value {
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

/// `format_toolcall_observation_messages` (chat completions): `role: tool` results.
pub fn toolcall_observations(message: &Value, outputs: &[Value], template: &str, template_vars: &Value, multimodal_regex: &str) -> Result<Vec<Value>, String> {
    let actions: Vec<Value> = get(message, "extra").and_then(|e| e.get("actions")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut results = Vec::new();
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
    }
    Ok(results)
}

/// Responses API observations: `function_call_output` items.
pub fn response_observations(message: &Value, outputs: &[Value], template: &str, template_vars: &Value) -> Result<Vec<Value>, String> {
    let actions: Vec<Value> = get(message, "extra").and_then(|e| e.get("actions")).and_then(Value::as_array).cloned().unwrap_or_default();
    let mut results = Vec::new();
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
    }
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
    use super::*;

    const TPL: &str = "{{error}}|{{has_tool_calls}}";

    #[test]
    fn parses_bash_calls() {
        let calls = vec![json!({"id": "c1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\": \"ls\"}"}})];
        let actions = parse_toolcall_actions(&calls, TPL, &Value::Null).unwrap();
        assert_eq!(actions, vec![json!({"command": "ls", "tool_call_id": "c1"})]);
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
