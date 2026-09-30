//! The direct clients. One `WireModel` speaks one of three protocols, configured the way the
//! Python classes configure themselves (`OpenaiCompatModel` and its gateway subclasses,
//! `AnthropicCompatModel`, `ResponsesCompatModel`, the OpenCode Go facade).

use super::cache_control::set_cache_control;
use super::http::{post_chat_stream, post_json, usage_of, with_retry};
use super::prices;
use super::shapes::{anthropic_bash_tool, bash_tool, bash_tool_responses, expand_multimodal, parse_response_actions, parse_toolcall_actions, response_observations, toolcall_observations};
use super::{DeltaSink, Model, ModelError, Reply};
use crate::util::{get, get_str, now, Obj};
use serde_json::{json, Value};

#[derive(Clone, Copy, PartialEq, Eq, Debug)]
pub enum Protocol {
    Chat,
    Messages,
    Responses,
}

/// Provider-specific behavior layered on the shared protocol code.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Flavor {
    Plain,
    Deepseek,
    Openai,
    OpencodeGo,
}

pub struct WireModel {
    /// Everything `serialize()` reports (the Python config's `model_dump`).
    pub config: Obj,
    pub protocol: Protocol,
    pub flavor: Flavor,
    /// `module.Class` recorded as `model_type`.
    pub model_type: String,
    /// Provider key for price lookups.
    pub price_provider: String,
    /// The id sent upstream.
    pub wire_name: String,
    pub api_base: String,
    pub api_key: String,
}

const LITELLM_ONLY: [&str; 5] = ["drop_params", "custom_llm_provider", "api_base", "api_key", "timeout"];
const WIRE_KEYS: [&str; 5] = ["role", "content", "tool_calls", "tool_call_id", "name"];
const THINKING: [&str; 2] = ["thinking", "redacted_thinking"];

impl WireModel {
    fn cfg_str(&self, key: &str) -> Option<String> {
        self.config.get(key).and_then(Value::as_str).map(String::from)
    }

    fn model_kwargs(&self) -> Obj {
        self.config.get("model_kwargs").and_then(Value::as_object).cloned().unwrap_or_default()
    }

    fn params(&self) -> (Obj, Vec<(String, String)>) {
        let mut params: Obj = self.model_kwargs().into_iter().filter(|(k, _)| !LITELLM_ONLY.contains(&k.as_str())).collect();
        let mut headers = Vec::new();
        if let Some(Value::Object(h)) = params.shift_remove("extra_headers") {
            for (k, v) in h {
                headers.push((k, v.as_str().map(String::from).unwrap_or_else(|| v.to_string())));
            }
        }
        (params, headers)
    }

    fn timeout(&self) -> f64 {
        self.config.get("request_timeout").and_then(Value::as_f64).unwrap_or(600.0)
    }

    fn auth_headers(&self) -> Vec<(String, String)> {
        match self.protocol {
            Protocol::Messages => vec![
                ("x-api-key".into(), self.api_key.clone()),
                ("anthropic-version".into(), self.cfg_str("api_version").unwrap_or_else(|| "2023-06-01".into())),
            ],
            _ if self.api_key.is_empty() => vec![],
            _ => vec![("Authorization".into(), format!("Bearer {}", self.api_key))],
        }
    }

    fn go_keep_reasoning(&self) -> bool {
        let name = self.wire_name.to_lowercase();
        super::go_catalog::REASONING_CONTENT_MODELS.contains(&name.as_str())
    }

    /// `_go_filter_messages`: every key but `extra`, `developer` -> `system`, reasoning only
    /// for the backends that need it echoed.
    fn go_filter(&self, messages: &[Value]) -> Vec<Value> {
        let keep = self.go_keep_reasoning();
        messages
            .iter()
            .filter_map(|m| m.as_object())
            .map(|m| {
                let mut o: Obj = m.iter().filter(|(k, _)| k.as_str() != "extra").map(|(k, v)| (k.clone(), v.clone())).collect();
                if o.get("role").and_then(Value::as_str) == Some("developer") {
                    let mut n = Obj::new();
                    n.insert("role".into(), json!("system"));
                    for (k, v) in o.iter().filter(|(k, _)| k.as_str() != "role") {
                        n.insert(k.clone(), v.clone());
                    }
                    o = n;
                }
                if !keep {
                    o.shift_remove("reasoning_content");
                }
                Value::Object(o)
            })
            .collect()
    }

