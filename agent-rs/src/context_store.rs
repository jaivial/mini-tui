//! The shared context of a run tree: what the orchestrator already knows, handed to the
//! subagents instead of letting each one re-discover it.
//!
//! It is the `context/` folder of a run (`<run dir>/context`, or `MINI_AGENT_CONTEXT_DIR`) with a
//! **schema and an API** instead of a social contract. Three ideas from the measured orchestration
//! run of 2026-10-07 (122,039 discovery tokens of 184,342 in six subagents, 28 files re-read that
//! the parent had already read, 3 integration failures nobody caught) drive the shape:
//!
//! - **Findings, contracts and decisions are separate documents.** `findings.md` is what the
//!   orchestrator already knows (symbols, files, lines); `contracts.md` is the integration contract
//!   with its producers and consumers; `decisions.md` is what was decided and why. A subagent reads
//!   the two documents that touch its repo and nothing else.
//! - **Scope.** `scoped()` returns only the sections tagged for the repos a child works in, so a
//!   backend child is not billed for the frontend's surface.
//! - **The store is consultable, not just readable.** `surface()` answers "who calls this symbol and
//!   which contract does it carry" in one call, replaying what was already indexed, and
//!   `contract_check()` checks mechanically that what a child says it touched really lands where
//!   `contracts.md` says it must. A reminder in the prompt is not enough: in the measured run the
//!   brief warned about the cursor invariant and the bug happened anyway.
//!
//! The handshake is the write side: `handshake()` records what a finished child learned (surface,
//! contract, surprise) so the next child and the next round of review start from it.

use std::path::{Path, PathBuf};

/// The documents the schema reserves, in the order a child should read them.
pub const FINDINGS: &str = "findings.md";
pub const CONTRACTS: &str = "contracts.md";
pub const DECISIONS: &str = "decisions.md";
/// Surface documents are per repo: `surface.<repo>.md` (`surface.backend.md`, …).
pub const SURFACE_PREFIX: &str = "surface.";
pub const SURFACE_SUFFIX: &str = ".md";

/// Default cap of one document handed to a child (`MINI_AGENT_CONTEXT_MAX` overrides).
pub const DEFAULT_CAP: usize = 8 * 1024;

/// The shared context folder of a run tree.
#[derive(Clone, Debug)]
pub struct ContextStore {
    dir: PathBuf,
}

/// One document of the store: its key (file name), the first line as a title, and its size.
#[derive(Clone, Debug, PartialEq)]
pub struct StoreDoc {
    pub key: String,
    pub head: String,
    pub bytes: usize,
}

/// A key names one file of the store: ASCII letters, digits, `.`, `_` or `-`, never a path.
/// It is the variable name too: key `findings.md` is `{{context.findings}}`.
pub fn state_key(key: &str) -> Result<String, String> {
    let k = key.trim();
    if k.is_empty()
        || k.starts_with('.')
        || !k.chars().all(|c| c.is_ascii_alphanumeric() || matches!(c, '.' | '_' | '-'))
    {
        return Err(format!(
            "state key {key:?}: letters, digits, '.', '_' or '-' (it names a file in the shared context/)"
        ));
    }
    Ok(k.to_string())
}

/// The first non-empty, non-heading line of a document: its title.
fn doc_head(body: &str) -> String {
    for line in body.lines() {
        let l = line.trim().trim_start_matches('#').trim();
        if l.is_empty() {
            continue;
        }
        return l.chars().take(80).collect();
    }
    String::new()
}

impl ContextStore {
    pub fn new(dir: impl Into<PathBuf>) -> Self {
        ContextStore { dir: dir.into() }
    }

    pub fn dir(&self) -> &Path {
        &self.dir
    }

    /// Every key in the store, sorted, with each document's title and size.
    pub fn docs(&self) -> Vec<StoreDoc> {
        let mut out = vec![];
        let Ok(rd) = std::fs::read_dir(&self.dir) else { return out };
        for e in rd.flatten() {
            let key = e.file_name().to_string_lossy().to_string();
            if key.starts_with('.') || !e.file_type().map(|t| t.is_file()).unwrap_or(false) {
                continue; // hidden: the atomic-replace temp of `put`, never a key
            }
            let body = std::fs::read_to_string(e.path()).unwrap_or_default();
            out.push(StoreDoc { key, head: doc_head(&body), bytes: e.metadata().map(|m| m.len() as usize).unwrap_or(0) });
        }
        out.sort_by(|a, b| a.key.cmp(&b.key));
        out
    }

    pub fn has(&self, key: &str) -> bool {
        self.dir.join(key).is_file()
    }

    pub fn get(&self, key: &str) -> Option<String> {
        std::fs::read_to_string(self.dir.join(key)).ok()
    }

    /// Write one document: atomic (a temp + rename, so a reader never sees half a file), creating
    /// the store if this is the first key. Never touches another key.
    pub fn put(&self, key: &str, body: &str) -> Result<String, String> {
        let key = state_key(key)?;
        std::fs::create_dir_all(&self.dir).map_err(|e| format!("{}: {e}", self.dir.display()))?;
        let tmp = self.dir.join(format!(".{key}.tmp"));
        std::fs::write(&tmp, body)
            .and_then(|_| std::fs::rename(&tmp, self.dir.join(&key)))
            .map_err(|e| format!("state put {key}: {e}"))?;
        Ok(key)
    }

    /// `head_chars` of a document: the cap one variable gets, so a huge document can never blow a
    /// child's message. The tail is dropped with a marker, never a silent truncation.
    pub fn head(&self, key: &str, cap: usize) -> String {
        self.get(key).map(|b| head_chars(&b, cap)).unwrap_or_default()
    }

    /// The `{{context.*}}` variables of the whole tree, one per document, each capped.
    pub fn vars(&self, cap: usize) -> Vec<(String, String)> {
        self.docs()
            .into_iter()
            .filter_map(|d| {
                let stem = Path::new(&d.key).file_stem()?.to_string_lossy().to_string();
                let body = self.get(&d.key)?;
                Some((format!("context.{stem}"), head_chars(&body, cap)))
            })
            .collect()
    }

