//! `base_url: auto`: find the nginx vhost that serves a project directory.
//!
//! A vhost serves the project when its `root`/`alias` is inside the project directory, or when
//! a `proxy_pass` (directly, or through an `upstream` block) points to a local port whose
//! listening process runs from inside it (port -> socket inode in /proc/net/tcp* -> pid via
//! /proc/<pid>/fd -> /proc/<pid>/cwd). Files we cannot read are reported, never guessed around.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Default)]
pub struct Location {
    pub path: String,
    pub root: Option<String>,
    pub proxy_pass: Option<String>,
    pub auth_basic: bool,
}

#[derive(Clone, Debug, Default)]
pub struct Server {
    pub file: PathBuf,
    pub names: Vec<String>,
    pub ssl: bool,
    pub ports: Vec<u16>,
    pub root: Option<String>,
    pub auth_basic: bool,
    pub locations: Vec<Location>,
    pub redirects_to_https: bool,
}

#[derive(Default, Debug)]
pub struct Parsed {
    pub servers: Vec<Server>,
    pub upstreams: BTreeMap<String, Vec<String>>,
    pub unreadable: Vec<String>,
}

#[derive(Clone, Debug)]
pub struct Match {
    pub url: String,
    pub server_name: String,
    pub file: PathBuf,
    pub how: String,
    pub auth_basic: bool,
}

/// Tokens: words, quoted strings, `{`, `}`, `;` (comments dropped).
fn tokenize(text: &str) -> Vec<String> {
    let mut out = vec![];
    let mut cur = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        match c {
            '#' => {
                while let Some(&n) = chars.peek() {
                    if n == '\n' {
                        break;
                    }
                    chars.next();
                }
            }
            '"' | '\'' => {
                let q = c;
                while let Some(n) = chars.next() {
                    if n == '\\' {
                        if let Some(x) = chars.next() {
                            cur.push(x);
                        }
                    } else if n == q {
                        break;
                    } else {
                        cur.push(n);
                    }
                }
            }
            '{' | '}' | ';' => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
                out.push(c.to_string());
            }
            c if c.is_whitespace() => {
                if !cur.is_empty() {
                    out.push(std::mem::take(&mut cur));
                }
            }
            c => cur.push(c),
        }
    }
    if !cur.is_empty() {
        out.push(cur);
    }
    out
}

#[derive(Debug, Clone)]
struct Node {
    args: Vec<String>,
    children: Vec<Node>,
}

fn parse_block(tokens: &[String], i: &mut usize) -> Vec<Node> {
    let mut nodes = vec![];
    let mut args: Vec<String> = vec![];
    while *i < tokens.len() {
        let t = &tokens[*i];
        *i += 1;
        match t.as_str() {
            ";" => {
                if !args.is_empty() {
                    nodes.push(Node { args: std::mem::take(&mut args), children: vec![] });
                }
            }
            "{" => {
                let children = parse_block(tokens, i);
                nodes.push(Node { args: std::mem::take(&mut args), children });
            }
            "}" => return nodes,
            _ => args.push(t.clone()),
        }
    }
    nodes
}

fn glob_files(pattern: &str, base: &Path) -> Vec<PathBuf> {
    let p = if Path::new(pattern).is_absolute() { PathBuf::from(pattern) } else { base.join(pattern) };
    let s = p.display().to_string();
    if !s.contains('*') {
        return vec![p];
    }
    let (dir, file) = match s.rsplit_once('/') {
        Some((d, f)) => (PathBuf::from(d), f.to_string()),
        None => (PathBuf::from("."), s.clone()),
    };
    let re = regex::Regex::new(&format!("^{}$", regex::escape(&file).replace("\\*", ".*"))).unwrap();
    let mut out: Vec<PathBuf> = std::fs::read_dir(&dir).map(|rd| rd.flatten().map(|e| e.path()).filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| re.is_match(n))).collect()).unwrap_or_default();
    out.sort();
    out
}

/// Nodes with `include` directives expanded (readable files only).
fn expand(nodes: Vec<Node>, base: &Path, parsed: &mut Parsed, depth: usize) -> Vec<Node> {
    let mut out = vec![];
    for n in nodes {
        if n.args.first().map(String::as_str) == Some("include") && n.children.is_empty() && depth < 8 {
            for f in glob_files(n.args.get(1).map(String::as_str).unwrap_or(""), base) {
                match std::fs::read_to_string(&f) {
                    Ok(t) => {
                        let toks = tokenize(&t);
                        let mut i = 0;
                        let sub = parse_block(&toks, &mut i);
                        out.extend(expand(sub, base, parsed, depth + 1));
                    }
                    Err(e) => parsed.unreadable.push(format!("{}: {e}", f.display())),
                }
            }
            continue;
        }
        let children = expand(n.children, base, parsed, depth + 1);
        out.push(Node { args: n.args, children });
    }
    out
}

