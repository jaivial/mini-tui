//! `e2e.yaml` (one per project, found upward from the working directory like `.git`) and the
//! `*.e2e.yaml` test files. Precedence for each setting: CLI flag > environment variable >
//! the test file > the selected environment > the top level of `e2e.yaml` > auto-detection.

use serde_json::{json, Value};
use std::path::{Path, PathBuf};

pub const CONFIG_NAME: &str = "e2e.yaml";

#[derive(Clone, Debug, Default)]
pub struct FormLogin {
    pub url: String,
    pub user_field: String,
    pub password_field: String,
    pub submit: String,
    pub user: String,
    pub password: String,
    pub totp: Option<String>,
    pub totp_field: Option<String>,
    pub success: Value,
}

#[derive(Clone, Debug, Default)]
pub struct Profile {
    pub name: String,
    pub http_basic: Option<(String, String)>,
    pub form: Option<FormLogin>,
    /// Secrets workers may type by name with `browser fill-secret` (name -> reference).
    pub secrets: Vec<(String, String)>,
}

#[derive(Clone, Debug)]
pub struct Project {
    pub root: PathBuf,
    pub config_path: PathBuf,
    pub environment: Option<String>,
    pub base_url: String,
    pub server_name: Option<String>,
    pub allowed_origins: Vec<String>,
    pub read_only: bool,
    pub default_profile: Option<String>,
    pub profiles: Vec<Profile>,
    /// Site-wide HTTP Basic Auth (an nginx `auth_basic` gate): used by every profile, `none`
    /// included, unless a profile sets its own.
    pub http_basic: Option<(String, String)>,
    pub secrets_file: Option<PathBuf>,
    pub tests: Vec<String>,
    pub models: Value,
    pub cache_dir: PathBuf,
    pub out_dir: PathBuf,
}

fn s(v: &Value, k: &str) -> Option<String> {
    v.get(k).and_then(Value::as_str).map(String::from).filter(|x| !x.is_empty())
}

pub fn load_yaml(path: &Path) -> Result<Value, String> {
    let text = std::fs::read_to_string(path).map_err(|e| format!("{}: {e}", path.display()))?;
    let v: Value = serde_yaml::from_str(&text).map_err(|e| format!("{}: {e}", path.display()))?;
    Ok(if v.is_null() { json!({}) } else { v })
}

/// Deep merge (later wins).
fn merge(base: &mut Value, over: &Value) {
    match (base.as_object_mut(), over.as_object()) {
        (Some(b), Some(o)) => {
            for (k, v) in o {
                match b.get_mut(k) {
                    Some(bv) if bv.is_object() && v.is_object() => merge(bv, v),
                    _ => {
                        b.insert(k.clone(), v.clone());
                    }
                }
            }
        }
        _ => *base = over.clone(),
    }
}

pub fn find_config(start: &Path) -> Option<PathBuf> {
    let start = std::fs::canonicalize(start).unwrap_or_else(|_| start.to_path_buf());
    for dir in start.ancestors() {
        let c = dir.join(CONFIG_NAME);
        if c.is_file() {
            return Some(c);
        }
    }
    None
}

fn parse_profile(name: &str, v: &Value) -> Profile {
    let http_basic = v.get("http_basic").and_then(|b| Some((s(b, "user")?, s(b, "password")?)));
    let form = v.get("form").filter(|f| f.is_object()).map(|f| FormLogin {
        url: s(f, "url").unwrap_or_else(|| "/login".into()),
        user_field: s(f, "user_field").unwrap_or_default(),
        password_field: s(f, "password_field").unwrap_or_default(),
        submit: s(f, "submit").unwrap_or_default(),
        user: s(f, "user").unwrap_or_default(),
        password: s(f, "password").unwrap_or_default(),
        totp: s(f, "totp"),
        totp_field: s(f, "totp_field"),
        success: f.get("success").cloned().unwrap_or(Value::Null),
    });
    let mut secrets = vec![];
    if let Some(o) = v.get("secrets").and_then(Value::as_object) {
        for (k, r) in o {
            if let Some(r) = r.as_str() {
                secrets.push((k.clone(), r.to_string()));
            }
        }
    }
    Profile { name: name.to_string(), http_basic, form, secrets }
}

