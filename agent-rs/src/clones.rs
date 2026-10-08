//! `shard --clones` (alias `orchestrate`): subagents are COPIES of the parent session.
//!
//! Jaime's design (speed7): the parent investigates once and hands out exact orders; each
//! subagent is a clone of the parent's conversation (every message, byte for byte) with one
//! extra system message that turns it into a pure executor of ONE order. The context is
//! inherited through the copy, so no per-executor prompt has to be built: the clones share the
//! parent's prefix, which the provider's prompt cache serves (measured on MiniMax: 2850 of
//! 2868 prompt tokens cached on the second identical-prefix call).
//!
//!   1. parent session = [system, user: task + the repo as read by plain code];
//!   2. ONE streamed parent call writes the plan: an `<<<ORDER path[, path]` ... `ORDER>>>` block
//!      per file (or files) that must change, with the exact names, signatures and contract;
//!   3. each block starts its clones the moment it closes: parent messages + the plan so far +
//!      "execute only the order for <path>"; a clone answers the file's full new content (hedged).
use crate::shard::{dump, hedged, parse_answer, query_text, record, Answer, Ctx, Lat, Slots};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::Arc;
use std::time::Instant;

const PARENT_SYSTEM: &str = "You are the lead engineer of a coding session. You have read the repository below. \
You do not edit files yourself: you plan the change and give exact orders to executors that will apply them in parallel.";

const OPEN: &str = "<<<ORDER";
const CLOSE: &str = "ORDER>>>";

fn parent_prompt(task: &str, repo: &str) -> String {
    format!(
        "Repository (every tracked file, current content):\n{repo}\n\nTASK:\n{task}\n\n\
         Plan the change and START WRITING ORDERS AT ONCE: no preamble, no analysis before the first block; executors start \
         on each block the moment you close it. For EVERY file that must change (existing or new), write one block:\n\
         {OPEN} <path>\n<exact order for that file: what to add/change/remove, with the exact identifiers, signatures, \
         JSON tags, props, status codes and texts to use, consistent across files>\n{CLOSE}\n\
         When several files get the SAME order up to a name (e.g. the same change for each entity), write ONE block whose header \
         lists them all, comma-separated (`{OPEN} a.go, b.go, c.go`), and write the order once with <e>/<E> standing for the \
         file's own entity: one clone per listed file applies it to its file. \
         Only files the task requires; never carry a change over by analogy to entities, files or functions the task does not name. \
         Keep the existing wire contract (snake_case JSON). For docs, tell the executor to use the task's own wording (its terms verbatim). Orders are short (a few lines) and exact; write the shared contract (names, signatures, tags) into every order that uses it; no code dumps, no tests, nothing outside the blocks. \
         Answer in plain text now; do not call any tool (you already have every file)."
    )
}

fn clone_order(file: &str) -> String {
    format!(
        "You are now a CLONE of the session above, in executor mode. Do not investigate, plan or review: the plan above is final. \
         Execute ONLY the order for {file} (a block whose header lists it; <e>/<E> = its own entity), exactly as written, against the file's current content shown above, and make sure every requirement the TASK states for {file} holds, in the TASK's exact terms (names, phrases); the other orders \
         are applied by other clones at the same time and you may rely on them. Answer with the line <<<FILE, then the COMPLETE \
         new content of {file}, then the line FILE>>>, and nothing else (no code fences, no commentary, no tool calls)."
    )
}

/// The plan text the model shows (its `<think>` blocks dropped, an unclosed one cut off).
pub(crate) fn visible(raw: &str) -> String {
    let re = regex::Regex::new(r"(?s)<think>.*?</think>").unwrap();
    let v = re.replace_all(raw, "").to_string();
    match v.find("<think>") {
        Some(i) => v[..i].to_string(),
        None => v,
    }
}

