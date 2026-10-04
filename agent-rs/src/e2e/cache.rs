//! The action cache (`.e2e-cache/steps/<key>.json`) and saved logins
//! (`.e2e-cache/auth/<profile>@<origin>.json`, 0600). Step keys chain the test's start path and
//! every step before it (host-independent, so the cache works on the nginx URL and localhost).

use super::browser::Action;
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

const VERSION: &str = "e2e-cache-1";

/// FNV-1a 64 (stable across runs and builds; this is a cache key, not a security boundary).
pub fn hash(s: &str) -> String {
    let mut h: u64 = 0xcbf29ce484222325;
    for b in s.bytes() {
        h ^= b as u64;
        h = h.wrapping_mul(0x100000001b3);
    }
    format!("{h:016x}")
}

/// The base URL's path (not its host) and the start step seed the chain.
pub fn chain_seed(base_url: &str, start: &str) -> String {
    let path = base_url.split_once("://").map(|(_, r)| r).unwrap_or(base_url);
    let path = path.find('/').map(|i| &path[i..]).unwrap_or("");
    hash(&format!("{VERSION}\n{path}\n{start}"))
}

pub fn step_key(prev: &str, label: &str) -> String {
    hash(&format!("{prev}\n{label}"))
}

fn step_path(dir: &Path, key: &str) -> PathBuf {
    dir.join("steps").join(format!("{key}.json"))
}

pub fn load(dir: &Path, key: &str) -> Option<Vec<Action>> {
    let v: Value = serde_json::from_str(&std::fs::read_to_string(step_path(dir, key)).ok()?).ok()?;
    if v.get("version").and_then(Value::as_str) != Some(VERSION) {
        return None;
    }
    let a: Vec<Action> = v.get("actions")?.as_array()?.iter().map(Action::from_json).collect();
    (!a.is_empty()).then_some(a)
}

pub fn store(dir: &Path, key: &str, label: &str, actions: &[Action]) -> Result<(), String> {
    // Typed values are stored as-is except secrets, which are only ever stored by name.
    let acts: Vec<Value> = actions
        .iter()
        .map(|a| {
            let mut v = a.to_json();
            if a.op == "type" && super::secrets::contains_secret(&a.value) {
                v["value"] = json!(super::secrets::scrub(&a.value));
            }
            v
        })
        .collect();
    let p = step_path(dir, key);
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    ensure_gitignore(dir);
    let data = json!({"version": VERSION, "step": label, "actions": acts, "saved_at": crate::util::now()});
    std::fs::write(&p, serde_json::to_string_pretty(&data).unwrap()).map_err(|e| e.to_string())
}

pub fn remove(dir: &Path, key: &str) {
    let _ = std::fs::remove_file(step_path(dir, key));
}

pub fn auth_state_path(dir: &Path, profile: &str, origin: &str) -> PathBuf {
    let o: String = origin.chars().map(|c| if c.is_ascii_alphanumeric() || c == '.' || c == '-' { c } else { '_' }).collect();
    dir.join("auth").join(format!("{profile}@{o}.json"))
}

pub fn read_private_json(p: &Path) -> Option<Value> {
    use std::os::unix::fs::PermissionsExt;
    let meta = std::fs::metadata(p).ok()?;
    if meta.permissions().mode() & 0o077 != 0 {
        return None;
    }
    serde_json::from_str(&std::fs::read_to_string(p).ok()?).ok()
}

pub fn write_private_json(p: &Path, v: &Value) -> Result<(), String> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    std::fs::create_dir_all(p.parent().unwrap()).map_err(|e| e.to_string())?;
    if let Some(root) = p.parent().and_then(Path::parent) {
        ensure_gitignore(root);
    }
    let tmp = p.with_extension("tmp");
    let mut f = std::fs::OpenOptions::new().write(true).create(true).truncate(true).mode(0o600).open(&tmp).map_err(|e| e.to_string())?;
    f.write_all(v.to_string().as_bytes()).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, p).map_err(|e| e.to_string())
}

/// The cache holds session cookies: never let git pick it up.
pub fn ensure_gitignore(dir: &Path) {
    let _ = std::fs::create_dir_all(dir);
    let g = dir.join(".gitignore");
    if !g.exists() {
        let _ = std::fs::write(g, "*\n");
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn keys_ignore_host_but_not_base_path() {
        let a = chain_seed("https://mini.example.com", "open /");
        let b = chain_seed("http://127.0.0.1:4317", "open /");
        let c = chain_seed("https://x.example.com/app", "open /");
        assert_eq!(a, b);
        assert_ne!(a, c);
        assert_ne!(step_key(&a, "act: x"), step_key(&a, "act: y"));
    }
    #[test]
    fn store_load_remove() {
        let d = std::env::temp_dir().join(format!("e2e-cache-t-{}", std::process::id()));
        let acts = vec![Action { op: "click".into(), target: "role=button[name=Go]".into(), value: String::new() }];
        store(&d, "k1", "act: go", &acts).unwrap();
        assert_eq!(load(&d, "k1").unwrap()[0].target, "role=button[name=Go]");
        remove(&d, "k1");
        assert!(load(&d, "k1").is_none());
        assert!(d.join(".gitignore").exists());
        std::fs::remove_dir_all(d).ok();
    }
}
