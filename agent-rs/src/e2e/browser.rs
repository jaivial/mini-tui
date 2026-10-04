//! One headless Chrome per test, driven over the DevTools protocol: page snapshots with
//! numbered refs, stable locators (role+name, label, test id, CSS), real mouse/keyboard input,
//! screenshots, and saved login state. Every state-changing action is logged with a stable
//! locator so it can be replayed without a model.

use super::cdp::{origin_of, BasicAuth, Cdp};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

/// Page-side helpers, defined once per document (guarded) before every evaluation.
const HELPER: &str = r#"(function(){
if (window.__e2e) return;
const norm = s => (s || '').replace(/\s+/g, ' ').trim();
const lc = s => norm(s).toLowerCase();
function visible(el) {
  if (!el || !el.getBoundingClientRect) return false;
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  const st = getComputedStyle(el);
  return st.visibility !== 'hidden' && st.display !== 'none' && st.opacity !== '0';
}
function role(el) {
  const r = el.getAttribute('role'); if (r) return r.split(' ')[0];
  const t = el.tagName.toLowerCase();
  if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
  if (t === 'button' || t === 'summary') return 'button';
  if (t === 'select') return 'combobox';
  if (t === 'textarea') return 'textbox';
  if (/^h[1-6]$/.test(t)) return 'heading';
  if (t === 'img') return 'img';
  if (t === 'option') return 'option';
  if (t === 'dialog') return 'dialog';
  if (t === 'nav') return 'navigation';
  if (t === 'input') {
    const ty = (el.getAttribute('type') || 'text').toLowerCase();
    if (['button','submit','reset','image'].includes(ty)) return 'button';
    if (ty === 'checkbox') return 'checkbox';
    if (ty === 'radio') return 'radio';
    if (ty === 'range') return 'slider';
    return 'textbox';
  }
  if (el.isContentEditable) return 'textbox';
  return t;
}
function labelText(el) {
  if (el.id) { const l = document.querySelector('label[for="' + CSS.escape(el.id) + '"]'); if (l) return norm(l.innerText); }
  const w = el.closest('label'); if (w) return norm(w.innerText);
  return '';
}
function name(el) {
  const al = el.getAttribute('aria-label'); if (al) return norm(al);
  const lb = el.getAttribute('aria-labelledby');
  if (lb) { const t = lb.split(/\s+/).map(id => { const n = document.getElementById(id); return n ? n.innerText : ''; }).join(' '); if (norm(t)) return norm(t); }
  const t = el.tagName.toLowerCase();
  if (['input','select','textarea'].includes(t)) {
    const ty = (el.getAttribute('type') || '').toLowerCase();
    if (['button','submit','reset'].includes(ty)) return norm(el.value);
    return labelText(el) || norm(el.getAttribute('placeholder')) || norm(el.getAttribute('title')) || norm(el.getAttribute('name'));
  }
  if (t === 'img') return norm(el.getAttribute('alt'));
  return norm(el.innerText || el.textContent).slice(0, 100) || norm(el.getAttribute('title'));
}
const INTERACTIVE = 'a[href],button,input:not([type=hidden]),select,textarea,summary,[role=button],[role=link],[role=checkbox],[role=radio],[role=tab],[role=menuitem],[role=switch],[role=option],[role=combobox],[role=textbox],[contenteditable=true],[onclick]';
function all(sel) { return Array.from(document.querySelectorAll(sel)); }
function cssPath(el) {
  if (el.id) return '#' + CSS.escape(el.id);
  const parts = [];
  while (el && el.nodeType === 1 && parts.length < 6) {
    let p = el.tagName.toLowerCase();
    const sib = el.parentElement ? Array.from(el.parentElement.children).filter(c => c.tagName === el.tagName) : [];
    if (sib.length > 1) p += ':nth-of-type(' + (sib.indexOf(el) + 1) + ')';
    parts.unshift(p);
    if (el.parentElement && el.parentElement.id) { parts.unshift('#' + CSS.escape(el.parentElement.id)); break; }
    el = el.parentElement;
  }
  return parts.join(' > ');
}
function parse(spec) {
  spec = spec.trim();
  let m;
  if ((m = /^(?:ref=)?(e\d+)$/.exec(spec))) return {kind: 'ref', value: m[1]};
  if ((m = /^role=([\w-]+)(?:\[name(~?)=(.*)\])?$/s.exec(spec))) return {kind: 'role', role: m[1], contains: m[2] === '~', name: m[3] === undefined ? null : m[3].replace(/^["']|["']$/g, '')};
  if ((m = /^(label|text|placeholder|testid|css|title|alt)(~?)=(.*)$/s.exec(spec))) return {kind: m[1], contains: m[2] === '~' || m[1] === 'text', value: m[3].replace(/^["']|["']$/g, '')};
  return {kind: 'css', value: spec};
}
function matches(actual, want, contains) { const a = lc(actual), w = lc(want); return contains ? a.includes(w) : a === w; }
function findAll(spec) {
  const p = parse(spec);
  let c = [];
  if (p.kind === 'ref') c = all('[data-e2e-ref="' + p.value + '"]');
  else if (p.kind === 'role') c = all('*').filter(e => role(e) === p.role && (p.name === null || matches(name(e), p.name, p.contains)));
  else if (p.kind === 'label') c = all('input,select,textarea,[contenteditable=true],[role=textbox],[role=combobox]').filter(e => matches(labelText(e) || e.getAttribute('aria-label') || '', p.value, p.contains));
  else if (p.kind === 'placeholder') c = all('[placeholder]').filter(e => matches(e.getAttribute('placeholder'), p.value, p.contains));
  else if (p.kind === 'title') c = all('[title]').filter(e => matches(e.getAttribute('title'), p.value, p.contains));
  else if (p.kind === 'alt') c = all('[alt]').filter(e => matches(e.getAttribute('alt'), p.value, p.contains));
  else if (p.kind === 'testid') c = all('[data-testid="' + CSS.escape(p.value) + '"],[data-test-id="' + CSS.escape(p.value) + '"],[data-test="' + CSS.escape(p.value) + '"]');
  else if (p.kind === 'text') {
    const hits = all('body *').filter(e => visible(e) && matches(e.innerText, p.value, true));
    c = hits.filter(e => !hits.some(o => o !== e && e.contains(o)));
  } else { try { c = all(p.value); } catch (e) { throw new Error('invalid locator: ' + spec); } }
  const vis = c.filter(visible);
  return vis.length ? vis : c;
}
function stable(el) {
  const r = role(el), n = name(el);
  if (n && n.length <= 80 && !/["\]]/.test(n)) { const s = 'role=' + r + '[name=' + n + ']'; if (findAll(s).length === 1) return s; }
  const tid = el.getAttribute('data-testid'); if (tid) return 'testid=' + tid;
  const lt = labelText(el); if (lt && lt.length <= 80) { const s = 'label=' + lt; if (findAll(s).length === 1) return s; }
  const ph = el.getAttribute('placeholder'); if (ph) { const s = 'placeholder=' + ph; if (findAll(s).length === 1) return s; }
  return 'css=' + cssPath(el);
}
window.__e2e = {
  find(spec) {
    const c = findAll(spec);
    if (!c.length) throw new Error('no element matches ' + spec);
    return c[0];
  },
  count(spec) { return findAll(spec).length; },
  locate(spec) {
    const c = findAll(spec);
    if (!c.length) throw new Error('no element matches ' + spec);
    const el = c[0];
    el.scrollIntoView({block: 'center', inline: 'center'});
    const r = el.getBoundingClientRect();
    return {x: r.left + r.width / 2, y: r.top + r.height / 2, stable: stable(el), count: c.length, tag: el.tagName.toLowerCase(), role: role(el), name: name(el)};
  },
  snapshot(maxText) {
    all('[data-e2e-ref]').forEach(e => e.removeAttribute('data-e2e-ref'));
    const lines = []; let i = 0;
    for (const el of all(INTERACTIVE)) {
      if (!visible(el) || el.closest('[aria-hidden=true]')) continue;
      i += 1; const ref = 'e' + i; el.setAttribute('data-e2e-ref', ref);
      let line = '[' + ref + '] ' + role(el) + ' "' + name(el).slice(0, 80) + '"';
      const t = el.tagName.toLowerCase();
      if (t === 'input' || t === 'textarea' || t === 'select') {
        const ty = (el.getAttribute('type') || '').toLowerCase();
        if (ty === 'password') line += el.value ? ' value=••••' : ' (password, empty)';
        else if (ty === 'checkbox' || ty === 'radio') line += el.checked ? ' checked' : ' unchecked';
        else if (el.value) line += ' value="' + String(el.value).slice(0, 60) + '"';
      }
      if (el.disabled) line += ' disabled';
      lines.push(line);
      if (i >= 150) { lines.push('… more elements not listed (scroll or use text=…)'); break; }
    }
    let text = norm(document.body ? document.body.innerText : '');
    if (text.length > maxText) text = text.slice(0, maxText) + ' …';
    return {url: location.href, title: document.title, elements: lines, text: text};
  },
};
})();"#;

pub fn find_chrome() -> Option<String> {
    if let Ok(p) = std::env::var("MINITUI_CHROME") {
        if !p.is_empty() {
            return Some(p);
        }
    }
    for c in ["google-chrome", "google-chrome-stable", "chromium", "chromium-browser", "/snap/bin/chromium"] {
        if c.starts_with('/') {
            if Path::new(c).exists() {
                return Some(c.into());
            }
            continue;
        }
        if let Ok(path) = std::env::var("PATH") {
            for d in path.split(':') {
                let f = Path::new(d).join(c);
                if f.is_file() {
                    return Some(f.display().to_string());
                }
            }
        }
    }
    None
}

#[derive(Clone, Debug)]
pub struct Action {
    pub op: String,
    pub target: String,
    pub value: String,
}

impl Action {
    pub fn to_json(&self) -> Value {
        json!({"op": self.op, "target": self.target, "value": self.value})
    }
    pub fn from_json(v: &Value) -> Action {
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        Action { op: s("op"), target: s("target"), value: s("value") }
    }
}

pub struct Browser {
    child: Child,
    profile_dir: PathBuf,
    pub cdp: Cdp,
    pub base_url: String,
    /// Secrets workers may type by name (`fill-secret`): name -> value.
    pub secrets: std::collections::BTreeMap<String, String>,
    /// Every state-changing action, with stable locators.
    pub log: Vec<Action>,
    /// Assert workers only observe.
    pub read_only: bool,
    pub screenshots_dir: PathBuf,
    shots: usize,
}

impl Drop for Browser {
    fn drop(&mut self) {
        let _ = self.cdp.call_timeout("Browser.close", json!({}), Duration::from_secs(2));
        let deadline = Instant::now() + Duration::from_secs(3);
        while Instant::now() < deadline {
            if let Ok(Some(_)) = self.child.try_wait() {
                break;
            }
            std::thread::sleep(Duration::from_millis(50));
        }
        unsafe {
            libc::killpg(self.child.id() as i32, libc::SIGKILL);
        }
        let _ = self.child.wait();
        super::worker::unregister(self.child.id() as i32);
        let _ = std::fs::remove_dir_all(&self.profile_dir);
    }
}

fn js_str(s: &str) -> String {
    serde_json::to_string(s).unwrap()
}

impl Browser {
    pub fn launch(base_url: &str, headed: bool, screenshots_dir: &Path) -> Result<Browser, String> {
        use std::os::unix::process::CommandExt;
        let chrome = find_chrome().ok_or("no Chrome/Chromium found (set MINITUI_CHROME)")?;
        let profile_dir = std::env::temp_dir().join(format!("mini-e2e-chrome-{}-{}", std::process::id(), crate::util_hex(8)));
        std::fs::create_dir_all(&profile_dir).map_err(|e| e.to_string())?;
        let mut cmd = Command::new(&chrome);
        if !headed {
            cmd.arg("--headless=new");
        }
        cmd.args(["--no-first-run", "--no-default-browser-check", "--disable-gpu", "--disable-extensions", "--disable-background-networking", "--disable-sync", "--password-store=basic", "--use-mock-keychain", "--window-size=1280,900", "--remote-debugging-port=0", "--remote-allow-origins=*"])
            .arg(format!("--user-data-dir={}", profile_dir.display()))
            .arg("about:blank");
        if unsafe { libc::geteuid() } == 0 {
            cmd.arg("--no-sandbox");
        }
        cmd.stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).process_group(0);
        let mut child = cmd.spawn().map_err(|e| format!("{chrome}: {e}"))?;
        // Killed with the workers when the coordinator gets SIGTERM.
        super::worker::register(child.id() as i32);
        let port_file = profile_dir.join("DevToolsActivePort");
        let deadline = Instant::now() + Duration::from_secs(20);
        let port = loop {
            if let Ok(t) = std::fs::read_to_string(&port_file) {
                if let Some(p) = t.lines().next().and_then(|l| l.trim().parse::<u16>().ok()) {
                    break p;
                }
            }
            if let Ok(Some(st)) = child.try_wait() {
                return Err(format!("{chrome} exited at startup ({st})"));
            }
            if Instant::now() > deadline {
                let _ = child.kill();
                return Err(format!("{chrome} did not open its DevTools port"));
            }
            std::thread::sleep(Duration::from_millis(100));
        };
        let body = ureq::get(&format!("http://127.0.0.1:{port}/json/list")).call().map_err(|e| e.to_string())?.into_string().map_err(|e| e.to_string())?;
        let list: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
        let ws = list
            .as_array()
            .and_then(|a| a.iter().find(|t| t.get("type").and_then(Value::as_str) == Some("page")))
            .and_then(|t| t.get("webSocketDebuggerUrl").and_then(Value::as_str))
            .map(String::from)
            .ok_or("Chrome has no page target")?;
        let cdp = Cdp::connect(&ws)?;
        let _ = std::fs::create_dir_all(screenshots_dir);
        let mut b = Browser { child, profile_dir, cdp, base_url: base_url.trim_end_matches('/').to_string(), secrets: Default::default(), log: vec![], read_only: false, screenshots_dir: screenshots_dir.to_path_buf(), shots: 0 };
        b.cdp.call("Page.enable", json!({}))?;
        b.cdp.call("Page.addScriptToEvaluateOnNewDocument", json!({"source": HELPER}))?;
        b.cdp.call("Fetch.enable", json!({"patterns": [{"urlPattern": "*", "requestStage": "Request"}], "handleAuthRequests": true}))?;
        b.cdp.allowed_origins = vec![origin_of(base_url)];
        Ok(b)
    }

    pub fn set_basic_auth(&mut self, user: String, password: String) {
        self.cdp.basic_auth = Some(BasicAuth { origin: origin_of(&self.base_url), user, password });
    }

    pub fn allow_origin(&mut self, o: &str) {
        let o = origin_of(o);
        if !o.is_empty() && !self.cdp.allowed_origins.contains(&o) {
            self.cdp.allowed_origins.push(o);
        }
    }

    /// An absolute URL for a path relative to the base URL (base path kept).
    pub fn resolve_url(&self, target: &str) -> String {
        if target.contains("://") || target.starts_with("about:") || target.starts_with("data:") {
            return target.to_string();
        }
        let t = target.trim_start_matches('/');
        format!("{}/{}", self.base_url, t)
    }

    pub fn eval(&mut self, expr: &str) -> Result<Value, String> {
        let full = format!("{HELPER};\n({expr})");
        let mut last = String::new();
        for _ in 0..20 {
            match self.cdp.eval(&full) {
                Ok(v) => return Ok(v),
                Err(e) if e.contains("context") || e.contains("Cannot find") || e.contains("Inspected target navigated") => {
                    last = e;
                    std::thread::sleep(Duration::from_millis(150));
                }
                Err(e) => return Err(e),
            }
        }
        Err(last)
    }

    pub fn url(&mut self) -> String {
        self.cdp.eval("location.href").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or_default()
    }

    fn check_guards(&mut self) -> Result<(), String> {
        if let Some(u) = self.cdp.blocked.take() {
            return Err(format!("left the app: navigation to {u} is outside the allowed origins"));
        }
        if let Some(a) = self.cdp.auth_failed.take() {
            return Err(a);
        }
        Ok(())
    }

    /// Wait until the document is loaded and quiet for a moment.
    pub fn settle(&mut self, max: Duration) -> Result<(), String> {
        let deadline = Instant::now() + max;
        let _ = self.cdp.pump(Duration::from_millis(250), &|_| false)?;
        loop {
            let ready = self.cdp.eval("document.readyState").ok().and_then(|v| v.as_str().map(String::from));
            if ready.as_deref() == Some("complete") || Instant::now() > deadline {
                break;
            }
            let _ = self.cdp.pump(Duration::from_millis(150), &|_| false)?;
        }
        let _ = self.cdp.pump(Duration::from_millis(200), &|_| false)?;
        self.check_guards()
    }

    pub fn open(&mut self, target: &str) -> Result<String, String> {
        let url = self.resolve_url(target);
        self.cdp.events.clear();
        let r = self.cdp.call_timeout("Page.navigate", json!({"url": url}), Duration::from_secs(60))?;
        self.check_guards()?;
        if let Some(err) = r.get("errorText").and_then(Value::as_str).filter(|s| !s.is_empty()) {
            return Err(format!("could not open {url}: {err}"));
        }
        let _ = self.cdp.pump(Duration::from_secs(30), &|e| e.get("method").and_then(Value::as_str) == Some("Page.loadEventFired"))?;
        self.settle(Duration::from_secs(10))?;
        let status = self.eval("(performance.getEntriesByType('navigation')[0] || {}).responseStatus || 0").ok().and_then(|v| v.as_i64()).unwrap_or(0);
        if status == 401 {
            return Err(format!("{url} answered 401 Unauthorized (HTTP auth credentials missing or wrong)"));
        }
        self.log.push(Action { op: "open".into(), target: target.into(), value: String::new() });
        Ok(format!("opened {} (HTTP {})", self.url(), if status > 0 { status.to_string() } else { "?".into() }))
    }

    pub fn snapshot(&mut self, max_text: usize) -> Result<String, String> {
        let v = self.eval(&format!("window.__e2e.snapshot({max_text})"))?;
        let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("").to_string();
        let els: Vec<String> = v.get("elements").and_then(Value::as_array).map(|a| a.iter().filter_map(|x| x.as_str().map(String::from)).collect()).unwrap_or_default();
        let mut out = format!("URL: {}\nTitle: {}\nInteractive elements (use the [ref] or a locator):\n", s("url"), s("title"));
        if els.is_empty() {
            out.push_str("(none)\n");
        }
        for l in els {
            out.push_str(&l);
            out.push('\n');
        }
        out.push_str("Visible text:\n");
        out.push_str(&s("text"));
        Ok(super::secrets::scrub(&out))
    }

    fn locate(&mut self, spec: &str) -> Result<(f64, f64, String, i64), String> {
        let deadline = Instant::now() + Duration::from_secs(5);
        loop {
            match self.eval(&format!("window.__e2e.locate({})", js_str(spec))) {
                Ok(v) => {
                    let x = v.get("x").and_then(Value::as_f64).unwrap_or(0.0);
                    let y = v.get("y").and_then(Value::as_f64).unwrap_or(0.0);
                    let st = v.get("stable").and_then(Value::as_str).unwrap_or(spec).to_string();
                    let n = v.get("count").and_then(Value::as_i64).unwrap_or(1);
                    return Ok((x, y, st, n));
                }
                Err(e) if Instant::now() < deadline && e.contains("no element") => std::thread::sleep(Duration::from_millis(250)),
                Err(e) => return Err(e),
            }
        }
    }

    fn guard_write(&self, what: &str) -> Result<(), String> {
        if self.read_only {
            return Err(format!("`{what}` is not allowed while checking an assertion: only observe (snapshot, text, scroll, wait, screenshot)"));
        }
        Ok(())
    }

    pub fn click(&mut self, spec: &str) -> Result<String, String> {
        self.guard_write("click")?;
        let (x, y, stable, n) = self.locate(spec)?;
        for (t, buttons) in [("mouseMoved", 0), ("mousePressed", 1), ("mouseReleased", 0)] {
            let mut p = json!({"type": t, "x": x, "y": y, "button": "left", "buttons": buttons});
            if t != "mouseMoved" {
                p["clickCount"] = json!(1);
            }
            self.cdp.call("Input.dispatchMouseEvent", p)?;
        }
        self.settle(Duration::from_secs(10))?;
        self.log.push(Action { op: "click".into(), target: stable.clone(), value: String::new() });
        Ok(format!("clicked {stable}{}", if n > 1 { format!(" (first of {n} matches)") } else { String::new() }))
    }

    fn focus_and_clear(&mut self, spec: &str) -> Result<String, String> {
        let (_, _, stable, _) = self.locate(spec)?;
        self.eval(&format!(
            "(function(){{const el = window.__e2e.find({}); el.focus(); if (el.select) el.select(); else if (el.isContentEditable) document.execCommand('selectAll'); return true;}})()",
            js_str(&stable)
        ))?;
        // Delete the selection so insertText replaces the old value.
        self.cdp.call("Input.dispatchKeyEvent", json!({"type": "keyDown", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}))?;
        self.cdp.call("Input.dispatchKeyEvent", json!({"type": "keyUp", "key": "Backspace", "code": "Backspace", "windowsVirtualKeyCode": 8}))?;
        Ok(stable)
    }

    pub fn type_text(&mut self, spec: &str, text: &str) -> Result<String, String> {
        self.guard_write("type")?;
        let stable = self.focus_and_clear(spec)?;
        self.cdp.call("Input.insertText", json!({"text": text}))?;
        self.log.push(Action { op: "type".into(), target: stable.clone(), value: text.into() });
        Ok(format!("typed {} chars into {stable}", text.chars().count()))
    }

    /// Type a configured secret by name; the value never leaves this process.
    pub fn fill_secret(&mut self, spec: &str, name: &str) -> Result<String, String> {
        self.guard_write("fill-secret")?;
        let value = self.secrets.get(name).cloned().ok_or_else(|| format!("unknown secret {name}; available: {}", self.secrets.keys().cloned().collect::<Vec<_>>().join(", ")))?;
        let stable = self.focus_and_clear(spec)?;
        self.cdp.call("Input.insertText", json!({"text": value}))?;
        self.log.push(Action { op: "fill-secret".into(), target: stable.clone(), value: name.into() });
        Ok(format!("filled secret {name} into {stable}"))
    }

    pub fn press(&mut self, key: &str) -> Result<String, String> {
        self.guard_write("press")?;
        let (k, code, vk, text) = match key.to_lowercase().as_str() {
            "enter" | "return" => ("Enter", "Enter", 13, "\r"),
            "tab" => ("Tab", "Tab", 9, ""),
            "escape" | "esc" => ("Escape", "Escape", 27, ""),
            "backspace" => ("Backspace", "Backspace", 8, ""),
            "space" => (" ", "Space", 32, " "),
            "arrowdown" | "down" => ("ArrowDown", "ArrowDown", 40, ""),
            "arrowup" | "up" => ("ArrowUp", "ArrowUp", 38, ""),
            "arrowleft" | "left" => ("ArrowLeft", "ArrowLeft", 37, ""),
            "arrowright" | "right" => ("ArrowRight", "ArrowRight", 39, ""),
            _ => return Err(format!("unsupported key {key} (Enter, Tab, Escape, Backspace, Space, arrows)")),
        };
        let mut down = json!({"type": "keyDown", "key": k, "code": code, "windowsVirtualKeyCode": vk});
        if !text.is_empty() {
            down["text"] = json!(text);
        }
        self.cdp.call("Input.dispatchKeyEvent", down)?;
        self.cdp.call("Input.dispatchKeyEvent", json!({"type": "keyUp", "key": k, "code": code, "windowsVirtualKeyCode": vk}))?;
        self.settle(Duration::from_secs(10))?;
        self.log.push(Action { op: "press".into(), target: String::new(), value: k.into() });
        Ok(format!("pressed {k}"))
    }

    pub fn select(&mut self, spec: &str, option: &str) -> Result<String, String> {
        self.guard_write("select")?;
        let (_, _, stable, _) = self.locate(spec)?;
        let v = self.eval(&format!(
            "(function(){{const el = window.__e2e.find({}); const want = {}.toLowerCase().trim(); const o = Array.from(el.options || []).find(o => o.value.toLowerCase() === want || o.text.toLowerCase().trim() === want); if (!o) throw new Error('no option ' + want); el.value = o.value; el.dispatchEvent(new Event('input', {{bubbles: true}})); el.dispatchEvent(new Event('change', {{bubbles: true}})); return o.text;}})()",
            js_str(&stable),
            js_str(option)
        ))?;
        self.settle(Duration::from_secs(5))?;
        self.log.push(Action { op: "select".into(), target: stable.clone(), value: option.into() });
        Ok(format!("selected {} in {stable}", v.as_str().unwrap_or(option)))
    }

    pub fn scroll(&mut self, dir: &str) -> Result<String, String> {
        let dy = match dir {
            "up" => -700,
            "top" => -1_000_000,
            "bottom" => 1_000_000,
            _ => 700,
        };
        self.eval(&format!("window.scrollBy(0, {dy})"))?;
        let _ = self.cdp.pump(Duration::from_millis(300), &|_| false);
        Ok(format!("scrolled {dir}"))
    }

    pub fn count(&mut self, spec: &str) -> Result<i64, String> {
        Ok(self.eval(&format!("window.__e2e.count({})", js_str(spec)))?.as_i64().unwrap_or(0))
    }

    pub fn text_of(&mut self, spec: &str) -> Result<String, String> {
        let v = self.eval(&format!("(function(){{const el = window.__e2e.find({}); return (el.value !== undefined && el.tagName !== 'BUTTON' && el.type !== 'password' ? String(el.value) + ' ' : '') + (el.innerText || el.textContent || '');}})()", js_str(spec)))?;
        Ok(super::secrets::scrub(v.as_str().unwrap_or("").trim()))
    }

    /// Wait for a locator (or `url~=…`) to appear, or for a number of milliseconds.
    pub fn wait_for(&mut self, what: &str, timeout: Duration) -> Result<String, String> {
        if let Ok(ms) = what.trim().parse::<u64>() {
            let _ = self.cdp.pump(Duration::from_millis(ms.min(30_000)), &|_| false)?;
            return Ok(format!("waited {ms} ms"));
        }
        let deadline = Instant::now() + timeout;
        loop {
            let ok = if let Some(u) = what.strip_prefix("url~=") { self.url().contains(u) } else { self.count(what).unwrap_or(0) > 0 };
            if ok {
                return Ok(format!("found {what}"));
            }
            if Instant::now() > deadline {
                return Err(format!("timed out waiting for {what}"));
            }
            let _ = self.cdp.pump(Duration::from_millis(250), &|_| false)?;
            self.check_guards()?;
        }
    }

    pub fn back(&mut self) -> Result<String, String> {
        self.guard_write("back")?;
        self.eval("history.back()")?;
        self.settle(Duration::from_secs(10))?;
        self.log.push(Action { op: "back".into(), target: String::new(), value: String::new() });
        Ok(format!("went back to {}", self.url()))
    }

    /// Save a JPEG of the viewport; returns (path, base64 data).
    pub fn screenshot(&mut self, label: &str) -> Result<(PathBuf, String), String> {
        let r = self.cdp.call("Page.captureScreenshot", json!({"format": "jpeg", "quality": 70}))?;
        let data = r.get("data").and_then(Value::as_str).unwrap_or("").to_string();
        use base64::Engine;
        let bytes = base64::engine::general_purpose::STANDARD.decode(&data).map_err(|e| e.to_string())?;
        self.shots += 1;
        let safe: String = label.chars().map(|c| if c.is_ascii_alphanumeric() || c == '-' { c } else { '_' }).take(40).collect();
        let path = self.screenshots_dir.join(format!("{:03}-{safe}.jpg", self.shots));
        std::fs::write(&path, bytes).map_err(|e| e.to_string())?;
        Ok((path, data))
    }

    /// Replay one logged action (cached steps). Errors when a locator no longer resolves.
    pub fn replay(&mut self, a: &Action) -> Result<String, String> {
        match a.op.as_str() {
            "open" => self.open(&a.target),
            "click" => {
                if self.count(&a.target)? == 0 {
                    let _ = self.wait_for(&a.target, Duration::from_secs(5));
                }
                self.click(&a.target)
            }
            "type" => self.type_text(&a.target, &a.value),
            "fill-secret" => self.fill_secret(&a.target, &a.value),
            "press" => self.press(&a.value),
            "select" => self.select(&a.target, &a.value),
            "back" => self.back(),
            other => Err(format!("unknown cached action {other}")),
        }
    }

    // ---- login state -------------------------------------------------------------------

    pub fn export_state(&mut self) -> Result<Value, String> {
        let cookies = self.cdp.call("Storage.getCookies", json!({}))?.get("cookies").cloned().unwrap_or(json!([]));
        let local = self.eval("JSON.stringify(Object.assign({}, localStorage))").ok().and_then(|v| v.as_str().map(String::from)).unwrap_or("{}".into());
        Ok(json!({"origin": origin_of(&self.base_url), "cookies": cookies, "local_storage": serde_json::from_str::<Value>(&local).unwrap_or(json!({})), "saved_at": crate::util::now()}))
    }

    /// Load cookies and localStorage (the page must be on the base origin for localStorage).
    pub fn import_state(&mut self, state: &Value) -> Result<(), String> {
        if let Some(c) = state.get("cookies").and_then(Value::as_array) {
            let cookies: Vec<Value> = c
                .iter()
                .map(|k| {
                    let mut k = k.clone();
                    if let Some(o) = k.as_object_mut() {
                        for drop in ["size", "session", "priority", "sourceScheme", "sourcePort", "partitionKey", "partitionKeyOpaque"] {
                            o.remove(drop);
                        }
                        if o.get("expires").and_then(Value::as_f64).is_some_and(|e| e < 0.0) {
                            o.remove("expires");
                        }
                    }
                    k
                })
                .collect();
            if !cookies.is_empty() {
                self.cdp.call("Storage.setCookies", json!({"cookies": cookies}))?;
            }
        }
        if let Some(ls) = state.get("local_storage").filter(|v| v.as_object().is_some_and(|o| !o.is_empty())) {
            self.eval(&format!("(function(){{const d = {}; for (const k in d) localStorage.setItem(k, d[k]); return true;}})()", ls))?;
        }
        Ok(())
    }
}
