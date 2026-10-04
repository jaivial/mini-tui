//! Secret references (`env:NAME`, `file:PATH[#KEY]`, `cmd:COMMAND`, or a literal), the
//! scrubber that keeps resolved values out of everything the runner writes, and TOTP codes.

use std::collections::BTreeMap;
use std::sync::{Mutex, OnceLock};

/// Every secret value resolved by this process, by name (for scrubbing).
fn registry() -> &'static Mutex<BTreeMap<String, String>> {
    static R: OnceLock<Mutex<BTreeMap<String, String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(BTreeMap::new()))
}

/// The environment variables secret references read (stripped from worker environments).
fn env_names() -> &'static Mutex<Vec<String>> {
    static R: OnceLock<Mutex<Vec<String>>> = OnceLock::new();
    R.get_or_init(|| Mutex::new(Vec::new()))
}

pub fn referenced_env_names() -> Vec<String> {
    env_names().lock().unwrap().clone()
}

/// A name for a reference, used in logs and in `«secret:NAME»` placeholders.
pub fn ref_name(spec: &str) -> String {
    if let Some(n) = spec.strip_prefix("env:") {
        return n.trim().to_string();
    }
    if let Some(rest) = spec.strip_prefix("file:") {
        if let Some((_, key)) = rest.rsplit_once('#') {
            return key.trim().to_string();
        }
        return "file".into();
    }
    if spec.starts_with("cmd:") {
        return "cmd".into();
    }
    "literal".into()
}

fn read_env_file(path: &std::path::Path) -> Result<BTreeMap<String, String>, String> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(path).map_err(|e| format!("{}: {e}", path.display()))?;
    if meta.permissions().mode() & 0o077 != 0 {
        return Err(format!("{} must not be readable by group/others (chmod 600 it)", path.display()));
    }
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let mut out = BTreeMap::new();
    for line in text.lines() {
        let line = line.trim();
        if line.is_empty() || line.starts_with('#') {
            continue;
        }
        let line = line.strip_prefix("export ").unwrap_or(line);
        let Some((k, v)) = line.split_once('=') else { continue };
        let v = v.trim();
        let v = if v.len() >= 2 && ((v.starts_with('"') && v.ends_with('"')) || (v.starts_with('\'') && v.ends_with('\''))) { &v[1..v.len() - 1] } else { v };
        out.insert(k.trim().to_string(), v.to_string());
    }
    Ok(out)
}

/// Resolve a reference. `default_file` is the secrets file `env:` falls back to when the
/// variable is unset (so the same names work from a shell or from the 0600 file).
pub fn resolve(spec: &str, default_file: Option<&std::path::Path>) -> Result<String, String> {
    let spec = spec.trim();
    let value = if let Some(name) = spec.strip_prefix("env:") {
        let name = name.trim();
        env_names().lock().unwrap().push(name.to_string());
        match std::env::var(name).ok().filter(|v| !v.is_empty()) {
            Some(v) => v,
            None => match default_file.filter(|p| p.exists()) {
                Some(p) => read_env_file(p)?.remove(name).ok_or_else(|| format!("secret {name} is not set (environment or {})", p.display()))?,
                None => return Err(format!("secret {name} is not set in the environment")),
            },
        }
    } else if let Some(rest) = spec.strip_prefix("file:") {
        let (path, key) = match rest.rsplit_once('#') {
            Some((p, k)) => (p, Some(k)),
            None => (rest, None),
        };
        let path = crate::config::expand_user(path.trim());
        match key {
            Some(k) => read_env_file(&path)?.remove(k.trim()).ok_or_else(|| format!("{} has no {k}", path.display()))?,
            None => {
                read_env_file(&path)?; // permission check
                std::fs::read_to_string(&path).map_err(|e| format!("{}: {e}", path.display()))?.trim_end_matches(['\n', '\r']).to_string()
            }
        }
    } else if let Some(cmd) = spec.strip_prefix("cmd:") {
        let out = std::process::Command::new("/bin/sh").arg("-c").arg(cmd).stderr(std::process::Stdio::inherit()).output().map_err(|e| format!("secret command: {e}"))?;
        if !out.status.success() {
            return Err(format!("secret command failed ({}): {cmd}", out.status));
        }
        String::from_utf8_lossy(&out.stdout).lines().next().unwrap_or("").to_string()
    } else {
        spec.to_string()
    };
    if value.is_empty() {
        return Err(format!("secret {} is empty", ref_name(spec)));
    }
    register(&ref_name(spec), &value);
    Ok(value)
}