    fn chat_messages(&self, messages: &[Value]) -> Vec<Value> {
        let prepared: Vec<Value> = if self.flavor == Flavor::OpencodeGo {
            self.go_filter(messages)
        } else {
            messages
                .iter()
                .map(|m| {
                    let mut o = Obj::new();
                    for k in WIRE_KEYS {
                        if let Some(v) = m.get(k) {
                            o.insert(k.into(), v.clone());
                        }
                    }
                    Value::Object(o)
                })
                .collect()
        };
        let prepared = reorder_thinking(prepared);
        if self.flavor == Flavor::OpencodeGo {
            return prepared; // the Go chat flavor sends no cache markers
        }
        set_cache_control(&prepared, self.cfg_str("set_cache_control").as_deref(), self.cfg_str("cache_ttl").as_deref())
    }

    fn query_chat(&mut self, messages: &[Value], sink: &mut Option<DeltaSink>) -> Result<Value, ModelError> {
        let (params, mut headers) = self.params();
        headers.extend(self.auth_headers());
        let mut body = json!({"model": self.wire_name, "messages": self.chat_messages(messages), "tools": [bash_tool()]});
        for (k, v) in params {
            body[k] = v;
        }
        let data = post_chat_stream(&self.api_base, &body, &headers, self.timeout(), sink)?;
        if data.get("choices").and_then(Value::as_array).is_none_or(|c| c.is_empty()) {
            return Err(ModelError { message: format!("response without choices from {}: {}", self.api_base, data.to_string().chars().take(300).collect::<String>()), status: None, abort: false, kind: "ProviderError".into() });
        }
        Ok(data)
    }

    fn query_messages(&mut self, messages: &[Value]) -> Result<Value, ModelError> {
        let prepared = if self.flavor == Flavor::OpencodeGo {
            let p = reorder_thinking(self.go_filter(messages));
            match self.cfg_str("set_cache_control") {
                Some(mode) => set_cache_control(&p, Some(&mode), None),
                None => p,
            }
        } else {
            self.chat_messages(messages)
        };
        let (system, wire) = to_anthropic_messages(&prepared);
        let (mut params, mut headers) = self.params();
        headers.extend(self.auth_headers());
        let tool_choice = tool_choice(params.shift_remove("tool_choice"), params.shift_remove("parallel_tool_calls"));
        let max_tokens = params.shift_remove("max_tokens").unwrap_or_else(|| self.config.get("max_tokens").cloned().unwrap_or(json!(8192)));
        let mut body = json!({"model": self.wire_name, "messages": wire, "tools": [anthropic_bash_tool()], "max_tokens": max_tokens});
        for (k, v) in params {
            body[k] = v;
        }
        if let Some(tc) = &tool_choice {
            body["tool_choice"] = tc.clone();
        }
        if !system.is_empty() {
            body["system"] = Value::Array(system);
        }
        let data = match post_json(&self.api_base, "/messages", &body, &headers, self.timeout()) {
            Ok(d) => d,
            Err(e) if e.status == Some(400) && tool_choice.is_some() => {
                body.as_object_mut().unwrap().shift_remove("tool_choice");
                post_json(&self.api_base, "/messages", &body, &headers, self.timeout())?
            }
            Err(e) => return Err(e),
        };
        if data.get("content").is_none() {
            return Err(ModelError { message: format!("response without content from {}: {}", self.api_base, data.to_string().chars().take(300).collect::<String>()), status: None, abort: false, kind: "Exception".into() });
        }
        Ok(normalize_anthropic(data))
    }

