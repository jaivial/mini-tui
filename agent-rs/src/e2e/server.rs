//! The per-test browser server and the `mini-agent-rs browser …` client workers use from their
//! bash tool. One JSON line in (`{"args": [...]}`), one JSON line out (`{"ok", "output"}`), over a
//! Unix socket in a 0700 directory. Secrets stay in this process: workers name them.

use super::browser::Browser;
use serde_json::{json, Value};
use std::io::{BufRead, BufReader, Write};
use std::os::unix::net::{UnixListener, UnixStream};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

pub struct Session {
    pub browser: Browser,
    /// The current worker's model takes images: screenshots are sent inline.
    pub vision: bool,
    /// Number of commands served to the current worker.
    pub commands: usize,
}

pub type Shared = Arc<Mutex<Session>>;

pub const HELP: &str = "browser commands (run them with the bash tool):
  browser snapshot                 page URL, numbered interactive elements [eN], visible text
  browser open <path-or-url>       paths are relative to the app's base URL
  browser click <locator>
  browser type <locator> <text...> replaces the field's value
  browser fill-secret <locator> <SECRET_NAME>   types a configured secret you never see
  browser secrets                  names of the secrets you may fill
  browser press <Enter|Tab|Escape|Backspace|Space|ArrowDown|...>
  browser select <locator> <option text or value>
  browser scroll <down|up|top|bottom>
  browser wait <locator | url~=part | milliseconds>
  browser text <locator>           the element's text / value
  browser count <locator>
  browser url
  browser back
  browser screenshot [label]
locators: e12 (a ref from the latest snapshot), role=button[name=Sign in], role=link[name~=pric],
  label=Email, placeholder=Search, text=Welcome back, testid=save, css=#main .card";

fn dispatch(s: &mut Session, args: &[String]) -> Result<String, String> {
    let a = |i: usize| args.get(i).cloned().ok_or_else(|| format!("missing argument\n{HELP}"));
    let rest = |i: usize| if args.len() > i { Ok(args[i..].join(" ")) } else { Err(format!("missing argument\n{HELP}")) };
    let b = &mut s.browser;
    match args.first().map(String::as_str).unwrap_or("") {
        "snapshot" | "look" => b.snapshot(4000),
        "open" | "goto" => b.open(&a(1)?).and_then(|m| Ok(format!("{m}\n\n{}", b.snapshot(2500)?))),
        "click" => b.click(&a(1)?).and_then(|m| Ok(format!("{m}\n\n{}", b.snapshot(2500)?))),
        "type" | "fill" => b.type_text(&a(1)?, &rest(2)?),
        "fill-secret" => b.fill_secret(&a(1)?, &a(2)?),
        "secrets" => Ok(if b.secrets.is_empty() { "no secrets are configured".into() } else { b.secrets.keys().cloned().collect::<Vec<_>>().join("\n") }),
        "press" => b.press(&a(1)?).and_then(|m| Ok(format!("{m}\n\n{}", b.snapshot(2500)?))),
        "select" => b.select(&a(1)?, &rest(2)?),
        "scroll" => b.scroll(args.get(1).map(String::as_str).unwrap_or("down")).and_then(|m| Ok(format!("{m}\n\n{}", b.snapshot(2500)?))),
        "wait" => b.wait_for(&rest(1)?, Duration::from_secs(15)),
        "text" => b.text_of(&rest(1)?),
        "count" => b.count(&rest(1)?).map(|n| n.to_string()),
        "url" => Ok(b.url()),
        "back" => b.back(),
        "screenshot" => {
            let label = args.get(1).cloned().unwrap_or_else(|| "worker".into());
            let (path, data) = b.screenshot(&label)?;
            if s.vision {
                Ok(format!("screenshot saved to {}\n<MSWEA_MULTIMODAL_CONTENT><CONTENT_TYPE>image_url</CONTENT_TYPE>data:image/jpeg;base64,{data}</MSWEA_MULTIMODAL_CONTENT>", path.display()))
            } else {
                Ok(format!("screenshot saved to {} (your model has no image input: use `snapshot` to see the page)", path.display()))
            }
        }
        "help" | "" => Ok(HELP.into()),
        other => Err(format!("unknown browser command {other}\n{HELP}")),
    }
}