fn collect(nodes: &[Node], file: &Path, parsed: &mut Parsed) {
    for n in nodes {
        match n.args.first().map(String::as_str) {
            Some("http") => collect(&n.children, file, parsed),
            Some("upstream") => {
                let name = n.args.get(1).cloned().unwrap_or_default();
                let servers = n.children.iter().filter(|c| c.args.first().map(String::as_str) == Some("server")).filter_map(|c| c.args.get(1).cloned()).collect();
                parsed.upstreams.insert(name, servers);
            }
            Some("server") if !n.children.is_empty() => {
                let mut s = Server { file: file.to_path_buf(), ..Default::default() };
                for c in &n.children {
                    let a = &c.args;
                    match a.first().map(String::as_str) {
                        Some("listen") => {
                            if a.iter().any(|x| x == "ssl" || x == "quic") {
                                s.ssl = true;
                            }
                            if let Some(p) = a.get(1).and_then(|x| x.rsplit(':').next()).and_then(|x| x.parse().ok()) {
                                s.ports.push(p);
                            }
                        }
                        Some("server_name") => s.names.extend(a[1..].iter().cloned()),
                        Some("root") => s.root = a.get(1).cloned(),
                        Some("auth_basic") => s.auth_basic = a.get(1).is_some_and(|v| v != "off"),
                        Some("ssl_certificate") => s.ssl = true,
                        Some("return") | Some("rewrite") => {
                            if a.iter().any(|x| x.starts_with("https://")) {
                                s.redirects_to_https = true;
                            }
                        }
                        Some("location") => {
                            let path = a.last().cloned().unwrap_or_default();
                            let mut loc = Location { path, auth_basic: s.auth_basic, ..Default::default() };
                            for d in &c.children {
                                match d.args.first().map(String::as_str) {
                                    Some("root") | Some("alias") => loc.root = d.args.get(1).cloned(),
                                    Some("proxy_pass") => loc.proxy_pass = d.args.get(1).cloned(),
                                    Some("auth_basic") => loc.auth_basic = d.args.get(1).is_some_and(|v| v != "off"),
                                    _ => {}
                                }
                            }
                            s.locations.push(loc);
                        }
                        _ => {}
                    }
                }
                // auth_basic declared after locations still applies to those without their own.
                if s.auth_basic {
                    for l in &mut s.locations {
                        l.auth_basic = true;
                    }
                }
                parsed.servers.push(s);
            }
            _ => {}
        }
    }
}

pub fn parse_dir(dir: &Path) -> Parsed {
    let mut parsed = Parsed::default();
    let base = dir.parent().unwrap_or(Path::new("/etc/nginx")).to_path_buf();
    let mut files: Vec<PathBuf> = match std::fs::read_dir(dir) {
        Ok(rd) => rd.flatten().map(|e| e.path()).collect(),
        Err(e) => {
            parsed.unreadable.push(format!("{}: {e}", dir.display()));
            return parsed;
        }
    };
    files.sort();
    for f in files {
        match std::fs::read_to_string(&f) {
            Ok(t) => {
                let toks = tokenize(&t);
                let mut i = 0;
                let nodes = parse_block(&toks, &mut i);
                let nodes = expand(nodes, &base, &mut parsed, 0);
                collect(&nodes, &f, &mut parsed);
            }
            Err(e) => parsed.unreadable.push(format!("{}: {e}", f.display())),
        }
    }
    parsed
}

/// Local ports a proxy target reaches (`http://127.0.0.1:4317/x`, an upstream name, `localhost`).
fn proxy_ports(target: &str, upstreams: &BTreeMap<String, Vec<String>>) -> Vec<u16> {
    let rest = target.split_once("://").map(|(_, r)| r).unwrap_or(target);
    let hostport = rest.split('/').next().unwrap_or("");
    let hostport = hostport.trim_end_matches(';');
    if let Some(servers) = upstreams.get(hostport) {
        return servers.iter().flat_map(|s| proxy_ports(&format!("http://{s}"), &BTreeMap::new())).collect();
    }
    let (host, port) = match hostport.rsplit_once(':') {
        Some((h, p)) => (h, p.parse().unwrap_or(0)),
        None => (hostport, if target.starts_with("https") { 443 } else { 80 }),
    };
    let local = ["127.0.0.1", "localhost", "0.0.0.0", "[::1]", "::1"].contains(&host) || host.starts_with("127.");
    if local && port > 0 {
        vec![port]
    } else {
        vec![]
    }
}