    fn responses_input(&self, messages: &[Value]) -> Vec<Value> {
        let messages = if self.flavor == Flavor::OpencodeGo { self.go_filter(messages) } else { messages.to_vec() };
        let mut out = Vec::new();
        for m in &messages {
            if get_str(m, "object") == Some("response") {
                for item in get(m, "output").and_then(Value::as_array).cloned().unwrap_or_default() {
                    out.push(strip_extra(&item));
                }
            } else {
                out.push(strip_extra(m));
            }
        }
        out
    }

    fn query_responses(&mut self, messages: &[Value]) -> Result<Value, ModelError> {
        let (params, mut headers) = self.params();
        headers.extend(self.auth_headers());
        let mut body = json!({"model": self.wire_name, "input": self.responses_input(messages), "tools": [bash_tool_responses()]});
        for (k, v) in params {
            body[k] = v;
        }
        post_json(&self.api_base, "/responses", &body, &headers, self.timeout())
    }

    /// One raw request, with the provider-specific error handling of the Python subclasses.
    fn raw_query(&mut self, messages: &[Value], sink: &mut Option<DeltaSink>) -> Result<Value, ModelError> {
        if self.flavor == Flavor::OpencodeGo {
            return self.go_query(messages, sink);
        }
        let result = self.protocol_query(messages, sink);
        match (&self.flavor, result) {
            (Flavor::Openai, Err(e)) if is_temperature_error(&e) && self.model_kwargs().contains_key("temperature") => {
                if let Some(Value::Object(k)) = self.config.get_mut("model_kwargs") {
                    k.shift_remove("temperature");
                }
                self.protocol_query(messages, sink)
            }
            (Flavor::Deepseek, Err(e)) => Err(deepseek_error(e)),
            (_, r) => r,
        }
    }

    fn protocol_query(&mut self, messages: &[Value], sink: &mut Option<DeltaSink>) -> Result<Value, ModelError> {
        match self.protocol {
            Protocol::Chat => self.query_chat(messages, sink),
            Protocol::Messages => self.query_messages(messages),
            Protocol::Responses => self.query_responses(messages),
        }
    }

    /// `_GoQueryGuardMixin._query`: request ids and the gateway's error rewrites.
    fn go_query(&mut self, messages: &[Value], sink: &mut Option<DeltaSink>) -> Result<Value, ModelError> {
        {
            let kwargs = self.config.get_mut("model_kwargs").and_then(Value::as_object_mut).unwrap();
            let headers = kwargs.entry("extra_headers").or_insert_with(|| json!({}));
            if let Some(h) = headers.as_object_mut() {
                if !h.keys().any(|k| k.eq_ignore_ascii_case("x-request-id")) {
                    h.insert("x-request-id".into(), json!(crate::util_hex(32)));
                }
            }
        }
        let result = self.protocol_query(messages, sink);
        if let Some(Value::Object(k)) = self.config.get_mut("model_kwargs") {
            if let Some(Value::Object(h)) = k.get_mut("extra_headers") {
                h.shift_remove("x-request-id"); // a fresh id per request
            }
        }
        let e = match result {
            Ok(v) => return Ok(v),
            Err(e) => e,
        };
        if matches!(e.status, Some(500..=504)) {
            eprintln!("WARNING: checkpoint=upstream_unavailable provider=opencode-go model={}: OpenCode Go returned a service-unavailable response; mini will apply its bounded retry policy.", self.wire_name);
            return Err(e);
        }
        if e.status != Some(400) {
            return Err(e);
        }
        let text = e.message.clone();
        if text.contains("MissingSessionID") || text.to_lowercase().contains("x-opencode-session") {
            return Err(ModelError { message: "OpenCode Go requires a stable 'x-opencode-session' header on every request, which mini-swe-agent sends automatically. Set OPENCODE_GO_SESSION to pin one.".into(), status: e.status, abort: true, kind: "ProviderAbortError".into() });
        }
        if is_opaque_gateway_error(&text) {
            return Err(ModelError { message: format!("{text} (OpenCode Go returned no error detail; retrying)"), status: e.status, abort: false, kind: "ProviderError".into() });
        }
        let sampling = regex::Regex::new(r"(?is)(temperature|reasoning_effort|response_format|top_p|top_k).{0,80}(not supported|unsupported|does not support|not allowed)").unwrap();
        if sampling.is_match(&text) {
            let lowered = text.to_lowercase();
            let mut stripped = false;
            if let Some(Value::Object(k)) = self.config.get_mut("model_kwargs") {
                for p in ["temperature", "reasoning_effort", "top_p", "top_k", "response_format"] {
                    if lowered.contains(p) && k.contains_key(p) {
                        k.shift_remove(p);
                        stripped = true;
                        break;
                    }
                }
            }
            if stripped {
                return self.protocol_query(messages, sink);
            }
        }
        if regex::Regex::new(r"(?is)(model.{0,80}(not found|unknown|unsupported|does not exist|not available)|unknown model|invalid model)").unwrap().is_match(&text) {
            return Err(ModelError { message: format!("{text} Use an id from `mini-extra opencode-go-models`."), status: e.status, abort: true, kind: "ProviderAbortError".into() });
        }
        if regex::Regex::new(r"(?i)(invalid api key|incorrect api key|invalid_token|unauthorized|authentication fail|bearer)").unwrap().is_match(&text) {
            return Err(ModelError { message: format!("{text} You can permanently set your API key with `mini-extra config set OPENCODE_GO_API_KEY YOUR_KEY`."), status: e.status, abort: true, kind: "ProviderAbortError".into() });
        }
        Err(e)
    }