    /// The scoped context of a child working in `repos`: the sections of the shared documents that
    /// name one of them, plus that repo's own `surface.<repo>.md`.
    ///
    /// A section is a heading and its body: `# …` lines start one, the lines under it belong to it
    /// until the next heading of the same or lower level. A document with no headings at all (a
    /// plain findings list) is whole-store: it is small by construction and relevant everywhere.
    /// With no `repos` named, nothing is filtered: the child gets the documents whole.
    pub fn scoped(&self, repos: &[String], cap: usize) -> String {
        let _ = cap; // the per-document cap is decided inside `scoped_keys`
        let keys = self.scoped_keys(repos);
        let mut out = String::new();
        for (name, body) in keys {
            if body.trim().is_empty() {
                continue;
            }
            out.push_str(&format!("<context name=\"{name}\">\n{}\n</context>\n\n", body.trim()));
        }
        out
    }

    /// The documents and text `scoped()` would hand over, as `(name, text)` pairs.
    pub fn scoped_keys(&self, repos: &[String]) -> Vec<(String, String)> {
        let per_doc = cap_for(repos.len());
        let mut out = vec![];
        // The reserved documents first (findings, contracts, decisions), then this child's own
        // surface, then whatever previous children returned (the handshake), then the rest.
        let mut keys: Vec<String> = vec![FINDINGS.into(), CONTRACTS.into(), DECISIONS.into()];
        for repo in repos {
            keys.push(format!("{SURFACE_PREFIX}{repo}{SURFACE_SUFFIX}"));
        }
        for d in self.docs() {
            if !keys.contains(&d.key) {
                keys.push(d.key);
            }
        }
        for key in keys {
            let Some(body) = self.get(&key) else { continue };
            let reserved = matches!(key.as_str(), FINDINGS | CONTRACTS | DECISIONS) || key.starts_with(SURFACE_PREFIX);
            // A handshake (any non-reserved key that is not this run's own findings) is a returned
            // artifact about one child: the NEXT child in the wave needs it whatever its repo, so
            // it is never filtered by repo. Reserved documents ARE filtered (that is `scoped`).
            if repos.is_empty() || !reserved {
                out.push((key, head_chars(&body, per_doc)));
                continue;
            }
            let picked = self.pick(&key, repos, &body);
            if picked.trim().is_empty() {
                // A wrong or missing repo tag must never COST the child the shared context: fall
                // back to the whole document (still capped), the same thing an untagged child gets.
                out.push((key, head_chars(&body, per_doc)));
            } else {
                out.push((key, head_chars(&picked, per_doc)));
            }
        }
        out
    }

    /// The parts of one document that name one of `repos`, or the whole document when it has no
    /// headings (a flat list belongs to the run, not to a single repo).
    fn pick(&self, key: &str, repos: &[String], body: &str) -> String {
        let (title, rest) = match body.split_once('\n') {
            Some((t, r)) => (t.to_string(), r.to_string()),
            None => (String::new(), body.to_string()),
        };
        let has_headings = rest.lines().any(|l| l.trim_start().starts_with('#'));
        if !has_headings {
            // A shared invariant or a global contract list: everyone needs it. A per-repo surface
            // is the opposite: it only ever names one repo, so it is filtered like any other.
            let flat = key.starts_with(SURFACE_PREFIX) && surface_repos(key).len() > 1;
            if flat || self.mentions(&body, repos) {
                return body.to_string();
            }
            return String::new();
        }
        let mut out = String::new();
        if self.mentions(&title, repos) {
            out.push_str(&title);
            out.push('\n');
        }
        let mut keep = false;
        for line in body.lines() {
            if line.trim_start().starts_with('#') {
                keep = self.mentions(line, repos);
                if keep {
                    out.push('\n');
                    out.push_str(line);
                    out.push('\n');
                }
                continue;
            }
            if keep {
                out.push_str(line);
                out.push('\n');
            }
        }
        out.trim().to_string()
    }

    /// Does this line name one of the repos? A repo name matches as a word, so `backend` does not
    /// match `backoffice`-backed lines by accident and `preact` matches `preactvillacarmen/…`.
    fn mentions(&self, line: &str, repos: &[String]) -> bool {
        let lower = line.to_lowercase();
        repos.iter().any(|r| {
            let r = r.to_lowercase();
            !r.is_empty() && lower.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|w| w == r || w.starts_with(&format!("{r}-")))
        })
    }
}

/// The repos a `surface.<repo>.md` belongs to (`surface.backend.md` → `backend`).
pub fn surface_repos(key: &str) -> Vec<String> {
    let Some(rest) = key.strip_prefix(SURFACE_PREFIX) else { return vec![] };
    rest.strip_suffix(SURFACE_SUFFIX)
        .map(|r| r.split(&['.', '_', '-'][..]).filter(|p| !p.is_empty()).map(String::from).collect())
        .unwrap_or_default()
}

/// The cap of one document inside a scoped context: the shared budget of one `{{context.*}}`
/// variable, so a runaway findings file cannot blow the child's assembled message.
fn cap_for(repos: usize) -> usize {
    if repos > 1 { DEFAULT_CAP / 2 } else { DEFAULT_CAP }
}

/// `head_chars` with a marker when it truncates.
pub fn head_chars(text: &str, n: usize) -> String {
    if text.chars().count() <= n {
        return text.to_string();
    }
    let cut: String = text.chars().take(n.saturating_sub(20)).collect();
    format!("{cut}\n[.. {}-of-{} chars cut; `agent state get <key>` reads it whole]", cut.chars().count(), text.chars().count())
}

// ---- surface: who calls what, and with which contract (mechanical, from what is already indexed)

/// One indexed fact: a symbol or field, the file and line it lives in, and what calls it.
#[derive(Clone, Debug, PartialEq)]
pub struct SurfaceHit {
    pub what: String,
    pub file: String,
    pub line: usize,
    pub callers: Vec<String>,
    pub contract: Vec<String>,
}

/// Every `file:line: symbol` style index line in the findings and surface documents, as hits.
/// The index is what the orchestrator's own greps already produced, stored once: `surface` replays
/// it instead of grepping the tree again.
pub fn index(body: &str) -> Vec<SurfaceHit> {
    let mut out = vec![];
    for raw in body.lines() {
        let line = raw.trim();
        if line.is_empty() || line.starts_with('#') || line.starts_with("```") {
            continue;
        }
        let Some(hit) = parse_index_line(line) else { continue };
        out.push(hit);
    }
    out
}

