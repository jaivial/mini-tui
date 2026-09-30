//! Per-provider token prices (`models/prices.py`): USD per 1M tokens, 0.0 for unknown ids.

use serde_json::Value;
use std::collections::HashMap;
use std::sync::{Mutex, OnceLock};

#[derive(Clone, Copy, Debug, Default)]
pub struct Price {
    pub input: f64,
    pub output: f64,
    pub cache_read: f64,
    pub cache_write: f64,
    pub tier_threshold: i64,
    pub tier_input: f64,
    pub tier_output: f64,
    pub tier_cache_read: f64,
    pub tier_cache_write: f64,
}

const fn p(i: f64, o: f64, cr: f64, cw: f64) -> Price {
    Price { input: i, output: o, cache_read: cr, cache_write: cw, tier_threshold: 0, tier_input: 0.0, tier_output: 0.0, tier_cache_read: 0.0, tier_cache_write: 0.0 }
}

type Table = HashMap<String, HashMap<String, Price>>;

fn table() -> &'static Mutex<Table> {
    static T: OnceLock<Mutex<Table>> = OnceLock::new();
    T.get_or_init(|| {
        let mut t: Table = HashMap::new();
        let mut add = |prov: &str, rows: &[(&str, Price)]| {
            let e = t.entry(prov.to_string()).or_default();
            for (id, pr) in rows {
                e.insert(id.to_string(), *pr);
            }
        };
        add("deepseek", &[
            ("deepseek-chat", p(0.28, 0.42, 0.028, 0.0)),
            ("deepseek-reasoner", p(0.28, 0.42, 0.028, 0.0)),
            ("deepseek-flash", p(0.30, 1.20, 0.006, 0.0)),
            ("deepseek-v4-flash", p(0.30, 1.20, 0.006, 0.0)),
            ("deepseek-v4-pro", p(1.32, 3.96, 0.044, 0.0)),
            ("deepseek-v4-flash-vision-exp", p(0.30, 1.20, 0.006, 0.0)),
        ]);
        add("openai", &[
            ("gpt-6-astra", p(10.0, 50.0, 1.0, 12.5)),
            ("gpt-5.4", p(2.5, 15.0, 0.25, 0.0)),
            ("gpt-4o-mini", p(0.15, 0.60, 0.075, 0.0)),
        ]);
        add("anthropic", &[
            ("claude-sonnet-4-5", p(3.0, 15.0, 0.30, 3.75)),
            ("claude-haiku-4-5", p(1.0, 5.0, 0.10, 1.25)),
            ("claude-opus-5-5", p(4.0, 20.0, 0.20, 5.0)),
            ("claude-sonnet-5-5", p(3.0, 15.0, 0.30, 3.75)),
        ]);
        t.entry("opencode-go".into()).or_default();
        t.entry("generic".into()).or_default();
        let go = t.entry("opencode-go".into()).or_default();
        for m in crate::models::go_catalog::GO_MODELS {
            go.insert(m.id.to_string(), Price {
                input: m.input, output: m.output, cache_read: m.cache_read, cache_write: m.cache_write,
                tier_threshold: m.tier_threshold, tier_input: m.tier_input, tier_output: m.tier_output,
                tier_cache_read: m.tier_cache_read, tier_cache_write: m.tier_cache_write,
            });
        }
        if let Ok(path) = std::env::var("MSWEA_PRICE_TABLE_PATH") {
            if let Ok(text) = std::fs::read_to_string(&path) {
                if let Ok(Value::Object(rows)) = serde_json::from_str::<Value>(&text) {
                    for (prov, ids) in rows {
                        let e = t.entry(prov).or_default();
                        for (id, costs) in ids.as_object().cloned().unwrap_or_default() {
                            let c: Vec<f64> = costs.as_array().map(|a| a.iter().filter_map(Value::as_f64).collect()).unwrap_or_default();
                            let g = |i: usize| c.get(i).copied().unwrap_or(0.0);
                            e.insert(id.to_lowercase(), p(g(0), g(1), g(2), g(3)));
                        }
                    }
                }
            }
        }
        Mutex::new(t)
    })
}

pub fn price_for(provider: &str, model_id: &str) -> Option<Price> {
    let t = table().lock().unwrap();
    let lower = model_id.to_lowercase();
    let bare = lower.split_once('/').map(|(_, b)| b.to_string()).unwrap_or_else(|| lower.clone());
    if let Some(tab) = t.get(provider) {
        for key in [&lower, &bare] {
            if let Some(p) = tab.get(key) {
                return Some(*p);
            }
        }
    }
    let generic = t.get("generic")?;
    generic.get(&lower).or_else(|| generic.get(&bare)).copied()
}

fn int(v: Option<&Value>) -> i64 {
    v.and_then(|x| x.as_i64().or_else(|| x.as_f64().map(|f| f as i64))).unwrap_or(0)
}

/// (billable input, output, cache read, cache write) from any usage convention.
fn tokens(usage: &Value) -> (i64, i64, i64, i64) {
    let Some(u) = usage.as_object() else { return (0, 0, 0, 0) };
    let details = u.get("prompt_tokens_details").cloned().unwrap_or(Value::Null);
    let mut read = int(u.get("cache_read_input_tokens"));
    if read == 0 {
        read = int(details.get("cached_tokens"));
    }
    let write = int(u.get("cache_creation_input_tokens"));
    if u.contains_key("prompt_tokens") || u.contains_key("completion_tokens") {
        ((int(u.get("prompt_tokens")) - read).max(0), int(u.get("completion_tokens")), read, write)
    } else {
        (int(u.get("input_tokens")), int(u.get("output_tokens")), read, write)
    }
}

pub fn cost_for(provider: &str, model_id: &str, usage: &Value) -> f64 {
    let Some(price) = price_for(provider, model_id) else { return 0.0 };
    let (n_in, n_out, n_cr, n_cw) = tokens(usage);
    let (mut pi, mut po, mut pcr, mut pcw) = (price.input, price.output, price.cache_read, price.cache_write);
    if price.tier_threshold > 0 && n_in > price.tier_threshold {
        (pi, po, pcr, pcw) = (price.tier_input, price.tier_output, price.tier_cache_read, price.tier_cache_write);
    }
    (n_in as f64 * pi + n_out as f64 * po + n_cr as f64 * pcr + n_cw as f64 * pcw) / 1e6
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn costs() {
        let usage = json!({"prompt_tokens": 1000, "completion_tokens": 100, "prompt_tokens_details": {"cached_tokens": 400}});
        let c = cost_for("deepseek", "deepseek/deepseek-chat", &usage);
        assert!((c - (600.0 * 0.28 + 100.0 * 0.42 + 400.0 * 0.028) / 1e6).abs() < 1e-15);
        assert_eq!(cost_for("generic", "unknown", &usage), 0.0);
        assert!(price_for("opencode-go", "grok-4.7").is_some());
    }
}