    fn cost(&self, response: &Value) -> Result<f64, ModelError> {
        let name = self.config.get("model_name").and_then(Value::as_str).unwrap_or("");
        if prices::price_for(&self.price_provider, name).is_none() {
            if self.cfg_str("cost_tracking").as_deref() != Some("ignore_errors") {
                return Err(ModelError { message: format!("Error calculating cost for model {name}: no price row in models/prices.py (perhaps it's not registered?). You can ignore this issue from your config file with cost_tracking: 'ignore_errors' or globally with export MSWEA_COST_TRACKING='ignore_errors'."), status: None, abort: true, kind: "RuntimeError".into() });
            }
            return Ok(0.0);
        }
        Ok(prices::cost_for(&self.price_provider, name, &usage_of(response)))
    }

    fn format_error_template(&self) -> String {
        self.cfg_str("format_error_template").unwrap_or_else(|| "{{ error }}".into())
    }

    fn chat_reply(&self, response: Value, cost: f64) -> Reply {
        let choice = response["choices"][0].clone();
        let msg = choice.get("message").cloned().unwrap_or_else(|| json!({}));
        let tool_calls = msg.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default();
        let content = msg.get("content").cloned().unwrap_or(Value::Null);
        let final_answer = if self.protocol == Protocol::Messages {
            if tool_calls.is_empty() {
                let text = match &content {
                    Value::String(s) => s.clone(),
                    Value::Array(blocks) => blocks.iter().filter(|b| get_str(b, "type") == Some("text")).filter_map(|b| get_str(b, "text")).collect(),
                    _ => String::new(),
                };
                Some(text.trim().to_string()).filter(|t| !t.is_empty())
            } else {
                None
            }
        } else if tool_calls.is_empty() {
            content.as_str().map(|s| s.trim().to_string()).filter(|s| !s.is_empty())
        } else {
            None
        };
        let actions = if final_answer.is_some() {
            vec![]
        } else {
            let finish = choice.get("finish_reason").cloned().unwrap_or(Value::Null);
            match parse_toolcall_actions(&tool_calls, &self.format_error_template(), &finish) {
                Ok(a) => a,
                Err(mut e) => {
                    e["extra"]["cost"] = json!(cost);
                    e["extra"]["response"] = response;
                    return Reply::FormatError(vec![e]);
                }
            }
        };
        let mut message = json!({"role": "assistant", "content": content});
        if !tool_calls.is_empty() {
            message["tool_calls"] = Value::Array(tool_calls);
        }
        if let Some(r) = msg.get("reasoning_content").filter(|r| !r.is_null() && r.as_str() != Some("")) {
            message["reasoning_content"] = r.clone();
        }
        let mut extra = json!({"actions": actions, "response": response, "cost": cost, "timestamp": now()});
        if let Some(a) = final_answer {
            extra["submission"] = json!(a);
        }
        message["extra"] = extra;
        Reply::Message(message)
    }