/// `file:line what -> callers | contract` in the shapes a human (or a model) actually writes:
/// - `internal/api/server.go:650 handleBOSpecialMenuPrincipalesToggle <- boRouter`
/// - `api/types.ts:506 special_group_menu_enabled  [contract special_group_menu_enabled]`
/// - `src/lib/types.ts:506 special_group_menu_enabled` (no callers: still an index entry)
fn parse_index_line(line: &str) -> Option<SurfaceHit> {
    // Markdown backticks quote the entry; they are never part of the data.
    let line = line.replace('`', "");
    // 1. the contract, if the entry names one: `[contract <field>]`, at the end of the line.
    let (line, contract) = match line.split_once('[') {
        Some((w, c)) if c.trim_end().ends_with(']') => (
            w.trim().to_string(),
            vec![c.trim_end().trim_end_matches(']').trim().trim_start_matches("contract").trim().to_string()],
        ),
        _ => (line.to_string(), vec![]),
    };
    // 2. the callers, after `<-`: comma-, semicolon- or space-separated names.
    let (head, callers_raw) = match line.split_once("<-") {
        Some((h, r)) => (h, Some(r)),
        None => (line.as_str(), None),
    };
    let head = head.trim();
    // 3. `file:line` must be there: that is what makes a line an index entry at all.
    let (file, rest) = match head.split_once(':') {
        Some((f, r)) if r.trim_start().chars().next().is_some_and(|c| c.is_ascii_digit()) => (f.trim(), r.trim()),
        _ => return None,
    };
    let (line_no, what) = match rest.split_once(char::is_whitespace) {
        Some((l, r)) => (l.trim().parse().ok()?, r.trim().to_string()),
        None => (rest.trim().parse().ok()?, String::new()),
    };
    if what.is_empty() {
        return None;
    }
    let callers: Vec<String> = match callers_raw {
        Some(r) => r.split([',', ';', ' ']).map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect(),
        None => vec![],
    };
    Some(SurfaceHit { what, file: file.to_string(), line: line_no, callers, contract })
}

/// `agent surface <query>`: everything the store already knows that names `query` — where it is,
/// who calls it, which contract it carries. Filtered by `repos` when given. One call, capped.
pub fn surface(store: &ContextStore, query: &str, repos: &[String], cap: usize) -> (String, usize) {
    let q = query.trim().to_lowercase();
    if q.is_empty() {
        return ("surface needs a symbol, a field or a path to look for (`agent surface ls` lists what is indexed)\n".into(), 0);
    }
    if q == "ls" || q == "list" {
        // `surface ls`: what the store has indexed, so a child can see what is answerable without
        // reading the whole findings file. The "nothing mentions X" message points here, so it has
        // to exist.
        return surface_listing(store, repos, cap);
    }
    let mut hits = vec![];
    for d in store.docs() {
        if !d.key.ends_with(SURFACE_SUFFIX) && d.key != FINDINGS {
            continue;
        }
        let Some(body) = store.get(&d.key) else { continue };
        for mut hit in index(&body) {
            if !repos.is_empty() && !store.mentions(&hit.file, repos) && !store.mentions(&format!("{} {}", hit.file, hit.what), repos) {
                continue;
            }
            let hay = format!("{} {} {} {}", hit.file.to_lowercase(), hit.what.to_lowercase(), hit.callers.join(" ").to_lowercase(), hit.contract.join(" ").to_lowercase());
            if hay.contains(&q) {
                hit.callers.retain(|c| !c.is_empty());
                hits.push((d.key.clone(), hit));
            }
        }
    }
    let n = hits.len();
    if hits.is_empty() {
        let mut out = format!("nothing in the shared context mentions {query:?}\n");
        if !repos.is_empty() {
            out.push_str(&format!("(looked in {})\n", repos.join(", ")));
        }
        out.push_str("`agent surface ls` lists what is indexed; if it is not indexed, grep it and `agent state put` the result.\n");
        return (out, 0);
    }
    let mut out = format!("{n} indexed hit(s) for {query:?}:\n");
    for (_doc, hit) in hits {
        out.push_str(&format!("  {}:{} {}", hit.file, hit.line, hit.what));
        if !hit.callers.is_empty() {
            out.push_str(&format!("   called by: {}", hit.callers.join(", ")));
        }
        if !hit.contract.is_empty() {
            out.push_str(&format!("   contract: {}", hit.contract.join(", ")));
        }
        out.push('\n');
    }
    if !repos.is_empty() {
        out.push_str(&format!("(scoped to {})\n", repos.join(", ")));
    }
    (head_chars(&out, cap), n)
}

/// `agent surface ls`: every indexed entry, grouped by document. The whole index, capped, so a
/// child knows what it can ask about without grepping and without reading findings.md whole.
fn surface_listing(store: &ContextStore, repos: &[String], cap: usize) -> (String, usize) {
    let mut n = 0;
    let mut out = String::new();
    for d in store.docs() {
        if !d.key.ends_with(SURFACE_SUFFIX) && d.key != FINDINGS {
            continue;
        }
        let Some(body) = store.get(&d.key) else { continue };
        let mut rows = vec![];
        for hit in index(&body) {
            if !repos.is_empty() && !store.mentions(&hit.file, repos) && !store.mentions(&format!("{} {}", hit.file, hit.what), repos) {
                continue;
            }
            rows.push(format!("  {}:{} {}", hit.file, hit.line, hit.what));
        }
        if rows.is_empty() {
            continue;
        }
        n += rows.len();
        out.push_str(&format!("{} ({} indexed)\n{}\n", d.key, rows.len(), rows.join("\n")));
    }
    if n == 0 {
        return ("the shared context has no index yet: put one in `findings.md` as `file:line symbol <- callers`\n".into(), 0);
    }
    (head_chars(&format!("{n} indexed entr(ies); `agent surface <symbol>` answers about one:\n{out}"), cap), n)
}

// ---- contract-check: does the child's claim hold against the tree and the contract? ----------