fn serve_one(stream: UnixStream, shared: &Shared) {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(10)));
    let mut line = String::new();
    let mut reader = BufReader::new(match stream.try_clone() {
        Ok(s) => s,
        Err(_) => return,
    });
    if reader.read_line(&mut line).is_err() {
        return;
    }
    let req: Value = serde_json::from_str(&line).unwrap_or(json!({}));
    let args: Vec<String> = req.get("args").and_then(Value::as_array).map(|a| a.iter().map(|x| x.as_str().map(String::from).unwrap_or_else(|| x.to_string())).collect()).unwrap_or_default();
    let reply = {
        let mut s = match shared.lock() {
            Ok(s) => s,
            Err(p) => p.into_inner(),
        };
        s.commands += 1;
        match dispatch(&mut s, &args) {
            Ok(out) => json!({"ok": true, "output": super::secrets::scrub(&out)}),
            Err(e) => json!({"ok": false, "output": super::secrets::scrub(&e)}),
        }
    };
    let mut w = stream;
    let _ = writeln!(w, "{}", reply);
}

pub struct Server {
    pub socket: PathBuf,
    stop: Arc<AtomicBool>,
    handle: Option<std::thread::JoinHandle<()>>,
}

impl Server {
    pub fn start(socket: &Path, shared: Shared) -> Result<Server, String> {
        let _ = std::fs::remove_file(socket);
        let listener = UnixListener::bind(socket).map_err(|e| format!("{}: {e}", socket.display()))?;
        {
            use std::os::unix::fs::PermissionsExt;
            let _ = std::fs::set_permissions(socket, std::fs::Permissions::from_mode(0o600));
        }
        listener.set_nonblocking(true).map_err(|e| e.to_string())?;
        let stop = Arc::new(AtomicBool::new(false));
        let st = stop.clone();
        let handle = std::thread::spawn(move || {
            while !st.load(Ordering::SeqCst) {
                match listener.accept() {
                    Ok((stream, _)) => {
                        let _ = stream.set_nonblocking(false);
                        serve_one(stream, &shared);
                    }
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => std::thread::sleep(Duration::from_millis(30)),
                    Err(_) => std::thread::sleep(Duration::from_millis(100)),
                }
            }
        });
        Ok(Server { socket: socket.to_path_buf(), stop, handle: Some(handle) })
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::SeqCst);
        if let Some(h) = self.handle.take() {
            let _ = h.join();
        }
        let _ = std::fs::remove_file(&self.socket);
    }
}

/// `mini-agent-rs browser <args…>`: the worker-side client.
pub fn client(args: &[String]) -> i32 {
    if args.is_empty() || args[0] == "help" || args[0] == "--help" {
        println!("{HELP}");
        return 0;
    }
    let Some(sock) = std::env::var("E2E_BROWSER_SOCKET").ok().filter(|s| !s.is_empty()) else {
        eprintln!("error: no browser session (E2E_BROWSER_SOCKET is not set; browser commands only work inside an e2e worker)");
        return 2;
    };
    let mut stream = match UnixStream::connect(&sock) {
        Ok(s) => s,
        Err(e) => {
            eprintln!("error: browser session {sock}: {e}");
            return 2;
        }
    };
    let _ = stream.set_read_timeout(Some(Duration::from_secs(180)));
    if writeln!(stream, "{}", json!({"args": args})).is_err() {
        eprintln!("error: could not talk to the browser session");
        return 2;
    }
    let mut line = String::new();
    let _ = BufReader::new(stream).read_line(&mut line);
    let v: Value = serde_json::from_str(&line).unwrap_or(json!({"ok": false, "output": "no reply from the browser session"}));
    let out = v.get("output").and_then(Value::as_str).unwrap_or("");
    if v.get("ok").and_then(Value::as_bool) == Some(true) {
        println!("{out}");
        0
    } else {
        eprintln!("error: {out}");
        1
    }
}