    fn responses_reply(&self, response: Value, cost: f64) -> Reply {
        let output = response.get("output").and_then(Value::as_array).cloned().unwrap_or_default();
        let mut texts = Vec::new();
        let mut has_call = false;
        for item in &output {
            match get_str(item, "type") {
                Some("function_call") => has_call = true,
                Some("message") => {
                    for b in item.get("content").and_then(Value::as_array).cloned().unwrap_or_default() {
                        if let Some(t) = b.get("text").and_then(Value::as_str) {
                            texts.push(t.to_string());
                        }
                    }
                }
                _ => {}
            }
        }
        let final_answer = if has_call { None } else { Some(texts.join("\n").trim().to_string()).filter(|t| !t.is_empty()) };
        let actions = if final_answer.is_some() {
            vec![]
        } else {
            let status = response.get("status").cloned().unwrap_or(Value::Null);
            let finish = if status.as_str() == Some("incomplete") && response.pointer("/incomplete_details/reason").and_then(Value::as_str) == Some("max_output_tokens") { json!("length") } else { status };
            match parse_response_actions(&output, &self.format_error_template(), &finish) {
                Ok(a) => a,
                Err(mut e) => {
                    e["extra"]["cost"] = json!(cost);
                    e["extra"]["response"] = response;
                    return Reply::FormatError(vec![e]);
                }
            }
        };
        let mut message = response;
        let mut extra = json!({"actions": actions, "cost": cost, "timestamp": now()});
        if let Some(a) = final_answer {
            extra["submission"] = json!(a);
        }
        message["extra"] = extra;
        Reply::Message(message)
    }
}

impl Model for WireModel {
    fn query(&mut self, messages: &[Value], sink: Option<DeltaSink>) -> Result<Reply, ModelError> {
        let mut sink = sink;
        let response = with_retry(|| self.raw_query(messages, &mut sink))?;
        let cost = self.cost(&response)?;
        Ok(match self.protocol {
            Protocol::Responses => self.responses_reply(response, cost),
            _ => self.chat_reply(response, cost),
        })
    }

    fn format_message(&self, role: &str, content: &str, extra: Option<Obj>) -> Value {
        let mut m = json!({"role": role, "content": content});
        if let Some(e) = extra {
            m["extra"] = Value::Object(e);
        }
        let re = self.cfg_str("multimodal_regex").unwrap_or_default();
        if self.protocol == Protocol::Responses || re.is_empty() {
            return m;
        }
        expand_multimodal(&m, &re)
    }

    fn format_observation_messages(&self, message: &Value, outputs: &[Value], template_vars: &Value) -> Result<Vec<Value>, String> {
        let template = self.cfg_str("observation_template").unwrap_or_default();
        match self.protocol {
            Protocol::Responses => response_observations(message, outputs, &template, template_vars),
            _ => toolcall_observations(message, outputs, &template, template_vars, &self.cfg_str("multimodal_regex").unwrap_or_default()),
        }
    }

    fn template_vars(&self) -> Obj {
        self.config.clone()
    }

    fn serialize(&self) -> Value {
        let mut config = self.config.clone();
        let has_key = config.get("api_key").and_then(Value::as_str).is_some_and(|k| !k.is_empty());
        config.insert("api_key".into(), json!(if has_key { "***" } else { "" }));
        json!({"info": {"config": {"model": config, "model_type": self.model_type}}})
    }

    fn model_name(&self) -> String {
        self.cfg_str("model_name").unwrap_or_default()
    }

    fn context_window(&self) -> i64 {
        self.config.get("context_window").and_then(Value::as_i64).unwrap_or(0)
    }

    fn streams(&self) -> bool {
        // The OpenCode Go facade does not forward `set_delta_sink` to its client, so the
        // Python agent never streams partial output for it; neither does this one.
        self.protocol == Protocol::Chat && self.flavor != Flavor::OpencodeGo
    }
}