/// One mechanical check: what it looked at, what it found, whether it passes.
#[derive(Clone, Debug, PartialEq)]
pub struct Check {
    pub name: String,
    pub ok: bool,
    pub detail: String,
}

/// The contract clauses of `contracts.md`, as (name, text). A clause is a bullet line that starts
/// with a name (`- **no nested queries**: …`, `- consumers: backend, preact`).
pub fn clauses(body: &str) -> Vec<(String, String)> {
    let mut out = vec![];
    for raw in body.lines() {
        let line = raw.trim();
        if !line.starts_with('-') && !line.starts_with('*') {
            continue;
        }
        let line = line.trim_start_matches(['-', '*']).trim();
        let (name, text) = match line.split_once(':') {
            Some((n, t)) if !n.trim().is_empty() && n.len() < 80 => (n.trim().trim_matches('*').to_string(), t.trim().to_string()),
            _ => (line.chars().take(60).collect(), line.to_string()),
        };
        if !name.is_empty() {
            out.push((name.to_lowercase(), text.to_string()));
        }
    }
    out
}

/// Every `path/with/ext` a piece of prose mentions, de-duplicated, in order.
///
/// The handshake is free text: `handleMenu (backend/handler.go:31), which registerRoutes
/// (backend/routes.go:5) binds to GET /api/menu` names three files across one sentence. A claim
/// has to be a real path or it is not a file the child touched, so anything with a `/` and an
/// extension is taken, and the line number after `:` is dropped. `src/lib/types.ts:506` and
/// `backend/routes.go` both come out as the file itself.
fn path_tokens(rest: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    // Split on whitespace and the punctuation that separates a path from a sentence.
    for raw in rest.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '`' | '"' | '\'' | '[' | ']')) {
        let tok = raw.trim().trim_matches(|c: char| matches!(c, '>' | '.' | '"' | '\'' | '`'));
        // `backend/handler.go:18` is a path AND a line: cut the line off FIRST, or the extension
        // reads as `go:18` and the token is thrown away as not-a-file.
        let tok = tok.split(':').next().unwrap_or(tok);
        if !tok.contains('/') || tok.contains("://") || tok.starts_with('/') {
            continue;
        }
        let Some(dot) = tok.rfind('.') else { continue };
        let ext = &tok[dot + 1..];
        if ext.is_empty() || !ext.chars().all(|c| c.is_ascii_alphanumeric() || c == '+') {
            continue;
        }
        if !out.contains(&tok.to_string()) {
            out.push(tok.to_string());
        }
    }
    // `handler.go:18` has no `/`, but a file at the repo root does not need one. Take it only when
    // it ends in a known source extension, so a sentence word like `tsconfig.json` still counts and
    // `nothing.` does not.
    for raw in rest.split(|c: char| c.is_whitespace() || matches!(c, ',' | ';' | '(' | ')' | '`' | '"' | '\'' | '[' | ']')) {
        let tok = raw.trim().trim_matches(|c: char| matches!(c, '>' | '.' | '"' | '\'' | '`'));
        let tok = tok.split(':').next().unwrap_or(tok);
        if tok.contains('/') {
            continue;
        }
        let Some(dot) = tok.rfind('.') else { continue };
        let ext = tok[dot + 1..].to_lowercase();
        if CODE_EXTS.contains(&ext.as_str()) {
            if !out.contains(&tok.to_string()) {
                out.push(tok.to_string());
            }
        }
    }
    out
}

/// Files the child says it touched, from its handshake.
///
/// Both shapes of the same handshake are accepted, and they have to be: the hub checks the RAW
/// answer (`surface: f.go:1 sym`) at the end of the turn, while `agent contract-check` by hand
/// reads the RECORDED document (`## surface` heading). Parsing only one of them made the by-hand
/// command silently vacuous -- zero claimed files, so the files check passes and the contract
/// check greps an empty corpus.
pub fn claimed_files(handshake: &str) -> Vec<String> {
    let mut out: Vec<String> = vec![];
    let mut in_surface = false;
    for raw in handshake.lines() {
        let line = raw.trim();
        // Recorded form: the body of the `## surface` section, until the next heading.
        if line.starts_with('#') {
            in_surface = line.trim_start_matches('#').trim().eq_ignore_ascii_case("surface");
            continue;
        }
        // Raw form: a `surface:` tag on the line.
        if is_template(line) {
            continue; // the template, copied verbatim: not a claim about a file
        }
        let rest = if let Some((_, r)) = line.split_once("surface:") {
            r
        } else if in_surface {
            line
        } else {
            continue;
        };
        // A surface line is PROSE, not a list: `backend/handler.go:18 toDisplay -> called only
        // by handleMenu (backend/handler.go:31), which registerRoutes (backend/routes.go:5) binds
        // to GET /api/menu`. Splitting on commas alone left a bogus claim named
        // `which registerRoutes (backend/routes.go`, which the file check then reported as a
        // missing file and failed the whole check. Take every path-shaped token in the line
        // instead: a claim is what the child names as a FILE, and prose mentions them all.
        for file in path_tokens(rest) {
            if is_template(&file) {
                continue;
            }
            if !out.contains(&file) {
                out.push(file);
            }
        }
    }
    out
}

/// File extensions that mark a token as a path rather than a word. Shared by `path_tokens`
/// (which decides what a handshake CLAIMS) and `is_identifier` (which decides what a contract
/// clause NAMES), so the two can never drift apart on what a source file looks like.
const CODE_EXTS: &[&str] = &[
    "go", "ts", "tsx", "js", "jsx", "mjs", "cjs", "rs", "py", "java", "kt", "rb", "php", "c", "h",
    "cc", "cpp", "hpp", "cs", "swift", "sql", "sh", "vue", "svelte", "astro", "json", "md",
    "yaml", "yml", "toml", "html", "css", "scss",
];