pub struct Overrides {
    pub environment: Option<String>,
    pub base_url: Option<String>,
    pub profile: Option<String>,
}

impl Project {
    pub fn load(config_path: &Path, o: &Overrides) -> Result<Project, String> {
        let config_path = std::fs::canonicalize(config_path).map_err(|e| format!("{}: {e}", config_path.display()))?;
        let root = config_path.parent().unwrap().to_path_buf();
        let raw = load_yaml(&config_path)?;
        let env_name = o.environment.clone().or_else(|| std::env::var("E2E_ENV").ok().filter(|x| !x.is_empty())).or_else(|| s(&raw, "default_environment"));
        let mut eff = raw.clone();
        if let Some(obj) = eff.as_object_mut() {
            obj.remove("environments");
        }
        if let Some(name) = &env_name {
            let envs = raw.get("environments").and_then(Value::as_object);
            let e = envs.and_then(|m| m.get(name)).ok_or_else(|| {
                let known: Vec<String> = envs.map(|m| m.keys().cloned().collect()).unwrap_or_default();
                format!("{}: no environment {name:?} (known: {})", config_path.display(), if known.is_empty() { "none".into() } else { known.join(", ") })
            })?;
            merge(&mut eff, e);
        }
        let base_url = o
            .base_url
            .clone()
            .or_else(|| std::env::var("E2E_BASE_URL").ok().filter(|x| !x.is_empty()))
            .or_else(|| s(&eff, "base_url"))
            .unwrap_or_else(|| "auto".into());
        let auth = eff.get("auth").cloned().unwrap_or(json!({}));
        let mut profiles = vec![];
        if let Some(ps) = auth.get("profiles").and_then(Value::as_object) {
            for (k, v) in ps {
                profiles.push(parse_profile(k, v));
            }
        }
        let site_basic = auth.get("http_basic").and_then(|b| Some((s(b, "user")?, s(b, "password")?)));
        let default_profile = o.profile.clone().or_else(|| s(&auth, "default_profile"));
        let rel = |p: String| -> PathBuf {
            let pb = crate::config::expand_user(&p);
            if pb.is_absolute() {
                pb
            } else {
                root.join(pb)
            }
        };
        let secrets_file = s(&eff, "secrets_file").map(rel).or_else(|| {
            let d = crate::config::home().join(".config/mini-tui/e2e-secrets.env");
            d.exists().then_some(d)
        });
        let tests = match eff.get("tests") {
            Some(Value::String(t)) => vec![t.clone()],
            Some(Value::Array(a)) => a.iter().filter_map(|x| x.as_str().map(String::from)).collect(),
            _ => vec!["e2e".into()],
        };
        let cache_dir = s(&eff, "cache_dir").map(rel).unwrap_or_else(|| root.join(".e2e-cache"));
        let out_dir = s(&eff, "output_dir").map(rel).unwrap_or_else(|| root.join(".e2e-runs"));
        Ok(Project {
            root,
            config_path,
            environment: env_name,
            base_url,
            server_name: s(&eff, "server_name"),
            allowed_origins: eff.get("allowed_origins").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default(),
            read_only: eff.get("read_only").and_then(Value::as_bool).unwrap_or(false),
            default_profile,
            profiles,
            http_basic: site_basic,
            secrets_file,
            tests,
            models: eff.get("models").cloned().unwrap_or(json!({})),
            cache_dir,
            out_dir,
        })
    }

    pub fn profile(&self, name: Option<&str>) -> Result<Option<Profile>, String> {
        let name = match name.or(self.default_profile.as_deref()) {
            None | Some("none") => return Ok(None),
            Some(n) => n,
        };
        self.profiles.iter().find(|p| p.name == name).cloned().map(Some).ok_or_else(|| {
            format!("no auth profile {name:?} in {} (profiles: {})", self.config_path.display(), self.profiles.iter().map(|p| p.name.clone()).collect::<Vec<_>>().join(", "))
        })
    }