fn strip_extra(v: &Value) -> Value {
    match v.as_object() {
        Some(o) => Value::Object(o.iter().filter(|(k, _)| k.as_str() != "extra").map(|(k, v)| (k.clone(), v.clone())).collect()),
        None => v.clone(),
    }
}

fn is_thinking(b: &Value) -> bool {
    get_str(b, "type").is_some_and(|t| THINKING.contains(&t))
}

/// Thinking blocks first in assistant messages (an Anthropic requirement).
fn reorder_thinking(messages: Vec<Value>) -> Vec<Value> {
    messages
        .into_iter()
        .map(|mut m| {
            if get_str(&m, "role") == Some("assistant") {
                if let Some(Value::Array(content)) = m.get("content").cloned() {
                    let thinking: Vec<Value> = content.iter().filter(|b| is_thinking(b)).cloned().collect();
                    if !thinking.is_empty() {
                        let other: Vec<Value> = content.iter().filter(|b| !is_thinking(b)).cloned().collect();
                        let mut blocks = thinking;
                        if other.is_empty() {
                            blocks.push(json!({"type": "text", "text": ""}));
                        } else {
                            blocks.extend(other);
                        }
                        m["content"] = Value::Array(blocks);
                    }
                }
            }
            m
        })
        .collect()
}

fn text_blocks_only(content: &Value) -> String {
    match content {
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().filter(|b| get_str(b, "type") == Some("text")).filter_map(|b| get_str(b, "text")).collect(),
        _ => String::new(),
    }
}

fn content_blocks(content: &Value) -> Vec<Value> {
    match content {
        Value::Null => vec![],
        Value::String(s) if s.is_empty() => vec![],
        Value::String(s) => vec![json!({"type": "text", "text": s})],
        Value::Array(a) => {
            let mut out = Vec::new();
            for b in a {
                let Some(o) = b.as_object() else { continue };
                let t = o.get("type").and_then(Value::as_str).unwrap_or("");
                if ["text", "thinking", "redacted_thinking", "tool_use", "tool_result", "image"].contains(&t) {
                    out.push(b.clone());
                } else if let Some(text) = o.get("text").and_then(Value::as_str) {
                    let mut blk = json!({"type": "text", "text": text});
                    if let Some(cc) = o.get("cache_control") {
                        blk["cache_control"] = cc.clone();
                    }
                    out.push(blk);
                }
            }
            out
        }
        _ => vec![],
    }
}

/// mini's history -> (`system` blocks, alternating `messages`) for the Messages API.
pub fn to_anthropic_messages(messages: &[Value]) -> (Vec<Value>, Vec<Value>) {
    let mut system = Vec::new();
    let mut wire: Vec<Value> = Vec::new();
    let mut pending: Vec<Value> = Vec::new();
    fn push(wire: &mut Vec<Value>, role: &str, blocks: Vec<Value>) {
        if blocks.is_empty() {
            return;
        }
        if let Some(last) = wire.last_mut() {
            if last["role"] == role {
                last["content"].as_array_mut().unwrap().extend(blocks);
                return;
            }
        }
        wire.push(json!({"role": role, "content": blocks}));
    }
    let flush = |wire: &mut Vec<Value>, pending: &mut Vec<Value>| {
        if !pending.is_empty() {
            wire.push(json!({"role": "user", "content": std::mem::take(pending)}));
        }
    };
    for m in messages {
        if !m.is_object() {
            continue;
        }
        let role = get_str(m, "role").unwrap_or("");
        let marker = m.get("cache_control").cloned();
        if role == "system" || role == "developer" {
            system.extend(content_blocks(m.get("content").unwrap_or(&Value::Null)));
            continue;
        }
        if role == "tool" {
            let mut result = json!({"type": "tool_result", "tool_use_id": get_str(m, "tool_call_id").unwrap_or(""), "content": text_blocks_only(m.get("content").unwrap_or(&Value::Null))});
            if let Some(mk) = marker.filter(|x| !x.is_null()) {
                result["cache_control"] = mk;
            }
            pending.push(result);
            continue;
        }
        flush(&mut wire, &mut pending);
        let mut blocks = content_blocks(m.get("content").unwrap_or(&Value::Null));
        if role == "assistant" {
            for call in m.get("tool_calls").and_then(Value::as_array).cloned().unwrap_or_default() {
                let f = call.get("function").cloned().unwrap_or(json!({}));
                let args: Value = serde_json::from_str(get_str(&f, "arguments").unwrap_or("{}")).unwrap_or(json!({}));
                blocks.push(json!({"type": "tool_use", "id": get_str(&call, "id").unwrap_or(""), "name": get_str(&f, "name").unwrap_or(""), "input": if args.is_object() { args } else { json!({}) }}));
            }
        }
        if let Some(mk) = marker.filter(|x| !x.is_null()) {
            if let Some(last) = blocks.last_mut() {
                last["cache_control"] = mk;
            }
        }
        push(&mut wire, if role == "assistant" { "assistant" } else { "user" }, blocks);
    }
    flush(&mut wire, &mut pending);
    (system, wire)
}

