//! `shard --hybrid` (alias `orchestrate`): the shard hub with the clones' context inheritance.
//!
//! speed7 measured both halves: shard (plain-code hub, one executor per file, hedged, gate + fix
//! waves) won on wall time; clones (every executor a copy of the parent's session) sent the fewest
//! uncached tokens but paid a serial planning call (6-25 s). The hybrid keeps what won on each side:
//!
//!   1. the hub is plain code: it lists the repo, scopes the targets (`shard::scope`) and builds the
//!      parent session ONCE = [system, user: the repo as read + the task]. That session is the
//!      parent's investigation; it is not rebuilt per executor;
//!   2. no planning call when the task spells the contract (identifiers, signatures, JSON tags,
//!      quoted texts): the task is the plan. Otherwise ONE parent call writes the contract and it
//!      joins the session as the parent's own message, so every clone inherits it;
//!   3. every executor is a clone of that session (its messages byte for byte) plus one system
//!      message: "execute only the order for YOUR FILE". The repo travels as the session's shared
//!      prefix, identical across clones, so the provider's prompt cache serves it; only the last
//!      message differs. One clone per target file, all at once, hedged; a wave larger than two
//!      rounds of `--max-inflight` gets one clone per run of adjacent files instead (`units`);
//!   4. gofmt + the gate + fix waves are shard's, unchanged (shard::client).
use crate::shard::{brief, dump, hedged, parse_answer, parse_group, query_text, record, subjects, tokens, Ctx, Lat, Slots};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

const PARENT_SYSTEM: &str = "You are the lead engineer of a coding session. You have read the repository below and the task. \
Executors that are copies of this session apply the change in parallel, one file each.";

fn session_prompt(repo: &str, task: &str) -> String {
    format!("Repository (every tracked file, current content):\n{repo}\n\nTASK:\n{task}")
}

/// The task already is the contract when it spells identifiers or literal shapes: a code span,
/// a JSON/struct brace, or a quoted string. Then a planning call only adds serial time.
pub(crate) fn spells_contract(task: &str) -> bool {
    task.contains('`') || task.contains('{') || task.contains('"')
}

const CONTRACT_ASK: &str = "Before the executors start, write the shared contract of this change in a few lines: every new or changed \
identifier, signature, JSON tag, route, status code and user-visible text, exactly as all files must use it, and which files change. \
No code, no preamble. Plain text; do not call any tool.";

fn clone_order(files: &[String], extra: &str, edits: bool) -> String {
    let (who, how) = if let [f] = files {
        let shape = if edits {
            format!("Otherwise answer with EDITS ONLY: one or more blocks\n{SEARCH}\n<exact current lines of {f}, enough to be unique>\n{SEP}\n<the new lines>\n{REPLACE}\nand nothing else (no code fences, no commentary).")
        } else {
            format!("Otherwise answer with the line <<<FILE, then the COMPLETE new content of {f}, then the line FILE>>>, and nothing else (no code fences around it).")
        };
        (format!("YOUR FILE: {f}"), format!("If the task requires no change to {f}, answer exactly UNCHANGED. {shape}"))
    } else {
        (
            format!("YOUR FILES ({}): {}", files.len(), files.join(", ")),
            "Decide EACH file on its own: find every instruction of the task that applies to that file's path or layer (Go struct/handler, TS type, component, docs) and apply them all. For EACH of your files, in this order, answer either the line `UNCHANGED <path>` (only when no instruction of the task applies to it) or the line `<<<FILE <path>`, then the COMPLETE new content of that file, then the line FILE>>>. Nothing else (no code fences around the content).".to_string(),
        )
    };
    format!(
        "You are now a CLONE of the session above, in executor mode: the repository and the task are above, already read; do not investigate, \
         plan or review. Other clones apply the same task to the other files at the same time, so use exactly the names \
         (built literally from the task's patterns: <E>s means the name + s, never a corrected plural), signatures, JSON tags and props the task \
         gives, and rely on the other files being updated as the task requires. Keep the existing wire contract. Change a file only if the task \
         explicitly requires it; never carry a change over by analogy to entities, files or functions the task does not name. Add nothing the \
         task does not ask for. Before answering, check that EVERY requirement the task states for your files holds, in the task's exact terms \
         (names, status codes, phrases; for docs: every case the task lists). No tests, no tool calls.\n{who}\n{extra}{how}"
    )
}