    /// The HTTP Basic credentials (references) a test with this profile sends.
    pub fn basic_for(&self, profile: Option<&Profile>) -> Option<(String, String)> {
        profile.and_then(|p| p.http_basic.clone()).or_else(|| self.http_basic.clone())
    }

    pub fn model(&self, role: &str) -> Option<String> {
        s(&self.models, role)
    }

    /// Every test file under the configured paths (files, dirs searched for `*.e2e.yaml`).
    pub fn test_files(&self, explicit: &[String]) -> Result<Vec<PathBuf>, String> {
        let specs: Vec<String> = if explicit.is_empty() { self.tests.clone() } else { explicit.to_vec() };
        let mut out = vec![];
        for spec in specs {
            let p = if Path::new(&spec).is_absolute() { PathBuf::from(&spec) } else if explicit.is_empty() { self.root.join(&spec) } else { std::env::current_dir().unwrap_or_default().join(&spec) };
            if p.is_file() {
                out.push(p);
            } else if p.is_dir() {
                let mut found = vec![];
                walk(&p, &mut found);
                found.sort();
                out.extend(found);
            } else {
                return Err(format!("no test file or directory {}", p.display()));
            }
        }
        Ok(out)
    }
}

fn walk(dir: &Path, out: &mut Vec<PathBuf>) {
    let Ok(rd) = std::fs::read_dir(dir) else { return };
    for e in rd.flatten() {
        let p = e.path();
        let name = p.file_name().and_then(|n| n.to_str()).unwrap_or("");
        if p.is_dir() && !name.starts_with('.') && name != "node_modules" {
            walk(&p, out);
        } else if name.ends_with(".e2e.yaml") || name.ends_with(".e2e.yml") {
            out.push(p);
        }
    }
}

// ---- test files ----------------------------------------------------------------------

#[derive(Clone, Debug)]
pub enum Step {
    Open(String),
    Login(Option<String>),
    Act(String),
    Assert(String),
    Expect(Value),
    Wait(String),
    /// Exact actions (no model): click / type / press / select / fill-secret.
    Do(String, String, String),
    Screenshot(String),
}

impl Step {
    pub fn label(&self) -> String {
        match self {
            Step::Open(u) => format!("open {u}"),
            Step::Login(p) => format!("login {}", p.clone().unwrap_or_default()),
            Step::Act(g) => format!("act: {g}"),
            Step::Assert(c) => format!("assert: {c}"),
            Step::Expect(v) => format!("expect {}", v),
            Step::Wait(w) => format!("wait {w}"),
            Step::Do(op, t, _) => format!("{op} {t}"),
            Step::Screenshot(l) => format!("screenshot {l}"),
        }
    }
    pub fn is_agent(&self) -> bool {
        matches!(self, Step::Act(_) | Step::Assert(_))
    }
}

#[derive(Clone, Debug)]
pub struct TestCase {
    pub name: String,
    pub file: PathBuf,
    pub profile: Option<String>,
    pub start: Option<String>,
    pub steps: Vec<Step>,
    pub timeout: u64,
    pub base_url: Option<String>,
}