fn tool_choice(choice: Option<Value>, parallel: Option<Value>) -> Option<Value> {
    if choice.as_ref().is_none_or(Value::is_null) && parallel.as_ref().is_none_or(Value::is_null) {
        return None;
    }
    let mut result = match choice {
        Some(Value::Object(o)) => Value::Object(o),
        None | Some(Value::Null) => json!({"type": "auto"}),
        Some(Value::String(s)) if s == "auto" => json!({"type": "auto"}),
        Some(Value::String(s)) if s == "required" => json!({"type": "any"}),
        Some(Value::String(s)) if s == "none" => json!({"type": "none"}),
        Some(other) => json!({"type": "tool", "name": other.as_str().map(String::from).unwrap_or_else(|| other.to_string())}),
    };
    if parallel == Some(Value::Bool(false)) {
        result["disable_parallel_tool_use"] = json!(true);
    }
    Some(result)
}

/// Messages API response -> the chat-completions shape (the raw fields stay in the dict).
fn normalize_anthropic(data: Value) -> Value {
    let blocks = data.get("content").and_then(Value::as_array).cloned().unwrap_or_default();
    let has_thinking = blocks.iter().any(is_thinking);
    let text: String = blocks.iter().filter(|b| get_str(b, "type") == Some("text")).filter_map(|b| get_str(b, "text")).collect();
    let content = if has_thinking {
        Value::Array(blocks.iter().filter(|b| get_str(b, "type").is_some_and(|t| t == "text" || THINKING.contains(&t))).cloned().collect())
    } else if text.is_empty() {
        Value::Null
    } else {
        json!(text)
    };
    let tool_calls: Vec<Value> = blocks
        .iter()
        .filter(|b| get_str(b, "type") == Some("tool_use"))
        .map(|b| json!({"id": b.get("id").cloned().unwrap_or(Value::Null), "type": "function", "function": {"name": b.get("name").cloned().unwrap_or(Value::Null), "arguments": crate::util::py_json(b.get("input").filter(|i| !i.is_null()).unwrap_or(&json!({})), false)}}))
        .collect();
    let mut message = json!({"role": "assistant", "content": content});
    if !tool_calls.is_empty() {
        message["tool_calls"] = Value::Array(tool_calls);
    }
    let stop = data.get("stop_reason").cloned().unwrap_or(Value::Null);
    let finish = match stop.as_str() {
        Some("tool_use") => json!("tool_use"),
        Some("max_tokens") => json!("length"),
        Some("end_turn") | Some("stop_sequence") => json!("stop"),
        _ => stop,
    };
    let mut out = data;
    out["choices"] = json!([{"finish_reason": finish, "message": message}]);
    out
}

fn is_temperature_error(e: &ModelError) -> bool {
    regex::Regex::new(r"(?i)temperature.*(?:not supported|does not support|unsupported)").unwrap().is_match(&e.message)
}