/// English words that look like identifiers because they are Capitalised (`There`, `Neither`,
/// `Frontend`) or long enough with a lowercase tail. A contract is prose with a few field names
/// in it, and the check needs the FIELD NAMES, not the sentences.
const PROSE_WORDS: &[&str] = &[
    "there", "these", "those", "their", "them", "then", "than", "that", "this", "what", "which",
    "when", "where", "while", "would", "could", "should", "never", "always", "every", "either",
    "neither", "both", "each", "some", "none", "with", "from", "into", "onto", "over", "under",
    "after", "before", "between", "without", "within", "about", "above", "below", "again",
    "because", "however", "therefore", "instead", "already", "another", "anything", "nothing",
    "everything", "something", "someone", "anyone", "everyone", "nobody", "cannot", "unless",
    "until", "against", "through", "during", "being", "having", "using", "given", "taken",
    "front", "backend", "frontend", "repo", "repos", "note", "notes", "wire", "field", "fields",
    "name", "names", "type", "types", "value", "values", "true", "false", "null", "none",
    "json", "http", "https", "api", "rest", "get", "post", "put", "delete", "patch", "body",
    "data", "code", "file", "files", "line", "lines", "call", "calls", "callers", "caller",
    "return", "returns", "sends", "emit", "emits", "emitted", "read", "reads",
    "carry", "carries", "require", "requires", "must", "shall", "will", "can", "may",
];

/// Does this token look like a code identifier rather than a word of the sentence?
///
/// The contracts check collects the tokens of a clause that are snake_case or CamelCase and then
/// asks whether the touched files carry any of them. English words slip through that rule:
/// `There`, `Neither` and `node_modules` are all Capitalised-or-underscored and 5+ characters,
/// so a perfectly good run was told "nothing in the touched files carries There; neither".
/// An identifier is a run of lowercase/digits with at least one `_`, OR is CamelCase with a
/// LOWER-LETTER boundary and is not a plain dictionary word.
fn is_identifier(t: &str) -> bool {
    let lower = t.to_lowercase();
    if PROSE_WORDS.contains(&lower.as_str()) {
        return false;
    }
    // `node_modules`, `group_menu_enabled`: underscore plus at least one letter.
    if t.contains('_') {
        return t.chars().any(|c| c.is_ascii_alphabetic());
    }
    // CamelCase: an uppercase followed by a lowercase INSIDE the token (`groupMenuEnabled`), which
    // is what a sentence's capitalised first word (`There`) never has. `api.ts`-style dotted
    // paths are kept when a segment looks like a file.
    let b = t.as_bytes();
    for w in b.windows(2) {
        if w[0].is_ascii_uppercase() && w[1].is_ascii_lowercase() {
            return true;
        }
    }
    // A dotted path whose last segment is a known code file extension.
    if let Some(dot) = t.rfind('.') {
        let ext = t[dot + 1..].to_ascii_lowercase();
        if CODE_EXTS.contains(&ext.as_str()) {
            return true;
        }
    }
    false
}

