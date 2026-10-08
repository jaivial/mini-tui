//! `orchestrate` (= `shard --coord`): an intelligent coordinator + workers that are copies of its session.
//!
//! Jaime's design (speed9):
//!   1. the COORDINATOR is the smartest model available (`--coordinator`, default
//!      cliproxy/claude-opus-5-5). Its session = [system, user: the repository as read + the task].
//!      It finds the bug / understands the refactor, decides which files change and splits the work
//!      into TASK blocks: basic orders (what to achieve and where, with the shared names), NEVER the
//!      code, so the work is not done twice. The plan streams: each block starts its workers the
//!      moment it closes;
//!   2. a WORKER is that session byte for byte (+ the plan so far) with the model swapped for the
//!      cheap one (`-m`, zai/glm-5.3-flash) and one message: "execute TASK n for YOUR FILE". It does
//!      not search the repo; its file is in the session. One worker per file (runs of files on a
//!      wave larger than the provider's request limit), hedged;
//!   3. the coordinator gets every worker's status, the gate result and the diff, and REVIEWS:
//!      it answers OK, or FIX tasks that go to new workers (at most `--fix-rounds` reviews).
use crate::shard::{dump, hedged, parse_answer, parse_group, record, sh, Answer, Ctx, Lat, Slots};
use serde_json::{json, Value};
use std::path::Path;
use std::sync::{mpsc, Arc};
use std::time::Instant;

const COORD_SYSTEM: &str = "You are the coordinator of a team of coding agents: the lead engineer. You have the whole repository below. \
You investigate, find the bug or understand the refactor, decide which files change and how, and split the work into tasks for workers. \
Workers are copies of this very session running a cheaper model: they see everything you see, and your plan. You never write the code yourself.";

const PLAN_ASK: &str = "Split the work into tasks for the workers. Write ONLY the plan, starting at once (no preamble), one block per task:
TASK <n>: <path>[, <path>, ...]
<order>
END
Rules:
- An order says WHAT to achieve in that file and WHERE (which struct/function/handler/section), with the exact names, signatures, tags, routes, status codes and texts every file must agree on. NEVER write code: no statements, no function bodies, no snippets. The worker writes the code.
- Orders are short: 1-4 lines.
- When several files get the same order up to the entity, write ONE task listing them all and write the order once with <e>/<E> standing for each file's own entity; each file gets its own worker.
- Only files that must change (a new file is fine: give its path). A file the task does not require stays out.
- Order the tasks so the ones with the most work come first.";

fn session(repo: &str, task: &str) -> Vec<Value> {
    vec![
        json!({"role": "system", "content": COORD_SYSTEM}),
        json!({"role": "user", "content": format!("Repository (every tracked file, current content):\n{repo}\n\nTASK:\n{task}\n\n{PLAN_ASK}")}),
    ]
}

fn worker_order(n: &str, files: &[String], current: &str, edits: bool, note: &str) -> String {
    let how = if let [f] = files {
        if edits {
            format!("Answer with EDITS ONLY: one or more blocks\n{S}\n<exact current lines of {f}, enough to be unique>\n{E}\n<the new lines>\n{R}\nand nothing else (no code fences, no commentary).", S = crate::hybrid::SEARCH, E = crate::hybrid::SEP, R = crate::hybrid::REPLACE)
        } else {
            format!("Answer with the line <<<FILE, then the COMPLETE new content of {f}, then the line FILE>>>, and nothing else (no code fences around it). If the order needs no change to {f}, answer exactly UNCHANGED.")
        }
    } else {
        "For EACH of your files, in this order, answer the line `<<<FILE <path>`, then the COMPLETE new content of that file, then the line FILE>>> \
         (or the line `UNCHANGED <path>` if the order needs no change to it). Nothing else (no code fences around the content)."
            .to_string()
    };
    format!(
        "You are now a WORKER: a copy of the coordinator's session above, running the plan. Execute TASK {n} for YOUR FILE{s}: {list}. \
         Do not search or plan: the repository and the plan are above{cur}. In an order, <e>/<E> stand for your file's own entity (lowercase / Capitalized, \
         names built literally: <E>s = the name + s). Other workers execute the other tasks and files at the same time; rely on them. \
         Make every requirement of the order and of the TASK for your file hold, in their exact terms. No tests, no tool calls.\n{note}{how}",
        s = if files.len() > 1 { "S" } else { "" },
        list = files.join(", "),
        cur = if current.is_empty() { "" } else { "; the CURRENT content of your file(s) is below, it supersedes the repository above" },
        note = if note.is_empty() { String::new() } else { format!("{note}\n") },
    ) + current
}