fn deepseek_error(e: ModelError) -> ModelError {
    let re = regex::Regex::new(r"(?i)supported API model names are (?P<names>.+?), but you passed (?P<passed>[\w./-]+)").unwrap();
    if let Some(c) = re.captures(&e.message) {
        let names = c["names"].to_string();
        let passed = c["passed"].trim_end_matches('.').to_string();
        let hint = match super::catalog::deepseek_alias(&passed) {
            Some(s) => format!(" Request `deepseek/{s}` instead: DeepSeek serves it as that id."),
            None => " Run `mini-extra deepseek-models` to list them.".into(),
        };
        return ModelError { message: format!("DeepSeek has no model id '{passed}'. Ids your key accepts: {names}.{hint}"), status: e.status, abort: true, kind: "ProviderAbortError".into() };
    }
    let lowered = e.message.to_lowercase();
    if lowered.contains("authentication_error") || lowered.contains("authentication fails") {
        return ModelError { message: format!("{} You can permanently set your API key with `mini-extra config set DEEPSEEK_API_KEY YOUR_KEY`.", e.message), status: e.status, abort: true, kind: "ProviderAbortError".into() };
    }
    e
}

fn is_opaque_gateway_error(text: &str) -> bool {
    let Some((_, body)) = text.split_once(": ") else { return false };
    match serde_json::from_str::<Value>(body.trim()) {
        Ok(Value::Object(o)) if !o.is_empty() => !["error", "message", "detail", "type", "code"].iter().any(|k| o.contains_key(*k)),
        _ => false,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn anthropic_wire() {
        let msgs = vec![
            json!({"role": "system", "content": "sys"}),
            json!({"role": "user", "content": "task"}),
            json!({"role": "assistant", "content": "ok", "tool_calls": [{"id": "t1", "type": "function", "function": {"name": "bash", "arguments": "{\"command\": \"ls\"}"}}, {"id": "t2", "type": "function", "function": {"name": "bash", "arguments": "{\"command\": \"pwd\"}"}}]}),
            json!({"role": "tool", "tool_call_id": "t1", "content": "a"}),
            json!({"role": "tool", "tool_call_id": "t2", "content": "b"}),
            json!({"role": "user", "content": "more"}),
        ];
        let (system, wire) = to_anthropic_messages(&msgs);
        assert_eq!(system, vec![json!({"type": "text", "text": "sys"})]);
        assert_eq!(wire.len(), 3);
        assert_eq!(wire[1]["content"][1], json!({"type": "tool_use", "id": "t1", "name": "bash", "input": {"command": "ls"}}));
        // Both tool results and the follow-up merge into one user turn.
        assert_eq!(wire[2]["content"].as_array().unwrap().len(), 3);
        assert_eq!(wire[2]["content"][0]["type"], "tool_result");
        assert_eq!(wire[2]["content"][2], json!({"type": "text", "text": "more"}));
    }

    #[test]
    fn anthropic_normalize() {
        let data = json!({"content": [{"type": "text", "text": "hi"}, {"type": "tool_use", "id": "x", "name": "bash", "input": {"command": "ls"}}], "stop_reason": "tool_use", "usage": {"input_tokens": 5}});
        let n = normalize_anthropic(data);
        assert_eq!(n["choices"][0]["message"]["content"], "hi");
        assert_eq!(n["choices"][0]["message"]["tool_calls"][0]["function"]["arguments"], "{\"command\": \"ls\"}");
        assert_eq!(n["choices"][0]["finish_reason"], "tool_use");
        assert_eq!(n["usage"]["input_tokens"], 5);
    }

    #[test]
    fn tool_choice_translation() {
        assert_eq!(tool_choice(Some(json!("required")), Some(json!(false))), Some(json!({"type": "any", "disable_parallel_tool_use": true})));
        assert_eq!(tool_choice(None, None), None);
        assert_eq!(tool_choice(None, Some(json!(false))), Some(json!({"type": "auto", "disable_parallel_tool_use": true})));
    }

    #[test]
    fn opaque_errors() {
        assert!(is_opaque_gateway_error(r#"HTTP 400 from https://x: {"model":"deepseek-v4.1-flash"}"#));
        assert!(!is_opaque_gateway_error(r#"HTTP 400 from https://x: {"error":"bad"}"#));
    }
}