/// `agent contract-check --repo X`: the mechanical check at the child's turn end.
///
/// Three kinds of check, all mechanical (no model in the loop):
/// 1. **Files.** Every file the handshake claims to touch exists in the repo and is under it.
/// 2. **Contracts.** Every `field: …` / `endpoint` a contract names as produced or consumed by
///    this repo appears in the files the child touched (or in the store's surface index for it).
/// 3. **Invariants.** A `no …` clause in `contracts.md` is checked literally against the touched
///    files: the words of the invariant that are code identifiers appear in them.
pub fn contract_check(store: &ContextStore, repo: &str, handshake: &str, root: &Path, cap: usize) -> (String, Vec<Check>) {
    let mut checks = vec![];
    let files = claimed_files(handshake);
    let repos: Vec<String> = if repo.is_empty() { vec![] } else { vec![repo.to_string()] };
    let readable = |f: &str| -> Option<String> {
        let p = Path::new(f);
        let direct = if p.is_absolute() { p.to_path_buf() } else { root.join(f) };
        std::fs::read_to_string(&direct).ok().or_else(|| {
            // A path relative to a repo root inside the store (e.g. `backend/internal/...`).
            std::fs::read_to_string(root.join(f)).ok()
        })
    };
    // 1. files
    let missing: Vec<String> = files.iter().filter(|f| readable(f).is_none()).cloned().collect();
    checks.push(Check {
        name: "files".into(),
        ok: missing.is_empty(),
        detail: if files.is_empty() {
            "the handshake names no file (no `surface:` line)".into()
        } else if missing.is_empty() {
            format!("{} claimed file(s) exist: {}", files.len(), files.join(", "))
        } else {
            format!("{} claimed file(s) do not exist: {}", missing.len(), missing.join(", "))
        },
    });
    // The text of every claimed file, for the contract and invariant checks.
    let mut corpus = String::new();
    for f in &files {
        if let Some(t) = readable(f) {
            corpus.push_str(&t);
            corpus.push('\n');
        }
    }
    // The indexed surface of this repo counts as corpus too: the contract may be satisfied in a
    // file the child did not touch but that the parent already indexed.
    if let Some(body) = store.get(FINDINGS) {
        for hit in index(&body) {
            if repos.is_empty() || store.mentions(&hit.file, &repos) {
                corpus.push_str(&format!("{} {}\n", hit.file, hit.what));
            }
        }
    }
    // 2. contracts: each clause names what this repo produces or consumes.
    let contracts = store.get(CONTRACTS).unwrap_or_default();
    let myclauses: Vec<(String, String)> = clauses(&contracts)
        .into_iter()
        .filter(|(name, text)| {
            let t = format!("{name} {text}").to_lowercase();
            repos.is_empty()
                || t.split(|c: char| !c.is_ascii_alphanumeric() && c != '_').any(|w| w == repo.to_lowercase())
                || (!repos.is_empty() && text.to_lowercase().contains(&format!("{}:", repo.to_lowercase())))
        })
        .collect();
    let mut absent = vec![];
    for (name, text) in &myclauses {
        // The identifiers of the clause: snake_case, camelCase, dotted paths, quoted strings.
        let mut ids: Vec<String> = vec![];
        for tok in text.split(|c: char| !(c.is_ascii_alphanumeric() || c == '_' || c == '.')) {
            let t = tok.trim_matches('.');
            if t.len() < 5 || t.contains(' ') || t.chars().next().map(|c| c.is_ascii_digit()).unwrap_or(true) {
                continue;
            }
            if t.contains('_') || (t.chars().any(|c| c.is_ascii_uppercase()) && t.chars().any(|c| c.is_ascii_lowercase())) {
                ids.push(t.to_string());
            }
        }
        ids.retain(|t| is_identifier(t));
        if ids.is_empty() {
            // A clause written entirely in prose names no field, so there is nothing to require of
            // the touched files. Demanding it carry the word "There" is how a real run reported
            // "nothing in the touched files carries There; neither" (measured 2026-10-07).
            continue;
        }
        ids.sort();
        ids.dedup();
        let hit_any = ids.iter().any(|id| corpus.contains(id.as_str()));
        if !hit_any && !ids.is_empty() {
            absent.push(format!("{name}: nothing in the touched files carries {}", ids.join("/")));
        }
    }
    checks.push(Check {
        name: "contracts".into(),
        ok: absent.is_empty(),
        detail: if myclauses.is_empty() {
            format!("no contract clause names {repo:?} (nothing to check)")
        } else if absent.is_empty() {
            format!("{} contract clause(s) for {repo:?} are present in the touched files", myclauses.len())
        } else {
            absent.join("; ")
        },
    });
    // 3. invariants: `no <words>` clauses, checked literally.
    let mut broken = vec![];
    for (name, text) in &myclauses {
        if !name.starts_with("no ") && !name.starts_with("never ") && !text.to_lowercase().contains("must not") {
            continue;
        }
        let body = if name.starts_with("no ") || name.starts_with("never ") { name } else { name.as_str() };
        let ids: Vec<String> = body
            .split(|c: char| !(c.is_ascii_alphanumeric() || c == '_'))
            .filter(|t| t.len() >= 4 && t.chars().any(|c| c.is_ascii_uppercase() || c == '_'))
            .map(String::from)
            .collect();
        let violated: Vec<String> = ids
            .iter()
            .filter(|id| {
                // The invariant names a code identifier and the touched file does not mention it
                // at all while claiming to do the thing: report as a warning, not a failure.
                !corpus.contains(id.as_str()) && claimed_files(handshake).iter().any(|f| readable(f).is_some())
            })
            .cloned()
            .collect();
        if !violated.is_empty() {
            broken.push(format!("{name} (no {violated:?} anywhere in the touched files)"));
        }
    }
    checks.push(Check {
        name: "invariants".into(),
        ok: broken.is_empty(),
        detail: if broken.is_empty() { "no invariant of the contract is contradicted".into() } else { broken.join("; ") },
    });
    // 4. COVERAGE. The checks above can all be true about nothing at all: with no file
    //    claimed, an empty corpus satisfies every clause and no invariant can be contradicted.
    //    Measured in the browser on 2026-10-07 a child finished with 1,765 chars of perfectly
    //    good prose naming two real files, but without a `surface:` tag, so nothing was claimed
    //    and the check reported "3/3 pass" over an empty corpus - which reads exactly like
    //    "the contract holds". A green check over nothing is a silent hole, so it fails here.
    let covered = !files.is_empty() || !myclauses.is_empty();
    checks.push(Check {
        name: "coverage".into(),
        ok: covered,
        detail: if covered {
            format!("{} file(s) and {} contract clause(s) were actually examined", files.len(), myclauses.len())
        } else if handshake.trim().is_empty() {
            "NOTHING was checked: there is no handshake for this child, so this is not a pass.\n       End the child's answer with `surface:` / `contract:` / `surprise:` lines, or run\n       `agent contract-check --repo <repo> --prompt-file <the answer>`.".into()
        } else {
            "NOTHING was checked: the answer names no file (`surface: file:line sym -> who`) and\n       no clause of contracts.md names this repo, so the earlier checks passed over an\n       empty corpus. This is NOT a pass.".into()
        },
    });
    let passed = checks.iter().filter(|c| c.ok).count();
    let total = checks.len();
    let mut out = format!("contract-check {repo}: {passed}/{total} pass\n");
    for c in &checks {
        out.push_str(&format!("  [{}] {}: {}\n", if c.ok { "ok" } else { "FAIL" }, c.name, c.detail));
    }
    (head_chars(&out, cap), checks)
}

// ---- the handshake: what a finished child hands back ---------------------------------------

/// The block every child gets, and the block the hub appends when its turn ends. Three questions,
/// nothing else: what it touched and who calls it, what contract field it emitted or read, and
/// whether reality contradicted the brief.
pub fn handshake_block(dir: &Path) -> String {
    // Measured in the browser on 2026-10-07: with the angle-bracket placeholders, a subagent
    // copied `<file:line symbol -> who calls it now>` VERBATIM into its surface line, and the
    // contract check then failed on a file named `<file`. A literal example beats a placeholder
    // here: the check is mechanical, so one copied token of prose is a false claim.
    format!(
        "Before your final answer, write these three lines (they are how the work is handed to\
         the next subagent; the hub stores them as {}/<your-name>.md):\n\
         surface: file.ts:12 someSymbol -> who calls it\n\
         contract: some_json_field -> who consumes it\n\
         surprise: what did not match what you were told, or the word none\n\
         Replace EVERY part with something real: file, symbol, caller. A line left as written here\
         is a false claim and `contract-check` will fail it.",
        dir.display()
    )
}

/// Parse a handshake answer into its three fields.
pub fn parse_handshake(text: &str) -> (Vec<String>, Vec<String>, Vec<String>) {
    let mut surface = vec![];
    let mut contract = vec![];
    let mut surprise = vec![];
    for raw in text.lines() {
        let line = raw.trim();
        if let Some(rest) = strip_tag(line, "surface") {
            surface.extend(split_items(rest));
        } else if let Some(rest) = strip_tag(line, "contract") {
            contract.extend(split_items(rest));
        } else if let Some(rest) = strip_tag(line, "surprise") {
            surprise.extend(split_items(rest));
        }
    }
    (surface, contract, surprise)
}

fn strip_tag<'a>(line: &'a str, tag: &str) -> Option<&'a str> {
    let lower = line.to_lowercase();
    let i = lower.find(&format!("{tag}:"))?;
    Some(line[i + tag.len() + 1..].trim())
}

