//! Jinja2 templates (system, instance, observation, format error) rendered like Python's
//! `jinja2.Template(src, undefined=StrictUndefined)`: `True`/`None` print as Python does, floats
//! use Python's repr, `tojson` matches Jinja's (`<`, `>`, `&`, `'` escaped, ASCII-only), and an
//! undefined variable is an error rather than an empty string.

use crate::util::{py_float, py_json};
use minijinja::value::{Value as JValue, ValueKind};
use minijinja::{Environment, Error, ErrorKind, UndefinedBehavior};
use serde_json::Value;
use std::sync::OnceLock;

fn env() -> &'static Environment<'static> {
    static ENV: OnceLock<Environment<'static>> = OnceLock::new();
    ENV.get_or_init(|| {
        let mut env = Environment::new();
        env.set_undefined_behavior(UndefinedBehavior::Strict);
        // Jinja2 drops a single trailing newline of the template source by default.
        env.set_keep_trailing_newline(false);
        env.set_formatter(|out, _state, value| {
            let text = python_str(value);
            out.write_str(&text).map_err(|_| Error::new(ErrorKind::WriteFailure, "write failed"))
        });
        env.add_filter("tojson", tojson);
        env.add_filter("length", length);
        env.add_filter("count", length);
        env
    })
}

/// `str(value)` as Python prints it inside `{{ }}`.
fn python_str(value: &JValue) -> String {
    match value.kind() {
        ValueKind::None => "None".into(),
        ValueKind::Undefined => String::new(),
        ValueKind::Bool => if value.is_true() { "True".into() } else { "False".into() },
        ValueKind::Number => {
            if value.is_integer() {
                value.to_string()
            } else {
                let f: f64 = f64::try_from(value.clone()).unwrap_or(0.0);
                py_float(f)
            }
        }
        ValueKind::String => value.as_str().unwrap_or("").to_string(),
        _ => {
            // Containers: Python's repr-ish text is never used by the shipped templates; JSON is
            // the closest stable rendering.
            let json: Value = serde_json::to_value(value).unwrap_or(Value::Null);
            py_json(&json, false)
        }
    }
}

/// Jinja2's `tojson`: `json.dumps` then HTML-safe escapes of `<`, `>`, `&` and `'`.
fn tojson(value: JValue) -> Result<JValue, Error> {
    let json: Value = serde_json::to_value(&value).map_err(|e| Error::new(ErrorKind::InvalidOperation, e.to_string()))?;
    let text = py_json(&json, false)
        .replace('<', "\\u003c")
        .replace('>', "\\u003e")
        .replace('&', "\\u0026")
        .replace('\'', "\\u0027");
    Ok(JValue::from_safe_string(text))
}

/// `length` counting code points for strings (Python's `len`).
fn length(value: JValue) -> Result<JValue, Error> {
    if let Some(s) = value.as_str() {
        return Ok(JValue::from(s.chars().count() as i64));
    }
    value
        .len()
        .map(|n| JValue::from(n as i64))
        .ok_or_else(|| Error::new(ErrorKind::InvalidOperation, "object has no length"))
}

/// Render `source` with `vars` (a JSON object).
pub fn render(source: &str, vars: &Value) -> Result<String, String> {
    let ctx = JValue::from_serialize(vars);
    env().render_str(source, ctx).map_err(|e| {
        let mut msg = e.to_string();
        let mut src = std::error::Error::source(&e);
        while let Some(s) = src {
            msg.push_str(&format!(": {s}"));
            src = s.source();
        }
        msg
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn python_printing() {
        let v = json!({"n": 3, "f": 1.5, "b": true, "none": null, "s": "héllo"});
        assert_eq!(render("{{ n }} {{ f }} {{ b }} {{ none }}", &v).unwrap(), "3 1.5 True None");
        assert_eq!(render("{{ s[:3] }}|{{ s[-2:] }}|{{ s | length - 2 }}", &v).unwrap(), "hél|lo|3");
    }

    #[test]
    fn tojson_like_jinja() {
        let v = json!({"x": "a<b>'é\n"});
        assert_eq!(render("{{ x | tojson }}", &v).unwrap(), r#""a\u003cb\u003e\u0027\u00e9\n""#);
    }

    #[test]
    fn strict_undefined() {
        assert!(render("{{ missing }}", &json!({})).is_err());
        assert_eq!(render("{% if missing is defined %}y{% else %}n{% endif %}", &json!({})).unwrap(), "n");
    }

    #[test]
    fn trailing_newline_dropped() {
        assert_eq!(render("a\n", &json!({})).unwrap(), "a");
    }
}