/// Finished `(n, paths, plan-so-far)` blocks of a (maybe still streaming) plan. A block ends at an
/// `END` line, at the next `TASK` header, or (`done`) at the end of the text.
fn tasks(plan: &str, files: &[String], done: bool) -> Vec<(String, Vec<String>, String)> {
    let head = regex::Regex::new(r"(?m)^[ \t*#]*(?:FIX )?TASK\s+(\w+)\s*[:.-]\s*(.+?)\s*\**\s*$").unwrap();
    let end = regex::Regex::new(r"(?m)^[ \t]*END[ \t]*$").unwrap();
    let sane = regex::Regex::new(r"^[\w.-]+(/[\w.-]+)*\.\w+$").unwrap();
    let hs: Vec<_> = head.captures_iter(plan).collect();
    let mut out = vec![];
    for (k, c) in hs.iter().enumerate() {
        let m = c.get(0).unwrap();
        let next = hs.get(k + 1).map(|n| n.get(0).unwrap().start());
        let ended = end.find_at(plan, m.end()).map(|e| e.end()).filter(|&e| next.is_none_or(|n| e <= n));
        let cut = match (ended, next) {
            (Some(e), _) => e,
            (None, Some(n)) => n,
            (None, None) if done => plan.len(),
            _ => break,
        };
        let mut paths = vec![];
        for p in c[2].split(',') {
            let p = p.trim().trim_matches(|ch: char| "`:<>\"'* ".contains(ch)).trim_start_matches("./").to_string();
            let p = files.iter().find(|f| f.ends_with(&format!("/{p}"))).cloned().unwrap_or(p);
            if sane.is_match(&p) && !p.split('/').any(|x| x == "..") && !paths.contains(&p) {
                paths.push(p);
            }
        }
        if !paths.is_empty() {
            out.push((c[1].to_string(), paths, plan[..cut].to_string()));
        }
    }
    out
}

pub(crate) struct Opts {
    pub(crate) coord: Ctx,
    pub(crate) hedge: f64,
    pub(crate) inflight: usize,
    pub(crate) verify: String,
    pub(crate) reviews: u32,
}

type WorkerResult = (Vec<String>, Result<(Option<String>, Value, u32), String>, f64, f64);

/// The workers of one task: one per file, or runs of files (`hybrid::units`) when the task alone
/// is larger than the request limit allows in about two rounds.
#[allow(clippy::too_many_arguments)]
fn spawn_task(w: &Ctx, root: &Path, msgs: Vec<Value>, n: &str, paths: &[String], fix: bool, o: &Opts, lat: &Lat, slots: &Arc<Slots>, t0: Instant) -> Vec<std::thread::JoinHandle<WorkerResult>> {
    let units = crate::hybrid::units(root, paths, o.inflight / 2);
    let msgs = Arc::new(msgs);
    units
        .into_iter()
        .map(|g| {
            let (c, l, sl, m, root, n, hedge) = (w.clone(), lat.clone(), slots.clone(), msgs.clone(), root.to_path_buf(), n.to_string(), o.hedge);
            std::thread::spawn(move || {
                let s = Instant::now();
                let g2 = g.clone();
                let k = std::sync::atomic::AtomicU32::new(0);
                let call: Arc<dyn Fn() -> Answer + Send + Sync> = Arc::new(move || {
                    let k = k.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let old: Vec<Option<String>> = g2.iter().map(|f| std::fs::read_to_string(root.join(f)).ok()).collect();
                    let edits = g2.len() == 1 && k == 0 && old[0].as_ref().is_some_and(|x| x.len() as u64 > crate::hybrid::EDITS_ABOVE);
                    // A fix worker sees its file as it is now (the session holds the original).
                    let current = if fix { g2.iter().zip(&old).map(|(f, x)| format!("\n=== {f} (current)\n{}", x.as_deref().unwrap_or("(new file)"))).collect() } else { String::new() };
                    let note = if k > 0 { "Think briefly: the order is mechanical; answer right away." } else { "" };
                    let mut msgs = (*m).clone();
                    msgs.push(json!({"role": "user", "content": worker_order(&n, &g2, &current, edits, note)}));
                    let (text, usage) = crate::shard::query_text(&c.model_name, &crate::hybrid::call_cfg(&c, k), &msgs)?;
                    let js = if g2.len() == 1 {
                        let a = if edits { crate::hybrid::apply_edits(old[0].as_deref().unwrap_or(""), &text)? } else { parse_answer(&text)? };
                        json!({g2[0].clone(): a}).to_string()
                    } else {
                        parse_group(&text, &g2)?
                    };
                    Ok((Some(js), usage))
                });
                let r = hedged(call, &g.join(","), hedge, &l, 8, &sl);
                (g, r, s.elapsed().as_secs_f64(), s.duration_since(t0).as_secs_f64())
            })
        })
        .collect()
}