fn split_items(rest: &str) -> Vec<String> {
    rest.split(['\n', ';'])
        .map(|s| s.trim().trim_start_matches('-').trim().to_string())
        .filter(|s| !s.is_empty() && s != "none")
        .filter(|s| !is_template(s))
        .collect()
}

/// Any stored document that reads as a handshake touching `repo`.
///
/// `agent contract-check --repo R` with no `--name` used to look only for `<child>.md`, the key the
/// hub stores a parsed handshake under. A child that wrote its own handoff instead (measured in
/// the browser: `agent state put backend-handler.md`, a perfectly good one) was therefore
/// invisible to the check, which then passed over nothing. This walks the store for a document
/// that names a file of that repo, newest schema first, so the check sees the claim that exists.
pub fn any_handshake(store: &ContextStore, repo: &str) -> Option<String> {
    let want = repo.to_lowercase();
    let mut best: Option<String> = None;
    let mut best_score: usize = 0;
    for d in store.docs() {
        // The orchestrator's own documents describe the repos too; a handshake is the child's own
        // account of what it touched, so skip the reserved schema keys.
        if matches!(d.key.as_str(), FINDINGS | CONTRACTS | DECISIONS) || d.key.starts_with(SURFACE_PREFIX) {
            continue;
        }
        let Some(body) = store.get(&d.key) else { continue };
        let files = claimed_files(&body);
        if files.is_empty() {
            continue;
        }
        // A repo-less check accepts the first real handshake; a named one only accepts a handshake
        // that mentions its repo, so `--repo frontend` never checks the backend child's claim.
        let mentions = want.is_empty()
            || files.iter().any(|f| f.to_lowercase().contains(&want))
            || body.to_lowercase().contains(&want);
        if !mentions {
            continue;
        }
        // Prefer the most specific document: one that names a file of the repo beats a general
        // one. `best_score` avoids re-parsing the incumbent on every candidate. With no repo to
        // narrow by there is nothing to be more specific ABOUT, so the first real handshake stands.
        let score = if want.is_empty() {
            1
        } else {
            files.iter().filter(|f| f.to_lowercase().contains(&want)).count()
        };
        if score > best_score {
            best_score = score;
            best = Some(body);
        }
    }
    best
}

/// Is this line the handshake TEMPLATE rather than an answer? The tell is a bracketed
/// placeholder with nothing concrete in it: `<file:line symbol -> who calls it now>`.
/// Measured in the browser: a child copied that line verbatim and the contract check failed on
/// a file named `<file`. Storing it hands the NEXT child a false claim. A real line can contain
/// `<-` (`handler.go:9 handleToggle <- server`), so the rule is a bracket that starts the item.
fn is_template(line: &str) -> bool {
    let l = line.trim_start_matches(['-', '*', ' ']).trim();
    // Wholly bracketed: `<file:line symbol -> who calls it now>` starts with `<` and ends with
    // `>`. A real answer names a concrete thing (`a.go:2 handleToggle <- server`) and never looks
    // like that, so this is a safe rule that does not need to guess at the inside.
    (l.starts_with('<') && l.ends_with('>'))
        // Or it opens with a bracket and never closes one, which is a half-copied template.
        || (l.starts_with('<') && !l.contains('>'))
}

