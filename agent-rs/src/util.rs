//! Small shared helpers: JSON access, Python-compatible JSON text, recursive merge, clocks.

use serde_json::{Map, Value};
use std::time::{SystemTime, UNIX_EPOCH};

pub type Obj = Map<String, Value>;

/// Seconds since the epoch as a float (Python's `time.time()`).
pub fn now() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.0)
}

/// The current UTC time as `2026-10-07T13:21:44Z`, for stamping what a run leaves behind
/// (`date -u +%FT%TZ`): no dependency, and it reads the same in a file as in a log line.
pub fn now_iso() -> String {
    let secs = now() as i64;
    let (y, mo, d, h, mi, s) = crate::util::civil_from_unix(secs);
    format!("{y:04}-{mo:02}-{d:02}T{h:02}:{mi:02}:{s:02}Z")
}

/// Days-to-civil date (Howard Hinnant's algorithm), no time zone database needed.
pub fn civil_from_unix(secs: i64) -> (i64, u32, u32, u32, u32, u32) {
    let days = secs.div_euclid(86_400);
    let rem = secs.rem_euclid(86_400);
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let doe = z.rem_euclid(146_097);
    let yoe = (doe - doe / 1460 + doe / 36_524 - doe / 146_096) / 365;
    let y = yoe + era * 400;
    let doy = doe - (365 * yoe + yoe / 4 - yoe / 100);
    let mp = (5 * doy + 2) / 153;
    let d = (doy - (153 * mp + 2) / 5 + 1) as u32;
    let m = if mp < 10 { mp + 3 } else { mp - 9 } as u32;
    (if m <= 2 { y + 1 } else { y }, m, d, (rem / 3600) as u32, ((rem % 3600) / 60) as u32, (rem % 60) as u32)
}

/// `d.get(key)` for a JSON object, `None` for anything else.
pub fn get<'a>(v: &'a Value, key: &str) -> Option<&'a Value> {
    v.as_object().and_then(|o| o.get(key))
}

pub fn get_str<'a>(v: &'a Value, key: &str) -> Option<&'a str> {
    get(v, key).and_then(Value::as_str)
}

/// `message.get("extra", {})` as an object (empty when absent or not an object).
pub fn extra(v: &Value) -> Obj {
    get(v, "extra").and_then(Value::as_object).cloned().unwrap_or_default()
}

pub fn role(v: &Value) -> &str {
    get_str(v, "role").unwrap_or("")
}

pub fn has_extra_key(v: &Value, key: &str) -> bool {
    get(v, "extra").and_then(Value::as_object).is_some_and(|o| o.contains_key(key))
}

/// Python's `recursive_merge`: later values win, nested objects merge.
pub fn merge_into(base: &mut Obj, other: &Obj) {
    for (k, v) in other {
        match (base.get_mut(k), v) {
            (Some(Value::Object(b)), Value::Object(o)) => merge_into(b, o),
            (_, v) => {
                base.insert(k.clone(), v.clone());
            }
        }
    }
}


/// Format a float the way Python's `repr(float)` does (`1.0`, `0.1`, `1e-07`, `3e+20`).
pub fn py_float(f: f64) -> String {
    if f.is_nan() {
        return "NaN".into();
    }
    if f.is_infinite() {
        return if f > 0.0 { "Infinity".into() } else { "-Infinity".into() };
    }
    if f == 0.0 {
        return if f.is_sign_negative() { "-0.0".into() } else { "0.0".into() };
    }
    // Shortest round-trip digits, then Python's choice of fixed vs exponent notation.
    let exp_form = format!("{:e}", f); // e.g. "1.5e-7", "3e20"
    let (mantissa, exp) = exp_form.split_once('e').unwrap();
    let exp: i32 = exp.parse().unwrap();
    if (-4..16).contains(&exp) {
        let s = format!("{}", f);
        if s.contains('.') || s.contains('e') {
            s
        } else {
            format!("{s}.0")
        }
    } else {
        let sign = if exp < 0 { '-' } else { '+' };
        format!("{mantissa}e{sign}{:02}", exp.abs())
    }
}