fn collect(root: &Path, hs: Vec<std::thread::JoinHandle<WorkerResult>>, t0: Instant, task_of: &str, stats: &mut Vec<Value>, status: &mut Vec<String>) {
    for h in hs {
        let (g, r, secs, start) = h.join().unwrap_or_else(|_| (vec![], Err("worker panicked".into()), 0.0, 0.0));
        let start = (start * 10.0).round() / 10.0;
        match r {
            Ok((Some(js), usage, n)) => {
                let m: serde_json::Map<String, Value> = serde_json::from_str(&js).unwrap_or_default();
                for (k, f) in g.iter().enumerate() {
                    let new = m.get(f).and_then(Value::as_str).map(String::from);
                    let (u, c) = if k == 0 { (usage.clone(), n) } else { (Value::Null, 0) };
                    let mut st = record(root, f, Ok((new, u, c)), secs, t0);
                    st["task"] = json!(task_of);
                    st["start_s"] = json!(start);
                    status.push(format!("{f}: {}", if st["changed"] == json!(true) { "changed" } else { "answered UNCHANGED" }));
                    stats.push(st);
                }
            }
            other => {
                let e = match other {
                    Err(e) => e,
                    _ => "worker answered nothing".into(),
                };
                for f in &g {
                    status.push(format!("{f}: FAILED ({})", e.chars().take(200).collect::<String>()));
                    stats.push(record(root, f, Err(e.clone()), secs, t0));
                }
            }
        }
    }
}