/// The finished `(path, order, plan-so-far)` blocks of a (maybe still streaming) plan. A block
/// ends at its close line, at the next OPEN, or (`done`) at the end of the text. The model does
/// not always write the markers verbatim (measured: `<<<ORDER path>` headers closed by a bare
/// `ORDER` line, and blocks closed by `>>>` alone), so any of `ORDER>>>`, `ORDER`, `>>>` on a
/// line of its own closes a block, and `<>` around the path are dropped.
fn orders(plan: &str, files: &[String], done: bool) -> Vec<(String, String, String)> {
    let close = regex::Regex::new(r"(?m)^[ \t]*(ORDER>>>|ORDER|>>>)[ \t]*$").unwrap();
    let sane = regex::Regex::new(r"^[\w.-]+(/[\w.-]+)*\.\w+$").unwrap();
    let mut out: Vec<(String, String, String)> = vec![];
    let starts: Vec<usize> = plan.match_indices(OPEN).map(|(i, _)| i).collect();
    for (k, &o) in starts.iter().enumerate() {
        let after = &plan[o + OPEN.len()..];
        let Some(nl) = after.find('\n') else { break };
        let next = starts.get(k + 1).map(|n| n - (o + OPEN.len()));
        let closed = close.find(&after[nl..]).map(|m| (nl + m.start(), nl + m.end()));
        let (end, cut) = match (closed, next) {
            (Some((c, e)), Some(n)) if c < n => (c, e),
            (_, Some(n)) => (n, n),
            (Some((c, e)), None) => (c, e),
            (None, None) if done => (after.len(), after.len()),
            (None, None) => break,
        };
        let body = after[(nl + 1).min(end)..end].trim().to_string();
        for path in after[..nl].split(',') {
            let path = path.trim().trim_matches(|c: char| "`:<>\"' ".contains(c)).trim_start_matches("./").to_string();
            // A path that is not tracked but ends a tracked one (`internal/x.go`) is that file.
            let path = files.iter().find(|f| f.ends_with(&format!("/{path}"))).cloned().unwrap_or(path);
            if sane.is_match(&path) && !path.split('/').any(|c| c == "..") && !out.iter().any(|(p, ..)| *p == path) {
                out.push((path, body.clone(), plan[..o + OPEN.len() + cut].to_string()));
            }
        }
    }
    out
}

/// What a streaming parent sends the dispatcher (tagged with its stream id).
enum Event {
    Order(usize, String, String),
    Done(usize, Result<(String, Value), String>),
}

/// One streamed parent call: every block is sent the moment it is complete.
fn stream_plan(id: usize, ctx: &Ctx, session: &[Value], files: &[String], tx: &std::sync::mpsc::Sender<Event>) {
    let mut raw = String::new();
    let mut sent = 0usize;
    let mut sink = |kind: &str, piece: &str| {
        if kind != "text" {
            return;
        }
        raw.push_str(piece);
        let os = orders(&visible(&raw), files, false);
        for (p, _, plan) in os.into_iter().skip(sent) {
            let _ = tx.send(Event::Order(id, p, plan));
            sent += 1;
        }
    };
    let r = query_streamed(ctx, session, &mut sink);
    let _ = tx.send(Event::Done(id, r));
}

pub(crate) fn query_streamed(ctx: &Ctx, session: &[Value], sink: &mut dyn FnMut(&str, &str)) -> Result<(String, Value), String> {
    let mut model = crate::models::get_model(ctx.model_name.as_deref(), &ctx.model_cfg)?;
    let msgs: Vec<Value> = session
        .iter()
        .map(|m| model.format_message(m["role"].as_str().unwrap_or("user"), m["content"].as_str().unwrap_or(""), None))
        .collect();
    let msg = match model.query(&msgs, Some(sink)).map_err(|e| format!("{}: {}", e.kind, e.message))? {
        crate::models::Reply::Message(m) => m,
        crate::models::Reply::FormatError(ms) => ms.into_iter().next().unwrap_or(Value::Null),
    };
    let usage = msg.pointer("/extra/response/usage").cloned().unwrap_or(Value::Null);
    let text = msg
        .pointer("/extra/submission")
        .and_then(Value::as_str)
        .map(String::from)
        .unwrap_or_else(|| crate::models::shapes::text_of(msg.get("content").unwrap_or(&Value::Null)));
    Ok((visible(&text), usage))
}