/// JSON text byte-compatible with Python's `json.dumps` (ASCII-escaped, Python float repr).
/// `compact` = `separators=(",", ":")`, else the default `", "` / `": "`.
pub fn py_json(v: &Value, compact: bool) -> String {
    let mut out = String::new();
    write_py_json(v, compact, &mut out);
    out
}

fn write_py_json(v: &Value, compact: bool, out: &mut String) {
    let (item_sep, key_sep) = if compact { (",", ":") } else { (", ", ": ") };
    match v {
        Value::Null => out.push_str("null"),
        Value::Bool(b) => out.push_str(if *b { "true" } else { "false" }),
        Value::Number(n) => {
            if let Some(i) = n.as_i64() {
                out.push_str(&i.to_string());
            } else if let Some(u) = n.as_u64() {
                out.push_str(&u.to_string());
            } else {
                out.push_str(&py_float(n.as_f64().unwrap_or(0.0)));
            }
        }
        Value::String(s) => write_py_str(s, out),
        Value::Array(a) => {
            out.push('[');
            for (i, x) in a.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_py_json(x, compact, out);
            }
            out.push(']');
        }
        Value::Object(o) => {
            out.push('{');
            for (i, (k, x)) in o.iter().enumerate() {
                if i > 0 {
                    out.push_str(item_sep);
                }
                write_py_str(k, out);
                out.push_str(key_sep);
                write_py_json(x, compact, out);
            }
            out.push('}');
        }
    }
}

fn write_py_str(s: &str, out: &mut String) {
    out.push('"');
    for c in s.chars() {
        match c {
            '"' => out.push_str("\\\""),
            '\\' => out.push_str("\\\\"),
            '\n' => out.push_str("\\n"),
            '\r' => out.push_str("\\r"),
            '\t' => out.push_str("\\t"),
            '\u{08}' => out.push_str("\\b"),
            '\u{0c}' => out.push_str("\\f"),
            c if (c as u32) < 0x20 || (c as u32) > 0x7e => {
                let mut buf = [0u16; 2];
                for unit in c.encode_utf16(&mut buf) {
                    out.push_str(&format!("\\u{:04x}", unit));
                }
            }
            c => out.push(c),
        }
    }
    out.push('"');
}




/// `round(x, 1)` as Python does it for the values we produce (non-negative seconds).
pub fn round1(x: f64) -> f64 {
    (x * 10.0).round() / 10.0
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn floats_like_python() {
        assert_eq!(py_float(1.0), "1.0");
        assert_eq!(py_float(0.1), "0.1");
        assert_eq!(py_float(1e-7), "1e-07");
        assert_eq!(py_float(3e20), "3e+20");
        assert_eq!(py_float(1790716336.456401), "1790716336.456401");
        assert_eq!(py_float(0.01), "0.01");
        assert_eq!(py_float(12345678901234567.0), "1.2345678901234568e+16");
    }

    #[test]
    fn json_like_python() {
        let v = json!({"a": 1.0, "b": 0.1, "c": "é\n", "d": 1e-7, "f": null, "g": true, "h": [1, "😀"]});
        assert_eq!(py_json(&v, false), r#"{"a": 1.0, "b": 0.1, "c": "\u00e9\n", "d": 1e-07, "f": null, "g": true, "h": [1, "\ud83d\ude00"]}"#);
        assert_eq!(py_json(&json!({"a": "é"}), true), r#"{"a":"\u00e9"}"#);
    }

}

/// The clock ticks a second holds, per the kernel (100 on Linux): `/proc/<pid>/stat`'s CPU times are
/// counted in them, so a CPU second needs this divisor.
static CLK_TCK: std::sync::OnceLock<i64> = std::sync::OnceLock::new();

pub fn clk_tck() -> f64 {
    let ticks: i64 = (*CLK_TCK.get_or_init(|| unsafe { libc::sysconf(libc::_SC_CLK_TCK) })).max(1);
    ticks as f64
}