/// The working directory of the process listening on a local TCP port, when visible to us.
pub fn port_cwd(port: u16) -> Option<PathBuf> {
    let mut inodes = vec![];
    for f in ["/proc/net/tcp", "/proc/net/tcp6"] {
        let Ok(t) = std::fs::read_to_string(f) else { continue };
        for line in t.lines().skip(1) {
            let cols: Vec<&str> = line.split_whitespace().collect();
            if cols.len() < 10 || cols[3] != "0A" {
                continue; // LISTEN only
            }
            let lport = cols[1].rsplit(':').next().and_then(|p| u16::from_str_radix(p, 16).ok());
            if lport == Some(port) {
                inodes.push(format!("socket:[{}]", cols[9]));
            }
        }
    }
    if inodes.is_empty() {
        return None;
    }
    let procs = std::fs::read_dir("/proc").ok()?;
    for p in procs.flatten() {
        let name = p.file_name();
        let Some(pid) = name.to_str().filter(|n| n.chars().all(|c| c.is_ascii_digit())) else { continue };
        let Ok(fds) = std::fs::read_dir(format!("/proc/{pid}/fd")) else { continue };
        for fd in fds.flatten() {
            if let Ok(link) = std::fs::read_link(fd.path()) {
                if inodes.iter().any(|i| link.to_str() == Some(i.as_str())) {
                    // A process whose working directory was deleted serves no project.
                    let cwd = std::fs::read_link(format!("/proc/{pid}/cwd")).ok()?;
                    return (!cwd.to_string_lossy().ends_with(" (deleted)")).then_some(cwd);
                }
            }
        }
    }
    None
}

fn inside(path: &Path, dir: &Path) -> bool {
    let p = std::fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf());
    p.starts_with(dir)
}

/// Every vhost serving `project`, best first (https before http).
pub fn find(parsed: &Parsed, project: &Path, port_cwd: &dyn Fn(u16) -> Option<PathBuf>) -> Vec<Match> {
    let project = std::fs::canonicalize(project).unwrap_or_else(|_| project.to_path_buf());
    let mut out: Vec<Match> = vec![];
    for s in &parsed.servers {
        let Some(name) = s.names.iter().find(|n| *n != "_" && !n.starts_with('~') && !n.contains('*')).cloned() else { continue };
        let mut hits: Vec<(String, String, bool)> = vec![];
        if let Some(r) = &s.root {
            if inside(Path::new(r), &project) {
                hits.push(("/".into(), format!("root {r}"), s.auth_basic));
            }
        }
        for l in &s.locations {
            if l.path.starts_with("/.well-known") || l.path.starts_with('~') || l.path.starts_with('=') && l.path.len() > 1 && !l.path.ends_with('/') {
                continue;
            }
            let path = l.path.trim_start_matches(['^', '~', '=', ' ']).to_string();
            if let Some(r) = &l.root {
                if inside(Path::new(r), &project) {
                    hits.push((path.clone(), format!("root {r}"), l.auth_basic));
                }
            }
            if let Some(pp) = &l.proxy_pass {
                for port in proxy_ports(pp, &parsed.upstreams) {
                    if let Some(cwd) = port_cwd(port) {
                        if inside(&cwd, &project) {
                            hits.push((path.clone(), format!("proxy_pass {pp} -> port {port} -> process cwd {}", cwd.display()), l.auth_basic));
                        }
                    }
                }
            }
        }
        // The shortest matching path is the app's mount point.
        hits.sort_by_key(|h| h.0.len());
        if let Some((path, how, auth)) = hits.into_iter().next() {
            let scheme = if s.ssl || s.ports.contains(&443) { "https" } else { "http" };
            let port = s.ports.iter().find(|p| **p != 80 && **p != 443).map(|p| format!(":{p}")).unwrap_or_default();
            let port = if scheme == "https" && s.ports.contains(&443) { String::new() } else { port };
            let mount = path.trim_end_matches('/');
            out.push(Match { url: format!("{scheme}://{name}{port}{mount}"), server_name: name, file: s.file.clone(), how, auth_basic: auth });
        }
    }
    out.sort_by_key(|m| (!m.url.starts_with("https"), m.url.clone()));
    // One entry per server name (the https block wins over the http one).
    let mut seen = std::collections::BTreeSet::new();
    out.retain(|m| seen.insert(m.server_name.clone()));
    out
}