/// The streamed parent and the clones it spawns as its orders arrive. Returns the stats lines
/// (parent first) and the ordered files.
///
/// The parent is hedged like an executor: while no stream has produced an order, a twin parent
/// starts every `hedge` seconds (at most 3 streams; a failed stream is replaced at once). The
/// first stream that emits an order OWNS the plan: orders from the other streams are dropped, so
/// clones never mix two plans (two plans may name the shared contract differently).
pub(crate) fn run(ctx: &Ctx, root: &Path, files: &[String], hedge: f64, t0: Instant, slots: &Arc<Slots>) -> (Vec<Value>, Vec<String>) {
    let session: Arc<Vec<Value>> = Arc::new(vec![
        json!({"role": "system", "content": PARENT_SYSTEM}),
        json!({"role": "user", "content": parent_prompt(&ctx.task, &dump(root, files))}),
    ]);
    let lat: Lat = Default::default();
    let mut st = json!({"file": "(parent plan)"});
    let (mut handles, mut dispatched) = (vec![], Vec::<String>::new());
    let (tx, rx) = std::sync::mpsc::channel();
    let plan_t = Instant::now();
    let spawn = |id: usize| {
        let (c, s, f, tx) = (ctx.clone(), session.clone(), files.to_vec(), tx.clone());
        std::thread::spawn(move || stream_plan(id, &c, &s, &f, &tx));
    };
    let (mut started, mut live, mut last_start) = (1usize, 1usize, Instant::now());
    spawn(0);
    let mut owner: Option<usize> = None;
    let mut first_order_s = None;
    let mut errors = vec![];
    loop {
        let ev = if owner.is_none() && started < 3 {
            match rx.recv_timeout(std::time::Duration::from_secs_f64(hedge).saturating_sub(last_start.elapsed())) {
                Ok(ev) => ev,
                Err(_) => {
                    spawn(started);
                    started += 1;
                    live += 1;
                    last_start = Instant::now();
                    continue;
                }
            }
        } else {
            match rx.recv() {
                Ok(ev) => ev,
                Err(_) => break,
            }
        };
        match ev {
            Event::Order(id, path, plan) => {
                if *owner.get_or_insert(id) != id || dispatched.contains(&path) {
                    continue;
                }
                first_order_s.get_or_insert(plan_t.elapsed().as_secs_f64());
                dispatched.push(path.clone());
                handles.push(spawn_clone(ctx, &session, plan, path, hedge, &lat, slots));
            }
            Event::Done(id, r) => {
                live -= 1;
                match r {
                    Ok((text, usage)) if owner.is_none_or(|o| o == id) => {
                        // Blocks the stream did not close (the last one, cut at the end) go now.
                        for (path, _, plan) in orders(&text, files, true) {
                            if !dispatched.contains(&path) {
                                dispatched.push(path.clone());
                                handles.push(spawn_clone(ctx, &session, plan, path, hedge, &lat, slots));
                            }
                        }
                        st["usage"] = usage;
                        st["plan"] = json!(text);
                        if !dispatched.is_empty() {
                            break;
                        }
                        errors.push("plan has no ORDER block".to_string());
                    }
                    Ok(_) => {}
                    Err(e) => {
                        eprintln!("parent {id}: call failed: {}", e.chars().take(400).collect::<String>());
                        errors.push(e);
                    }
                }
                if owner == Some(id) {
                    break; // the owner failed mid-plan: its clones are out, nothing more will come
                }
                if live == 0 && started >= 3 {
                    break;
                }
                if owner.is_none() && started < 3 && live < 2 {
                    spawn(started);
                    started += 1;
                    live += 1;
                    last_start = Instant::now();
                }
            }
        }
    }
    if dispatched.is_empty() {
        st["error"] = json!(errors.join(" | "));
    }
    st["calls"] = json!(started);
    st["call_s"] = json!((plan_t.elapsed().as_secs_f64() * 10.0).round() / 10.0);
    st["first_order_s"] = json!(first_order_s.map(|s| (s * 10.0).round() / 10.0));
    st["at_s"] = json!((t0.elapsed().as_secs_f64() * 10.0).round() / 10.0);
    st["orders"] = json!(dispatched);
    let mut stats = vec![st];
    for h in handles {
        let (f, r, secs) = h.join().unwrap_or_else(|_| (String::new(), Err("clone panicked".into()), 0.0));
        stats.push(record(root, &f, r, secs, t0));
    }
    (stats, dispatched)
}

type CloneResult = (String, Result<(Option<String>, Value, u32), String>, f64);

/// A clone of the session: the parent's messages, its plan as far as it got, and one system
/// message that makes it a pure executor of the order for `file`. Hedged like a shard executor.
fn spawn_clone(ctx: &Ctx, session: &Arc<Vec<Value>>, plan: String, file: String, hedge: f64, lat: &Lat, slots: &Arc<Slots>) -> std::thread::JoinHandle<CloneResult> {
    let (c, l, sl) = (ctx.clone(), lat.clone(), slots.clone());
    let mut msgs = (**session).clone();
    msgs.push(json!({"role": "assistant", "content": plan}));
    msgs.push(json!({"role": "system", "content": clone_order(&file)}));
    std::thread::spawn(move || {
        let s = Instant::now();
        let call: Arc<dyn Fn() -> Answer + Send + Sync> = Arc::new(move || {
            let (text, usage) = query_text(&c.model_name, &c.model_cfg, &msgs)?;
            // A clone always rewrites its file: an UNCHANGED answer is a refusal, retry it.
            let tail = || {
                let c: Vec<char> = text.chars().collect();
                c[c.len().saturating_sub(160)..].iter().collect::<String>()
            };
            let out = usage["completion_tokens"].as_u64().unwrap_or(0);
            match parse_answer(&text).map_err(|e| format!("{e} ({out} tokens out; ends: {:?})", tail()))? {
                Some(body) => Ok((Some(body), usage)),
                None => Err("clone answered UNCHANGED to an order".into()),
            }
        });
        let r = hedged(call, &file, hedge, &l, 12, &sl);
        (file, r, s.elapsed().as_secs_f64())
    })
}
