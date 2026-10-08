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
//!      message differs. Executors run all at once (subject pairs above `GROUP_ABOVE`), hedged;
//!   4. gofmt + the gate + fix waves are shard's, unchanged (shard::client).
use crate::shard::{brief, dump, subjects, tokens, groups, hedged, parse_answer, parse_group, query_text, record, Ctx, Lat, Slots, GROUP_ABOVE};
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

fn clone_order(files: &[String], extra: &str) -> String {
    let (who, how) = if files.len() == 1 {
        let f = &files[0];
        (
            format!("YOUR FILE: {f}"),
            format!("If the task requires no change to {f}, answer exactly UNCHANGED. Otherwise answer with the line <<<FILE, then the COMPLETE new content of {f}, then the line FILE>>>, and nothing else (no code fences around it)."),
        )
    } else {
        (
            format!("YOUR FILES: {}", files.join(", ")),
            "Decide EACH file on its own. For each of your files, in this order, answer either the line `UNCHANGED <path>` or the line `<<<FILE <path>`, then the COMPLETE new content of that file, then the line FILE>>>. Nothing else (no code fences around the content).".to_string(),
        )
    };
    format!(
        "You are now a CLONE of the session above, in executor mode: the repository and the task are above, already read; do not investigate, \
         plan or review. Other clones apply the same task to the other files at the same time, one file each, so use exactly the names \
         (built literally from the task's patterns: <E>s means the name + s, never a corrected plural), signatures, JSON tags and props the task \
         gives, and rely on the other files being updated as the task requires. Keep the existing wire contract. Change a file only if the task \
         explicitly requires it; never carry a change over by analogy to entities, files or functions the task does not name. Add nothing the \
         task does not ask for. Before answering, check that EVERY requirement the task states for your file holds, in the task's exact terms \
         (names, status codes, phrases; for docs: every case the task lists). No tests, no tool calls.\n{who}\n{extra}{how}"
    )
}

/// Hedge twins (k >= 1) answer with the provider's thinking switched off: `twin_kwargs` from the
/// config (merged into model_kwargs), or by default on GLM via Zai/Zhipu. Measured on Zai glm-5.3-flash (speed8, het t06,
/// 4 files): thinking on, 15-48 s per file and 600-3100 tokens out, almost all reasoning;
/// thinking off, 11-18 s. Off on every call lost a literal on t08 (voucher 409 body), so the
/// first call keeps thinking and only the twins that race its tail skip it.
fn twin_cfg(ctx: &Ctx, k: u32) -> crate::util::Obj {
    let cfg = &ctx.model_cfg;
    let mut c = cfg.clone();
    if k == 0 {
        return c;
    }
    if let Some(Value::Object(tw)) = cfg.get("twin_kwargs").cloned().or_else(|| glm(ctx.model_name.as_deref()).then(|| json!({"thinking": {"type": "disabled"}}))) {
        let mut kw = c.get("model_kwargs").and_then(Value::as_object).cloned().unwrap_or_default();
        for (key, v) in tw {
            kw.insert(key, v);
        }
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

/// Plain-code check of one clone's answer for `file` (`None` = UNCHANGED). The first `CHECKED`
/// calls of a unit must pass it; later ones are accepted as they come, so a wrong guess of the
/// check never stalls a file. Returns why the answer is doubted.
fn doubt(file: &str, answer: &Option<String>, need: &[String], k: u32) -> Option<String> {
    match answer {
        None if k > 0 => None,
        // Every target was picked because the task names its subject; an UNCHANGED for one of
        // them is confirmed by a second copy before it is taken. Measured (speed8, xl t20): a
        // grouped clone answered UNCHANGED for TableList.tsx in a 12-entity rename.
        None => Some(format!("a previous copy answered UNCHANGED for {file}; the hub picked {file} because the task names its subject. Re-check every instruction of the task against {file}; answer UNCHANGED only if none applies.")),
        Some(body) => {
            let miss: Vec<&String> = need.iter().filter(|l| !body.contains(l.as_str())).collect();
            (!miss.is_empty()).then(|| format!("a previous copy of {file} dropped the task's literal text {miss:?}; the task requires it verbatim in {file} (a JSON body that mixes strings and numbers needs map[string]any, not map[string]float64)."))
        }
    }
}

/// Calls of a unit whose answers must pass `doubt` (an UNCHANGED: only the first). Later calls
/// are taken as they come, so a wrong doubt never stalls a file past this many copies.
const CHECKED: u32 = 5;

/// Runs the parent session and its clones over `targets`; returns per-file stats (plus the
/// contract call's, if one ran). Files are written as their clones answer.
pub(crate) fn run(ctx: &Ctx, root: &Path, files: &[String], targets: &[String], hedge: f64, t0: Instant, slots: &Arc<Slots>) -> Vec<Value> {
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
    let units: Vec<Vec<String>> = if targets.len() > GROUP_ABOVE { groups(targets, files) } else { targets.iter().map(|f| vec![f.clone()]).collect() };
    let wave_n = units.len();
    let lat: Lat = Default::default();
    let handles: Vec<_> = units
        .into_iter()
        .map(|g| {
            let (c, l, sl, sess) = (ctx.clone(), lat.clone(), slots.clone(), session.clone());
            let need: Vec<Vec<String>> = g.iter().map(|f| need.get(f).cloned().unwrap_or_default()).collect();
            std::thread::spawn(move || {
                let s = Instant::now();
                let g2 = g.clone();
                let n = std::sync::atomic::AtomicU32::new(0);
                let why = std::sync::Mutex::new(String::new());
                let call = Arc::new(move || {
                    let k = n.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let note = why.lock().map(|w| if w.is_empty() { String::new() } else { format!("Note: {w}\n") }).unwrap_or_default();
                    let mut msgs = (*sess).clone();
                    msgs.push(json!({"role": "system", "content": clone_order(&g2, &brief(&note, k))}));
                    let (text, usage) = query_text(&c.model_name, &twin_cfg(&c, k), &msgs)?;
                    // One answer shape for one file or a group: {path: new content | null}.
                    let map = if g2.len() == 1 {
                        let mut m = serde_json::Map::new();
                        m.insert(g2[0].clone(), parse_answer(&text)?.map_or(Value::Null, Value::String));
                        Value::Object(m).to_string()
                    } else {
                        parse_group(&text, &g2)?
                    };
                    if k < CHECKED {
                        let m: serde_json::Map<String, Value> = serde_json::from_str(&map).unwrap_or_default();
                        for (f, nd) in g2.iter().zip(&need) {
                            let a = m.get(f).and_then(Value::as_str).map(String::from);
                            if let Some(w) = doubt(f, &a, nd, k) {
                                if let Ok(mut x) = why.lock() {
                                    *x = w.clone();
                                }
                                return Err(format!("doubted: {w}"));
                            }
                        }
                    }
                    Ok((Some(map), usage))
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
                    let (u, c) = if k == 0 { (usage.clone(), n) } else { (Value::Null, 0) };
                    let mut st = record(root, f, Ok((new, u, c)), secs, t0);
                    if g.len() > 1 {
                        st["group"] = json!(g.len());
                    }
                    stats.push(st);
                }
            }
            other => {
                for f in &g {
                    let e = match &other {
                        Err(e) => e.clone(),
                        _ => "clone answered nothing".into(),
                    };
                    stats.push(record(root, f, Err(e), secs, t0));
                }
            }
        }
    }
    stats
}
