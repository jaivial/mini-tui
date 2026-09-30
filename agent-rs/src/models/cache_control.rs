//! Anthropic cache breakpoints (`utils/cache_control.py`): `default_end` marks the last
//! message, `rolling` marks the head, the latest compaction summary, the end of the previous
//! step and the last message (at most four).

use crate::util::get;
use serde_json::{json, Value};

const MAX_BREAKPOINTS: usize = 4;

fn plain_text(entry: &Value) -> String {
    match get(entry, "content") {
        Some(Value::String(s)) => s.clone(),
        Some(Value::Array(a)) => a.iter().filter_map(|b| b.get("text").and_then(Value::as_str)).collect(),
        _ => String::new(),
    }
}

fn clear_all(entry: &mut Value) {
    if let Some(Value::Array(blocks)) = entry.get_mut("content") {
        for b in blocks.iter_mut() {
            if let Some(o) = b.as_object_mut() {
                o.shift_remove("cache_control");
            }
        }
    }
    if let Some(o) = entry.as_object_mut() {
        o.shift_remove("cache_control");
    }
}

fn mark(entry: &mut Value, marker: &Value) {
    let role_tool = get(entry, "role").and_then(Value::as_str) == Some("tool");
    let content = entry.get("content").cloned().unwrap_or(Value::Null);
    let empty = match &content {
        Value::Null => true,
        Value::String(s) => s.is_empty(),
        Value::Array(a) => a.is_empty(),
        _ => false,
    };
    let o = entry.as_object_mut().unwrap();
    if role_tool || empty {
        o.insert("cache_control".into(), marker.clone());
    } else if let Value::String(s) = content {
        o.insert("content".into(), json!([{"type": "text", "text": s, "cache_control": marker}]));
    } else if let Some(Value::Array(blocks)) = o.get_mut("content") {
        if let Some(Value::Object(last)) = blocks.last_mut() {
            last.insert("cache_control".into(), marker.clone());
        } else {
            o.insert("cache_control".into(), marker.clone());
        }
    } else {
        o.insert("cache_control".into(), marker.clone());
    }
}

pub fn rolling_breakpoints(messages: &[Value]) -> Vec<usize> {
    if messages.is_empty() {
        return vec![];
    }
    let role = |i: usize| get(&messages[i], "role").and_then(Value::as_str).unwrap_or("");
    let mut head = 0;
    while head < messages.len() && role(head) == "system" {
        head += 1;
    }
    if head < messages.len() && role(head) == "user" {
        head += 1;
    }
    let last = messages.len() - 1;
    let compaction = (head.saturating_sub(1)..=last).rev().find(|&i| i + 1 >= head && plain_text(&messages[i]).starts_with("[Context compacted"));
    let compaction = compaction.filter(|&i| i + 1 > head.saturating_sub(1) && i >= head.saturating_sub(1));
    let assistant = (0..=last).rev().find(|&i| role(i) == "assistant");
    let previous = assistant.filter(|&a| a > 0).map(|a| a - 1);
    let mut wanted: Vec<i64> = vec![head as i64 - 1];
    if let Some(c) = compaction {
        wanted.push(c as i64);
    }
    if let Some(p) = previous {
        wanted.push(p as i64);
    }
    wanted.push(last as i64);
    let mut marks: Vec<usize> = wanted.into_iter().filter(|&i| i >= 0 && i as usize <= last).map(|i| i as usize).collect();
    marks.sort_unstable();
    marks.dedup();
    while marks.len() > MAX_BREAKPOINTS {
        marks.remove(1);
    }
    marks
}

pub fn set_cache_control(messages: &[Value], mode: Option<&str>, ttl: Option<&str>) -> Vec<Value> {
    let Some(mode) = mode else { return messages.to_vec() };
    let marker = match ttl {
        Some(t) => json!({"type": "ephemeral", "ttl": t}),
        None => json!({"type": "ephemeral"}),
    };
    let mut out = messages.to_vec();
    if mode == "rolling" {
        for e in out.iter_mut() {
            clear_all(e);
        }
        for i in rolling_breakpoints(&out) {
            mark(&mut out[i], &marker);
        }
        return out;
    }
    // default_end: clear every marker, mark the last message's last block.
    for e in out.iter_mut() {
        if let Some(Value::Array(blocks)) = e.get_mut("content") {
            if let Some(Value::Object(first)) = blocks.first_mut() {
                first.shift_remove("cache_control");
            }
        }
        if let Some(o) = e.as_object_mut() {
            o.shift_remove("cache_control");
        }
    }
    if let Some(last) = out.last_mut() {
        let o = last.as_object_mut().unwrap();
        match o.get("content").cloned() {
            None | Some(Value::Null) => {
                o.insert("cache_control".into(), marker.clone());
            }
            Some(Value::String(s)) => {
                o.insert("content".into(), json!([{"type": "text", "text": s, "cache_control": marker}]));
            }
            Some(Value::Array(_)) => {
                if let Some(Value::Array(blocks)) = o.get_mut("content") {
                    if let Some(Value::Object(b)) = blocks.last_mut() {
                        b.insert("cache_control".into(), marker.clone());
                    }
                }
            }
            Some(_) => {}
        }
        if o.get("role").and_then(Value::as_str) == Some("tool") {
            if let Some(Value::Array(blocks)) = o.get_mut("content") {
                if let Some(Value::Object(b)) = blocks.last_mut() {
                    b.shift_remove("cache_control");
                }
            }
            o.insert("cache_control".into(), marker);
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn rolling_marks() {
        let msgs = vec![
            json!({"role": "system", "content": "s"}),
            json!({"role": "user", "content": "task"}),
            json!({"role": "assistant", "content": "a", "tool_calls": []}),
            json!({"role": "tool", "content": "r", "tool_call_id": "1"}),
            json!({"role": "assistant", "content": "b"}),
            json!({"role": "tool", "content": "r2", "tool_call_id": "2"}),
        ];
        assert_eq!(rolling_breakpoints(&msgs), vec![1, 3, 5]);
        let out = set_cache_control(&msgs, Some("rolling"), None);
        assert_eq!(out[1]["content"], json!([{"type": "text", "text": "task", "cache_control": {"type": "ephemeral"}}]));
        assert_eq!(out[5]["cache_control"], json!({"type": "ephemeral"}));
        assert!(out[0].get("cache_control").is_none());
    }
}