/// Record a child's handshake in the store (`<name>.md`), stamped, and return the key. The next
/// child and the next review round read it as `{{context.<name>}}` and in their scoped context.
pub fn record_handshake(store: &ContextStore, name: &str, answer: &str) -> Result<String, String> {
    let (surface, contract, surprise) = parse_handshake(answer);
    let mut body = format!("# handshake: {name}\n\nby: {name}\nat: {}\n\n", crate::util::now_iso());
    body.push_str("## surface\n");
    body.push_str(&if surface.is_empty() { "(the child named nothing it touched)\n".to_string() } else { format!("{}\n", surface.join("\n")) });
    body.push_str("\n## contract\n");
    body.push_str(&if contract.is_empty() { "(no contract field emitted or read)\n".to_string() } else { format!("{}\n", contract.join("\n")) });
    body.push_str("\n## surprise\n");
    body.push_str(&if surprise.is_empty() { "none\n".to_string() } else { format!("{}\n", surprise.join("\n")) });
    store.put(&format!("{name}.md"), &body)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store_in(dir: &str) -> ContextStore {
        let s = ContextStore::new(dir);
        let _ = std::fs::remove_dir_all(dir);
        std::fs::create_dir_all(dir).unwrap();
        s
    }

    #[test]
    fn put_is_atomic_and_one_key_at_a_time() {
        let s = store_in("/tmp/ctx-store-put-test");
        s.put("findings.md", "a\n").unwrap();
        s.put("contracts.md", "b\n").unwrap();
        s.put("findings.md", "c\n").unwrap();
        assert_eq!(s.get("findings.md").unwrap(), "c\n");
        assert_eq!(s.get("contracts.md").unwrap(), "b\n");
        assert!(s.put("../escape", "x").is_err());
        assert!(s.put(".hidden", "x").is_err());
        assert_eq!(s.docs().len(), 2);
        assert_eq!(s.docs()[0].key, "contracts.md");
    }

    #[test]
    fn scoped_gives_a_child_only_its_repo() {
        let s = store_in("/tmp/ctx-store-scope-test");
        s.put(
            "findings.md",
            "# root cause\nshared line\n\n# backend\n`group_menus_party_size.go:21 handleGetValidMenusForPartySize <- boRouter`\n\n# preact\n`src/lib/types.ts:506 GroupMenuDisplay <- Reservas.tsx`\n",
        )
        .unwrap();
        s.put("surface.backend.md", "# backend callers\n`internal/api/server.go:650 handleToggle <- server`\n").unwrap();
        let out = s.scoped(&["backend".to_string()], 32 * 1024);
        assert!(out.contains("handleGetValidMenusForPartySize"), "{out}");
        assert!(!out.contains("GroupMenuDisplay"), "{out}");
        assert!(out.contains("surface.backend.md"), "{out}");
        // Both repos named: both sections.
        let both = s.scoped(&["backend".to_string(), "preact".to_string()], 32 * 1024);
        assert!(both.contains("GroupMenuDisplay"), "{both}");
        assert!(both.contains("handleGetValidMenusForPartySize"), "{both}");
    }

    #[test]
    fn surface_replays_the_index() {
        let s = store_in("/tmp/ctx-store-surface-test");
        s.put("findings.md", "# x\n`internal/api/server.go:650 handleToggle <- server boRouter` [contract special_group_menu_enabled]\nnoise line\n").unwrap();
        let (out, n) = surface(&s, "handleToggle", &[], 4000);
        assert_eq!(n, 1, "{out}");
        assert!(out.contains("internal/api/server.go:650"), "{out}");
        assert!(out.contains("called by: server, boRouter"), "{out}");
        assert!(out.contains("contract: special_group_menu_enabled"), "{out}");
        let (none, n2) = surface(&s, "not_there", &[], 4000);
        assert_eq!(n2, 0);
        assert!(none.contains("nothing in the shared context"), "{none}");
    }

    #[test]
    fn contract_check_catches_a_missing_field() {
        let s = store_in("/tmp/ctx-store-check-test");
        s.put("contracts.md", "- preact: consumes `group_menu_display` from the backend\n").unwrap();
        let root = Path::new("/tmp/ctx-store-check-test/repo");
        std::fs::create_dir_all(root).unwrap();
        std::fs::write(root.join("Reservas.tsx"), "const x = 1;\n").unwrap();
        let hs = "surface: Reservas.tsx:1 x -> App.tsx\n";
        let (out, checks) = contract_check(&s, "preact", hs, root, 4000);
        let contracts = checks.iter().find(|c| c.name == "contracts").unwrap();
        assert!(!contracts.ok, "{out}");
        // Now the file has it.
        std::fs::write(root.join("Reservas.tsx"), "const x = {group_menu_display: 1};\n").unwrap();
        let (_, checks2) = contract_check(&s, "preact", hs, root, 4000);
        assert!(checks2.iter().find(|c| c.name == "contracts").unwrap().ok);
    }

    #[test]
    fn the_handshake_round_trips() {
        let s = store_in("/tmp/ctx-store-hs-test");
        let key = record_handshake(
            &s,
            "be-special-group",
            "surface: internal/api/group_menus_party_size.go:21 handleGetValidMenusForPartySize <- boRouter\ncontract: special_group_menu_enabled -> preact GroupMenuDisplay\nsurprise: the cursor closes before the loop",
        )
        .unwrap();
        assert_eq!(key, "be-special-group.md");
        let body = s.get(&key).unwrap();
        assert!(body.contains("## surface") && body.contains("handleGetValidMenusForPartySize"), "{body}");
        assert!(body.contains("## contract") && body.contains("## surprise"), "{body}");
        // The next child's scoped context carries it (a handshake with no repo tags is global,
        // like any flat shared document).
        let out = s.scoped(&["backend".to_string()], 32 * 1024);
        assert!(out.contains("be-special-group.md"), "{out}");
    }

    /// Review 1 found this: the hub checks the RAW answer at the turn end, but `agent
    /// contract-check` by hand reads the RECORDED document. `claimed_files` only parsed the raw
    /// form, so the by-hand command found zero claimed files: the files check passed on nothing
    /// and the contract check searched an empty corpus. Both shapes must parse.
    #[test]
    fn claimed_files_reads_the_raw_and_the_recorded_handshake() {
        let s = store_in("/tmp/ctx-store-cf-test");
        let answer = "surface: backend/handler.go:2 handleToggle <- server, api/router.go:9 go\ncontract: none\nsurprise: none";
        assert_eq!(claimed_files(answer), vec!["backend/handler.go", "api/router.go"]);
        let key = record_handshake(&s, "be-worker", answer).unwrap();
        let recorded = s.get(&key).unwrap();
        assert_eq!(
            claimed_files(&recorded),
            vec!["backend/handler.go", "api/router.go"],
            "the recorded handshake must yield the same files as the raw answer: {recorded}"
        );
        // It must not bleed into the other sections of the recorded document.
        assert!(!claimed_files(&recorded).iter().any(|f| f.contains("be-worker")), "{recorded}");
    }

    /// `agent surface ls` is what the "nothing mentions X" message tells the child to run; it did
    /// not exist and `ls` was treated as the query.
    #[test]
    fn surface_ls_lists_the_index() {
        let s = store_in("/tmp/ctx-store-ls-test");
        assert!(surface(&s, "ls", &[], 4000).0.contains("no index yet"), "an empty store says so");
        s.put(
            "findings.md",
            "# backend\n`internal/api/server.go:650 handleToggle <- server`\n`internal/api/x.go:3 other`\n",
        )
        .unwrap();
        let (out, n) = surface(&s, "ls", &[], 4000);
        assert_eq!(n, 2, "{out}");
        assert!(out.contains("internal/api/server.go:650") && out.contains("internal/api/x.go:3"), "{out}");
        assert!(out.contains("agent surface <symbol>"), "{out}");
    }

    /// Measured in the browser: a child copied the angle-bracket placeholder of the handshake
    /// template verbatim into its surface line. It must not be stored as a claim (it would be
    /// handed to the next child as one) and it must not be checked as a file named `<file`.
    #[test]
    fn a_handshake_line_left_as_the_template_is_not_a_claim() {
        let s = store_in("/tmp/ctx-store-tmpl-test");
        let answer = "surface: <file:line symbol -> who calls it now>\ncontract: <field/endpoint you emitted>\nsurprise: <something, or 'none'>";
        let (surface, contract, surprise) = parse_handshake(answer);
        assert!(surface.is_empty() && contract.is_empty() && surprise.is_empty(), "{surface:?} {contract:?} {surprise:?}");
        assert!(claimed_files(answer).is_empty(), "{:?}", claimed_files(answer));
        // And the real thing is still parsed.
        let real = "surface: a.go:2 handleToggle <- server\ncontract: group_menu_enabled -> Reservas.tsx\nsurprise: none";
        assert_eq!(claimed_files(real), vec!["a.go"]);
        // The template itself shows a filled-in example, never angle brackets.
        let block = handshake_block(Path::new("/tmp/x"));
        assert!(!block.contains("<file"), "{block}");
        assert!(block.contains("file.ts:12 someSymbol"), "{block}");
    }
}