const SEARCH: &str = "<<<<<<< SEARCH";
const SEP: &str = "=======";
const REPLACE: &str = ">>>>>>> REPLACE";

/// The first call of a one-file clone answers SEARCH/REPLACE edits instead of the whole file;
/// its hedge twins answer the whole file. Measured on Zai glm-5.3-flash (speed8, 4 calls each,
/// same prompt): xl t14 voucher.go, whole file 10.2-10.6 s / 360 tokens out vs edits 5.3-6.4 s /
/// 37-55 tokens, 4/4 applied; m5 t13 menu.go edits 6.7-8.3 s, 4/4 applied; het t08 voucher.go
/// (a rewrite of the handler) edits 10.6-15.2 s, 1 of 4 did not apply. Output length is the
/// clone's latency on small edits of mid-size files; a rewrite gains nothing, and an edit that does
/// not apply is an error the hedge answers with a whole-file twin.
const EDITS_ABOVE: u64 = 600;

/// `answer`'s SEARCH/REPLACE blocks applied to `old`: every SEARCH must match once, exactly or
/// with runs of spaces/tabs collapsed (the model realigns struct fields). `None` = UNCHANGED.
fn apply_edits(old: &str, answer: &str) -> Result<Option<String>, String> {
    let t = answer.trim();
    if !t.contains(SEARCH) {
        return if t.contains("UNCHANGED") { Ok(None) } else { Err(format!("no edit blocks: {:?}", t.chars().take(120).collect::<String>())) };
    }
    let re = regex::Regex::new(&format!(r"(?s){}\n(.*?)\n?{}\n(.*?)\n?{}", regex::escape(SEARCH), regex::escape(SEP), regex::escape(REPLACE))).unwrap();
    let ws = regex::Regex::new(r"[ \t]+").unwrap();
    let mut new = old.to_string();
    let mut n = 0;
    for c in re.captures_iter(t) {
        let (find, repl) = (&c[1], &c[2]);
        if find.trim().is_empty() {
            return Err("an edit with an empty SEARCH".into());
        }
        if new.matches(find).count() == 1 {
            new = new.replacen(find, repl, 1);
        } else {
            // Whitespace-tolerant: match the lines of `find` with runs of blanks collapsed.
            let lines: Vec<&str> = new.split_inclusive('\n').collect();
            let want: Vec<String> = find.lines().map(|l| ws.replace_all(l.trim_end(), " ").to_string()).collect();
            let hits: Vec<usize> = (0..lines.len().saturating_sub(want.len() - 1))
                .filter(|&i| want.iter().enumerate().all(|(j, w)| ws.replace_all(lines[i + j].trim_end(), " ") == *w))
                .collect();
            let [i] = hits[..] else {
                return Err(format!("edit does not apply ({} matches): {:?}", hits.len(), find.chars().take(80).collect::<String>()));
            };
            let mut r = repl.to_string();
            if lines[i + want.len() - 1].ends_with('\n') {
                r.push('\n');
            }
            new = format!("{}{}{}", lines[..i].concat(), r, lines[i + want.len()..].concat());
        }
        n += 1;
    }
    if n == 0 {
        return Err("edit blocks do not parse".into());
    }
    Ok(Some(new))
}

/// The model config of call `k` of a unit. `twin_kwargs` (config) is merged into the model_kwargs
/// of hedge twins (k >= 1). GLM via Zai/Zhipu runs every clone with thinking off. Measured on
/// glm-5.3-flash (speed8): het t06, thinking on 15-48 s per file and 600-3100 tokens out (mostly
/// reasoning), off 11-18 s; xl t19 (24 subject-pair clones, 8 in flight), on: 500-960 reasoning
/// tokens per clone, 25-35 s each, 75 s wall. The one literal that thinking-off dropped (t08, the
/// voucher 409 body) is caught by `doubt` and re-asked.
fn call_cfg(ctx: &Ctx, k: u32) -> crate::util::Obj {
    let cfg = &ctx.model_cfg;
    let mut c = cfg.clone();
    let mut extra = crate::util::Obj::new();
    if glm(ctx.model_name.as_deref()) {
        extra.insert("thinking".into(), json!({"type": "disabled"}));
        c.insert("text_only".into(), json!("no_tools"));
    }
    if let (true, Some(Value::Object(tw))) = (k > 0, cfg.get("twin_kwargs")) {
        extra.extend(tw.clone());
    }
    if !extra.is_empty() {
        let mut kw = c.get("model_kwargs").and_then(Value::as_object).cloned().unwrap_or_default();
        kw.extend(extra);
        c.insert("model_kwargs".into(), Value::Object(kw));
    }
    c
}