fn parse_step(v: &Value) -> Result<Step, String> {
    if let Some(t) = v.as_str() {
        return Ok(Step::Act(t.to_string()));
    }
    let o = v.as_object().ok_or("a step must be a mapping like `act: …`")?;
    let (k, val) = o.iter().next().ok_or("empty step")?;
    let txt = || val.as_str().map(String::from).ok_or(format!("`{k}` takes a string"));
    Ok(match k.as_str() {
        "open" | "goto" => Step::Open(txt()?),
        "login" => Step::Login(val.as_str().map(String::from)),
        "act" | "do_goal" => Step::Act(txt()?),
        "assert" | "check" => Step::Assert(txt()?),
        "expect" => Step::Expect(val.clone()),
        "wait" => Step::Wait(match val {
            Value::Number(n) => n.to_string(),
            _ => txt()?,
        }),
        "screenshot" => Step::Screenshot(val.as_str().unwrap_or("shot").to_string()),
        "click" => Step::Do("click".into(), txt()?, String::new()),
        "press" => Step::Do("press".into(), String::new(), txt()?),
        "type" | "fill" | "select" | "fill_secret" | "fill-secret" => {
            let target = val.get("target").or_else(|| val.get("locator")).and_then(Value::as_str).ok_or(format!("`{k}` needs `target`"))?;
            let value = val.get("value").or_else(|| val.get("text")).or_else(|| val.get("secret")).or_else(|| val.get("option")).and_then(Value::as_str).ok_or(format!("`{k}` needs `value`"))?;
            let op = match k.as_str() {
                "fill" => "type",
                "fill_secret" => "fill-secret",
                other => other,
            };
            Step::Do(op.into(), target.into(), value.into())
        }
        other => return Err(format!("unknown step `{other}` (open, login, act, assert, expect, wait, click, type, press, select, fill-secret, screenshot)")),
    })
}

pub fn load_tests(path: &Path) -> Result<Vec<TestCase>, String> {
    let v = load_yaml(path)?;
    let defaults = v.get("defaults").cloned().unwrap_or(json!({}));
    let list: Vec<Value> = match v.get("tests") {
        Some(Value::Array(a)) => a.clone(),
        _ if v.get("steps").is_some() => vec![v.clone()],
        _ => return Err(format!("{}: expected `tests:` (a list) or `steps:`", path.display())),
    };
    let stem = path.file_name().and_then(|n| n.to_str()).unwrap_or("test").trim_end_matches(".e2e.yaml").trim_end_matches(".e2e.yml").to_string();
    let mut out = vec![];
    for (i, t) in list.iter().enumerate() {
        let get = |k: &str| t.get(k).or_else(|| defaults.get(k));
        let name = t.get("name").and_then(Value::as_str).map(String::from).unwrap_or_else(|| format!("{stem} #{}", i + 1));
        let steps = t.get("steps").and_then(Value::as_array).ok_or_else(|| format!("{}: test {name:?} has no `steps`", path.display()))?;
        let steps = steps.iter().map(parse_step).collect::<Result<Vec<_>, _>>().map_err(|e| format!("{}: test {name:?}: {e}", path.display()))?;
        out.push(TestCase {
            name,
            file: path.to_path_buf(),
            profile: get("profile").and_then(Value::as_str).map(String::from),
            start: get("start").or_else(|| get("url")).and_then(Value::as_str).map(String::from),
            steps,
            timeout: get("timeout").and_then(Value::as_u64).unwrap_or(600),
            base_url: get("base_url").and_then(Value::as_str).map(String::from),
        });
    }
    Ok(out)
}

pub const SAMPLE_CONFIG: &str = r#"# e2e.yaml: end-to-end tests for this project, run with `mini-agent-rs e2e`.
# Secrets are references only: env:NAME (falls back to secrets_file), file:PATH#KEY, cmd:COMMAND.
base_url: {BASE_URL}
{SERVER_NAME}tests: [e2e]
# secrets_file: ~/.config/mini-tui/e2e-secrets.env   # chmod 600; the default when it exists
# allowed_origins: []          # other origins the browser may navigate to
models:
  worker: {WORKER}             # act steps
  judge: {JUDGE}               # assert steps (a model that sees screenshots is best)
  # escalate: cliproxy/claude-opus-5-5   # retried failures move to this model
auth:
{SITE_BASIC}  default_profile: {DEFAULT_PROFILE}
  profiles:
{PROFILES}
# environments:
#   local: { base_url: http://127.0.0.1:3000 }
#   production: { base_url: https://example.com, read_only: true }
# default_environment: local
"#;

pub const SAMPLE_TEST: &str = r#"# An example test. `act` and `assert` steps are run by AI workers; the rest is exact.
tests:
  - name: home page loads
    start: /
    steps:
      - expect: { url_contains: "/" }
      - assert: the page shows the application's main content, not an error page
"#;