pub fn register(name: &str, value: &str) {
    // Very short values (a "1", a "no") would scrub unrelated text; secrets that short are not secret.
    if value.chars().count() >= 3 {
        registry().lock().unwrap().insert(name.to_string(), value.to_string());
    }
}

/// Every registered value replaced by `«secret:NAME»` (longest values first).
pub fn scrub(text: &str) -> String {
    let reg = registry().lock().unwrap();
    let mut pairs: Vec<(&String, &String)> = reg.iter().collect();
    pairs.sort_by_key(|(_, v)| std::cmp::Reverse(v.len()));
    let mut out = text.to_string();
    for (name, value) in pairs {
        if out.contains(value.as_str()) {
            out = out.replace(value.as_str(), &format!("«secret:{name}»"));
        }
        // JSON-escaped forms too (a value with quotes or backslashes inside a JSON file).
        let esc = serde_json::to_string(value).unwrap_or_default();
        let esc = esc.trim_matches('"');
        if esc != value && !esc.is_empty() && out.contains(esc) {
            out = out.replace(esc, &format!("«secret:{name}»"));
        }
    }
    out
}

pub fn contains_secret(text: &str) -> bool {
    registry().lock().unwrap().values().any(|v| text.contains(v.as_str()))
}

/// Rewrite a file the runner did not write itself (a worker's trajectory) without secrets.
/// Returns true when something had to be scrubbed.
pub fn scrub_file(path: &std::path::Path) -> bool {
    let Ok(text) = std::fs::read_to_string(path) else { return false };
    let clean = scrub(&text);
    if clean != text {
        let _ = std::fs::write(path, clean);
        return true;
    }
    false
}

fn base32_decode(s: &str) -> Option<Vec<u8>> {
    let mut bits: u64 = 0;
    let mut n = 0;
    let mut out = Vec::new();
    for c in s.chars().filter(|c| !c.is_whitespace() && *c != '=' && *c != '-') {
        let v = match c.to_ascii_uppercase() {
            c @ 'A'..='Z' => c as u64 - 'A' as u64,
            c @ '2'..='7' => c as u64 - '2' as u64 + 26,
            _ => return None,
        };
        bits = (bits << 5) | v;
        n += 5;
        if n >= 8 {
            n -= 8;
            out.push((bits >> n) as u8);
            bits &= (1 << n) - 1;
        }
    }
    Some(out)
}

/// RFC 6238 TOTP (SHA-1, 6 digits, 30 s) of a base32 secret or an `otpauth://` URI.
pub fn totp(secret: &str, unix_time: u64) -> Result<String, String> {
    use hmac::{Hmac, Mac};
    let secret = if secret.starts_with("otpauth://") {
        secret.split(['?', '&']).find_map(|kv| kv.strip_prefix("secret=")).unwrap_or("").to_string()
    } else {
        secret.to_string()
    };
    let key = base32_decode(&secret).filter(|k| !k.is_empty()).ok_or("the TOTP secret is not valid base32")?;
    let counter = unix_time / 30;
    let mut mac = Hmac::<sha1::Sha1>::new_from_slice(&key).map_err(|e| e.to_string())?;
    mac.update(&counter.to_be_bytes());
    let h = mac.finalize().into_bytes();
    let off = (h[19] & 0x0f) as usize;
    let code = (u32::from_be_bytes([h[off] & 0x7f, h[off + 1], h[off + 2], h[off + 3]])) % 1_000_000;
    Ok(format!("{code:06}"))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn rfc6238_vectors() {
        // RFC 6238 SHA-1 secret "12345678901234567890" in base32.
        let s = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ";
        assert_eq!(totp(s, 59).unwrap(), "287082");
        assert_eq!(totp(s, 1111111109).unwrap(), "081804");
        assert_eq!(totp(s, 1234567890).unwrap(), "005924");
    }
    #[test]
    fn scrubs_registered_values() {
        register("TEST_PW", "hunter2-xyz");
        assert_eq!(scrub("pw=hunter2-xyz!"), "pw=«secret:TEST_PW»!");
        assert!(contains_secret("a hunter2-xyz b"));
    }
    #[test]
    fn names() {
        assert_eq!(ref_name("env:E2E_ADMIN_PASS"), "E2E_ADMIN_PASS");
        assert_eq!(ref_name("file:~/.x.env#ADMIN"), "ADMIN");
    }
}