/// GLM on Zai / Zhipu: `thinking: {type: disabled}` is how its API turns reasoning off.
fn glm(model: Option<&str>) -> bool {
    let n = model.unwrap_or("").to_lowercase();
    (n.starts_with("zai/") || n.starts_with("zhipu/")) && n.contains("glm")
}

/// Calls in flight by default for `model`: Zai's coding plan refuses bursts above ~10 concurrent
/// requests (measured, speed8: 12 at once all OK, 16 at once 7 refused with code 1302; 8 in flight
/// sustained 40/40), so GLM there gets 8; every other provider keeps shard's 24.
pub(crate) fn default_inflight(model: Option<&str>) -> usize {
    let n = model.unwrap_or("").to_lowercase();
    if n.starts_with("zai/") || n.starts_with("zhipu/") { 8 } else { 24 }
}

/// The messages a task quotes inside a JSON shape, per Go file whose subject its sentence (or
/// bullet) names: `- VOUCHER: ... {"error":"insufficient balance"}` -> voucher.go must carry
/// "insufficient balance". Only phrases (with a space), so keys and class names are not checked.
/// Measured (speed8, het t05/t08): the voucher.go clone wrote `{"error": 0}` for that body in 3
/// of 6 runs while every other literal came through.
pub(crate) fn required(task: &str, files: &[String]) -> std::collections::HashMap<String, Vec<String>> {
    let subj = subjects(files);
    let json_lit = regex::Regex::new(r#"\{[^{}]*\}"#).unwrap();
    let phrase = regex::Regex::new(r#""\w+"\s*:\s*"([^"\n]*\s[^"\n]*)""#).unwrap();
    let segs: Vec<&str> = if task.lines().filter(|l| l.trim_start().starts_with("- ")).count() >= 2 {
        task.lines().filter(|l| l.trim_start().starts_with("- ")).collect()
    } else {
        vec![task]
    };
    let mut out: std::collections::HashMap<String, Vec<String>> = Default::default();
    for seg in segs {
        let lits: Vec<String> = json_lit.find_iter(seg).flat_map(|m| phrase.captures_iter(m.as_str()).map(|c| c[1].to_string()).collect::<Vec<_>>()).collect();
        if lits.is_empty() {
            continue;
        }
        let words = tokens(seg);
        for f in files.iter().filter(|f| f.ends_with(".go")) {
            if subj.get(f).is_some_and(|s| !s.is_empty() && !s.is_disjoint(&words)) {
                out.entry(f.clone()).or_default().extend(lits.iter().cloned());
            }
        }
    }
    out
}

/// Whether the task names the layer `file` belongs to (Go code, a TS type, a component, docs).
/// Only then is an UNCHANGED for it doubted: the hub scopes by subject, so a 12-entity task that
/// changes Go and docs only (speed8 t17) also scopes each entity's .ts/.tsx, and those rightly
/// stay as they are.
fn layer_named(task: &str, file: &str) -> bool {
    let t = task.to_lowercase();
    let stem = file.rsplit('/').next().unwrap_or(file).split('.').next().unwrap_or("").to_lowercase();
    let any = |ws: &[&str]| ws.iter().any(|w| t.contains(w));
    if file.ends_with(".go") {
        any(&[".go", "go struct", "struct", "handler", "func "])
    } else if file.ends_with(".tsx") {
        any(&["component", ".tsx", "<e>list", "renders"]) || t.contains(&stem)
    } else if file.ends_with(".ts") {
        any(&["ts:", "ts ", "interface", "types/", ".ts"])
    } else if file.ends_with(".md") {
        any(&["docs", ".md", "readme"])
    } else {
        true
    }
}

/// Plain-code check of one clone's answer for `file` (`None` = UNCHANGED). The first `CHECKED`
/// calls of a unit must pass it; later ones are accepted as they come, so a wrong guess of the
/// check never stalls a file. Returns why the answer is doubted.
fn doubt(file: &str, answer: &Option<String>, need: &[String], k: u32, layer: bool) -> Option<String> {
    match answer {
        None if k >= UNCHANGED_CHECKS => None,
        // Every target was picked because the task names its subject; an UNCHANGED for one of
        // them is confirmed by a second copy before it is taken. Measured (speed8, xl t20): a
        // grouped clone answered UNCHANGED for TableList.tsx in a 12-entity rename.
        None if !layer => None,
        None => Some(format!("a previous copy answered UNCHANGED for {file}; the hub picked {file} because the task names its subject. Re-check every instruction of the task against {file}; answer UNCHANGED only if none applies.")),
        Some(body) => {
            let miss: Vec<&String> = need.iter().filter(|l| !body.contains(l.as_str())).collect();
            (!miss.is_empty()).then(|| format!("a previous copy of {file} dropped the task's literal text {miss:?}; the task requires it verbatim in {file} (a JSON body that mixes strings and numbers needs map[string]any, not map[string]float64)."))
        }
    }
}

/// Copies of a unit whose UNCHANGED for a target is doubted. Measured (speed8, xl t18/t20): a
/// grouped clone answered UNCHANGED for a scoped List.tsx in 4 of ~30 waves, and the first
/// re-ask confirmed the wrong UNCHANGED once (t20 SupplierList); a correct UNCHANGED (s2 t01,
/// docs the task does not touch) costs two extra copies of one short answer.
const UNCHANGED_CHECKS: u32 = 2;

/// Calls of a unit whose answers must pass `doubt` (an UNCHANGED: `UNCHANGED_CHECKS`). Later calls
/// are taken as they come, so a wrong doubt never stalls a file past this many copies.
const CHECKED: u32 = 5;

/// Runs the parent session and its clones over `targets`; returns per-file stats (plus the
/// contract call's, if one ran). Files are written as their clones answer.
#[allow(clippy::too_many_arguments)]
pub(crate) fn run(ctx: &Ctx, root: &Path, files: &[String], targets: &[String], hedge: f64, inflight: usize, t0: Instant, slots: &Arc<Slots>) -> Vec<Value> {
    let mut session = vec![
        json!({"role": "system", "content": PARENT_SYSTEM}),
        json!({"role": "user", "content": session_prompt(&dump(root, files), &ctx.task)}),
    ];
    let mut stats = vec![];
    if !spells_contract(&ctx.task) {
        let s = Instant::now();
        let mut ask = session.clone();
        ask.push(json!({"role": "system", "content": CONTRACT_ASK}));
        let mut st = json!({"file": "(contract)"});
        match query_text(&ctx.model_name, &ctx.model_cfg, &ask) {
            Ok((text, usage)) => {
                session.push(json!({"role": "assistant", "content": text}));
                st["usage"] = usage;
                st["calls"] = json!(1);
            }
            Err(e) => st["error"] = json!(e),
        }
        st["call_s"] = json!((s.elapsed().as_secs_f64() * 10.0).round() / 10.0);
        st["at_s"] = json!((t0.elapsed().as_secs_f64() * 10.0).round() / 10.0);
        stats.push(st);
    }
    let session = Arc::new(session);
    let need = required(&ctx.task, files);
    let units = units(root, targets, inflight);
    let wave_n = units.len();
    let lat: Lat = Default::default();
    let handles: Vec<_> = units
        .into_iter()
        .map(|g| {
            let (c, l, sl, sess, root) = (ctx.clone(), lat.clone(), slots.clone(), session.clone(), root.to_path_buf());
            let nd: Vec<Vec<String>> = g.iter().map(|f| need.get(f).cloned().unwrap_or_default()).collect();
            std::thread::spawn(move || {
                let s = Instant::now();
                let g2 = g.clone();
                let n = std::sync::atomic::AtomicU32::new(0);
                let why = std::sync::Mutex::new(String::new());
                let call = Arc::new(move || {
                    let k = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let note = why.lock().map(|w| if w.is_empty() { String::new() } else { format!("Note: {w}\n") }).unwrap_or_default();
                    let mut msgs = (*sess).clone();
                    let old = if g2.len() == 1 { std::fs::read_to_string(root.join(&g2[0])).ok() } else { None };
                    let edits = k == 0 && old.as_ref().is_some_and(|o| o.len() as u64 > EDITS_ABOVE);
                    msgs.push(json!({"role": "system", "content": clone_order(&g2, &brief(&note, k), edits)}));
                    let (text, usage) = query_text(&c.model_name, &call_cfg(&c, k), &msgs)?;
                    // One answer shape for one file or several: {path: new content | null}.
                    let map: serde_json::Map<String, Value> = if g2.len() == 1 {
                        let a = if edits { apply_edits(old.as_deref().unwrap_or(""), &text)? } else { parse_answer(&text)? };
                        let mut m = serde_json::Map::new();
                        m.insert(g2[0].clone(), a.map_or(Value::Null, Value::String));
                        m
                    } else {
                        serde_json::from_str(&parse_group(&text, &g2)?).unwrap_or_default()
                    };
                    if k < CHECKED {
                        let doubts: Vec<String> = g2
                            .iter()
                            .zip(&nd)
                            .filter_map(|(f, need)| doubt(f, &map.get(f).and_then(Value::as_str).map(String::from), need, k, layer_named(&c.task, f)))
                            .collect();
                        if !doubts.is_empty() {
                            let w = doubts.join(" ");
                            if let Ok(mut x) = why.lock() {
                                *x = w.clone();
                            }
                            return Err(format!("doubted: {w}"));
                        }
                    }
                    Ok((Some(Value::Object(map).to_string()), usage))
                });
                let r = hedged(call, &g.join(","), hedge, &l, wave_n, &sl);
                (g, r, s.elapsed().as_secs_f64())
            })
        })
        .collect();
    for h in handles {
        let (g, r, secs) = h.join().unwrap_or_else(|_| (vec![], Err("clone panicked".into()), 0.0));
        match r {
            Ok((Some(js), usage, n)) => {
                let m: serde_json::Map<String, Value> = serde_json::from_str(&js).unwrap_or_default();
                for (k, f) in g.iter().enumerate() {
                    let new = m.get(f).and_then(Value::as_str).map(String::from);
                    // The unit's usage and call count go on its first file only.
                    let (u, c) = if k == 0 { (usage.clone(), n) } else { (Value::Null, 0) };
                    let mut st = record(root, f, Ok((new, u, c)), secs, t0);
                    if g.len() > 1 {
                        st["group"] = json!(g.len());
                    }
                    stats.push(st);
                }
            }
            other => {
                let e = match other {
                    Err(e) => e,
                    _ => "clone answered nothing".into(),
                };
                for f in &g {
                    stats.push(record(root, f, Err(e.clone()), secs, t0));
                }
            }
        }
    }
    stats
}

/// Files per run at most (see `units`).
const MAX_RUN: usize = 6;

/// The clones of a wave: one per target file while the wave fits in about two rounds of the
/// provider's request limit (`inflight`); above that, `inflight` clones that each own a run of
/// adjacent targets (path order keeps a layer together: all types/*.ts, all components), the runs
/// balanced by the files' size, so the wave is ONE round. Measured on Zai glm-5.3-flash (speed8,
/// xl t20, 48 one-file clones, 8 in flight): 6 rounds, every clone queued for a slot (median
/// 41 s from start to answer), 68 s wall for answers of 50-330 tokens. Mixed-subject pairs
/// (MenuList.tsx + menu.ts) answered UNCHANGED for the component in 5/12 calls vs 0/12 alone, so
/// a run keeps one layer where it can, and `doubt` re-asks a run with a wrong UNCHANGED.
fn units(root: &Path, targets: &[String], inflight: usize) -> Vec<Vec<String>> {
    // A run never holds more than MAX_RUN files (a 15-file run missed one file in 7 of 8 calls),
    // and there are at most two rounds of runs.
    if targets.len() <= 2 * inflight.max(1) {
        return targets.iter().map(|f| vec![f.clone()]).collect();
    }
    // An answer's length is the file's length plus a per-file overhead (markers, path, the
    // model's per-file decision): measured (speed8, xl t19), a run of 15 small docs (1.7 KB in
    // all) took 8 calls and 44 s, a run of 3 Go files (3.5 KB) 20 s. Hence the 400-byte floor.
    let size = |f: &String| std::fs::metadata(root.join(f)).map_or(0, |m| m.len()) + 400;
    let total: u64 = targets.iter().map(size).sum();
    let share = total.div_ceil(inflight as u64);
    let mut out: Vec<Vec<String>> = vec![vec![]];
    let mut acc = 0u64;
    for f in targets {
        let last = out.last_mut().unwrap();
        if !last.is_empty() && (acc + size(f) / 2 > share || last.len() >= MAX_RUN) && out.len() < 2 * inflight {
            out.push(vec![]);
            acc = 0;
        }
        out.last_mut().unwrap().push(f.clone());
        acc += size(f);
    }
    out
}