/// One streamed coordinator call over `msgs`; every TASK block starts its workers as it closes.
/// Returns the coordinator's text, its stats line and the worker handles.
#[allow(clippy::too_many_arguments)]
fn coordinate(w: &Ctx, root: &Path, files: &[String], msgs: &[Value], fix: bool, o: &Opts, t0: Instant, slots: &Arc<Slots>, label: &str) -> (String, Value, Vec<(String, std::thread::JoinHandle<WorkerResult>)>, Vec<String>) {
    let s = Instant::now();
    let (tx, rx) = mpsc::channel::<(String, Vec<String>, String)>();
    let (c, m, fl) = (o.coord.clone(), msgs.to_vec(), files.to_vec());
    let stream = std::thread::spawn(move || {
        let mut raw = String::new();
        let mut sent = 0usize;
        let mut sink = |kind: &str, piece: &str| {
            if kind != "text" {
                return;
            }
            raw.push_str(piece);
            let ts = tasks(&crate::clones::visible(&raw), &fl, false);
            for t in ts.into_iter().skip(sent) {
                let _ = tx.send(t);
                sent += 1;
            }
        };
        let r = crate::clones::query_streamed(&c, &m, &mut sink);
        if let Ok((text, _)) = &r {
            for t in tasks(text, &fl, true).into_iter().skip(sent) {
                let _ = tx.send(t);
            }
        }
        r
    });
    let lat: Lat = Default::default();
    let (mut hs, mut dispatched, mut first) = (vec![], vec![], None);
    for (n, paths, plan) in rx {
        first.get_or_insert(s.elapsed().as_secs_f64());
        let paths: Vec<String> = paths.into_iter().filter(|p| !dispatched.contains(p)).collect();
        if paths.is_empty() {
            continue;
        }
        dispatched.extend(paths.iter().cloned());
        let mut wm = msgs.to_vec();
        wm.push(json!({"role": "assistant", "content": plan}));
        for h in spawn_task(w, root, wm, &n, &paths, fix, o, &lat, slots, t0) {
            hs.push((n.clone(), h));
        }
    }
    let mut st = json!({"file": label, "model": o.coord.model_name, "call_s": (s.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "first_task_s": first.map(|x| (x * 10.0).round() / 10.0), "at_s": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0, "calls": 1, "tasks_to": dispatched});
    let text = match stream.join().unwrap_or_else(|_| Err("coordinator panicked".into())) {
        Ok((text, usage)) => {
            st["usage"] = usage;
            st["text"] = json!(text);
            text
        }
        Err(e) => {
            eprintln!("{label}: coordinator call failed: {}", e.chars().take(400).collect::<String>());
            st["error"] = json!(e);
            String::new()
        }
    };
    (text, st, hs, dispatched)
}

fn diff(root: &Path) -> String {
    let (_, mut d) = sh(root, "git diff --no-color -U2");
    let (_, new) = sh(root, "git ls-files -o --exclude-standard");
    for f in new.lines().filter(|l| !l.is_empty()) {
        d.push_str(&format!("\nNEW FILE {f}:\n{}", std::fs::read_to_string(root.join(f)).unwrap_or_default()));
    }
    d
}

fn gofmt(root: &Path) {
    let _ = sh(root, "gofmt -w $(git ls-files -co --exclude-standard '*.go') 2>/dev/null");
}

/// The whole run: plan + workers, then gate + coordinator review rounds. Returns the stats lines,
/// the files written, whether the gate passes, and how many review rounds sent fixes.
pub(crate) fn run(w: &Ctx, root: &Path, files: &[String], o: &Opts, t0: Instant, slots: &Arc<Slots>) -> (Vec<Value>, Vec<String>, bool, u32) {
    let mut msgs = session(&dump(root, files), &w.task);
    let (plan, st, hs, mut targets) = coordinate(w, root, files, &msgs, false, o, t0, slots, "(coordinator plan)");
    let mut stats = vec![st];
    let mut status = vec![];
    for (n, h) in hs {
        collect(root, vec![h], t0, &n, &mut stats, &mut status);
    }
    msgs.push(json!({"role": "assistant", "content": plan}));
    let mut rounds = 0;
    loop {
        if files.iter().chain(&targets).any(|f| f.ends_with(".go")) {
            gofmt(root);
        }
        let (ok, err) = if o.verify.is_empty() { (true, String::new()) } else { sh(root, &o.verify) };
        if rounds >= o.reviews {
            return (stats, targets, ok, rounds);
        }
        let gate = if o.verify.is_empty() {
            "No gate command was given.".to_string()
        } else if ok {
            format!("The gate `{}` PASSES.", o.verify)
        } else {
            let tail: String = err.chars().rev().take(3000).collect::<Vec<_>>().into_iter().rev().collect();
            format!("The gate `{}` FAILS:\n{tail}", o.verify)
        };
        let review = format!(
            "REVIEW. The workers are done. Status per file:\n{}\n\n{gate}\n\nThe changes (git diff of the repository against the original above):\n{}\n\n\
             Check the gate and EVERY requirement of the TASK against these changes (names, signatures, tags, status codes, texts, every file and entity the task names, \
             nothing changed that the task excludes). Judge only against the TASK and the gate: style, extra robustness or markup you would have written differently \
             are NOT reasons to fix. If every requirement holds and the gate passes, answer exactly OK. Otherwise answer only FIX blocks for the files that \
             violate a requirement, in the same format (TASK <n>: <path>[, ...] / order / END; number them from F1); an order says what is wrong and what to achieve, \
             never the code. Workers will see each file's current content.",
            status.join("\n"),
            diff(root)
        );
        msgs.push(json!({"role": "user", "content": review}));
        let (text, st, hs, fixed) = coordinate(w, root, files, &msgs, true, o, t0, slots, "(coordinator review)");
        stats.push(st);
        msgs.push(json!({"role": "assistant", "content": text.clone()}));
        if fixed.is_empty() {
            if text.trim().is_empty() && !ok {
                rounds += 1;
                continue;
            }
            return (stats, targets, ok, rounds);
        }
        rounds += 1;
        status.clear();
        for (n, h) in hs {
            collect(root, vec![h], t0, &n, &mut stats, &mut status);
        }
        for f in fixed {
            if !targets.contains(&f) {
                targets.push(f);
            }
        }
    }
}