/// Resolve `auto`: one match (or the one named by `server_name`), else an explanatory error.
pub fn detect(project: &Path, server_name: Option<&str>) -> Result<Match, String> {
    let dir = std::env::var("E2E_NGINX_DIR").map(PathBuf::from).unwrap_or_else(|_| PathBuf::from("/etc/nginx/sites-enabled"));
    let parsed = parse_dir(&dir);
    let mut note = String::new();
    if !parsed.unreadable.is_empty() {
        note = format!("\n(not readable, so not considered: {})", parsed.unreadable.join("; "));
    }
    if let Some(name) = server_name {
        // A named vhost: its URL and auth, whatever it points at.
        let mut cands: Vec<&Server> = parsed.servers.iter().filter(|s| s.names.iter().any(|n| n == name)).collect();
        cands.sort_by_key(|s| !s.ssl);
        let s = cands.first().ok_or_else(|| format!("no nginx server block has server_name {name} in {}{note}", dir.display()))?;
        let scheme = if s.ssl { "https" } else { "http" };
        let auth = s.auth_basic || s.locations.iter().any(|l| l.path == "/" && l.auth_basic);
        return Ok(Match { url: format!("{scheme}://{name}"), server_name: name.into(), file: s.file.clone(), how: "server_name".into(), auth_basic: auth });
    }
    let ms = find(&parsed, project, &port_cwd);
    match ms.len() {
        1 => Ok(ms.into_iter().next().unwrap()),
        0 => Err(format!(
            "no nginx vhost in {} serves {} (no root inside it, and no proxied local port whose process runs from it). Set base_url, or server_name, in e2e.yaml{note}",
            dir.display(),
            project.display()
        )),
        _ => Err(format!(
            "several nginx vhosts serve {}: {}. Pick one with server_name in e2e.yaml (or --server-name){note}",
            project.display(),
            ms.iter().map(|m| m.url.clone()).collect::<Vec<_>>().join(", ")
        )),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn parsed_from(text: &str) -> Parsed {
        let mut p = Parsed::default();
        let toks = tokenize(text);
        let mut i = 0;
        let nodes = parse_block(&toks, &mut i);
        let nodes = expand(nodes, Path::new("/nonexistent"), &mut p, 0);
        collect(&nodes, Path::new("/x.conf"), &mut p);
        p
    }

    #[test]
    fn proxy_to_project_port_with_auth() {
        let p = parsed_from(
            r#"server { listen 80; server_name app.example.com; location / { auth_basic "x"; proxy_pass http://127.0.0.1:4317; } }
               server { listen 443 ssl; server_name app.example.com; auth_basic "gate"; location / { proxy_pass http://127.0.0.1:4317; } location /.well-known/ { root /var/www/certbot; } }
               server { listen 443 ssl; server_name other.example.com; location / { proxy_pass http://127.0.0.1:9999; } }"#,
        );
        let tmp = std::env::temp_dir();
        let ms = find(&p, &tmp, &|port| if port == 4317 { Some(tmp.clone()) } else { None });
        assert_eq!(ms.len(), 1);
        assert_eq!(ms[0].url, "https://app.example.com");
        assert!(ms[0].auth_basic);
    }

    #[test]
    fn upstream_and_subpath_and_root() {
        let dir = std::env::temp_dir().join(format!("nginx-t-{}", std::process::id()));
        std::fs::create_dir_all(dir.join("dist")).unwrap();
        let p = parsed_from(&format!(
            r#"upstream app_up {{ server 127.0.0.1:5006; }}
               server {{ listen 443 ssl; server_name up.example.com; location /app/ {{ proxy_pass http://app_up; }} }}
               server {{ listen 80; server_name static.example.com; root {}/dist; }}"#,
            dir.display()
        ));
        let d2 = dir.clone();
        let ms = find(&p, &dir, &move |port| if port == 5006 { Some(d2.clone()) } else { None });
        let urls: Vec<String> = ms.iter().map(|m| m.url.clone()).collect();
        assert_eq!(urls, vec!["https://up.example.com/app", "http://static.example.com"]);
        assert!(!ms[0].auth_basic);
        std::fs::remove_dir_all(dir).ok();
    }

    #[test]
    fn tokenizer_handles_quotes_and_comments() {
        let t = tokenize("auth_basic \"a b\"; # c\nlisten 443 ssl;");
        assert_eq!(t, vec!["auth_basic", "a b", ";", "listen", "443", "ssl", ";"]);
    }
}
