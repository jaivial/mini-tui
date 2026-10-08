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
//!      wave larger than the provider's request limit), raced (`race`);
//!   3. the coordinator gets every worker's status, the gate result and the diff, and REVIEWS:
//!      it answers OK, or FIX tasks that go to new workers (at most `--fix-rounds` reviews).
//!
//! speed10 (techniques from the research report, each measured on the 20-task suite):
//!   - the worker model's prompt cache is warmed with the coordinator's frozen session at t=0
//!     (`warmup`): the coordinator's cache is another model's and does not carry over;
//!   - a worker's calls race in memory and the first VALID candidate wins (`race`): candidates are
//!     syntax-checked (`check`) before they can win, twins start only on a stalled call and on a
//!     spare slot, and losers are cancelled (their streams closed, freeing the provider's slot);
//!   - an edit that does not apply is asked again in the same session, for the failed files only;
//!   - deterministic Go import repair runs before the gate and the review (`repair_go_imports`).
use crate::shard::{dump, parse_answer, parse_group, record, sh, Ctx, Lat, Slots};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering::SeqCst};
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
    } else if edits {
        format!("For EACH of your files, in this order, answer the line `=== EDITS <path>` followed by one or more blocks\n{S}\n<exact current lines of that file, enough to be unique>\n{E}\n<the new lines>\n{R}\n\
         (or the line `UNCHANGED <path>` if the order needs no change to it). Nothing else (no code fences, no commentary).", S = crate::hybrid::SEARCH, E = crate::hybrid::SEP, R = crate::hybrid::REPLACE)
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
    pub(crate) verify: String,
    pub(crate) reviews: u32,
    pub(crate) warmup: bool,
}

/// Files per worker at most. A task's files share one order, so a worker takes a run of them and
/// answers edits for each: Zai's coding plan serves ~8 requests at once, and requests, not
/// tokens, were the queue. Measured (speed9 rep 3, m5 t13, 20 one-file workers, 8 in flight,
/// Zai at 7-16 s per call): 3 queued rounds, 36.7 s; the same task at 2.5 s per call took 13.3 s.
const RUN: usize = 4;

/// A task's files split into balanced runs of at most `RUN` (5 -> 3+2, 12 -> 4+4+4); a task of one
/// or two files keeps one worker per file.
fn runs(paths: &[String]) -> Vec<Vec<String>> {
    if paths.len() <= 2 {
        return paths.iter().map(|p| vec![p.clone()]).collect();
    }
    let n = paths.len().div_ceil(RUN);
    let size = paths.len().div_ceil(n);
    paths.chunks(size).map(|c| c.to_vec()).collect()
}

type WorkerResult = (Vec<String>, Result<(Option<String>, Value, u32), String>, f64, f64);

/// One worker candidate: `{path: new content | null}` as JSON, the call's usage, and why the
/// deterministic check rejected it (None = valid).
type Cand = Result<(String, Value, Option<String>), String>;

/// Calls per worker unit at most (the first one, hedge twins, and replacements of failed or
/// invalid candidates).
const MAX_CALLS: u32 = 4;
/// A twin starts when the newest call has streamed nothing for this long (no first token yet, or
/// a stalled stream), or after `TTFT_MULT` x the median first-token time seen so far, whichever is
/// larger. A call that is streaming is never hedged: a twin restarts decoding from zero, and on
/// Zai decoding is the long part (measured, speed10: 60-70 tok/s per stream, warm TTFT 1-2.5 s,
/// cold 2.4-5.5 s on a 22k-token prefix). speed9 hedged every call at 1.5 s whatever it was doing:
/// 292 calls for 131 worker units on the 20-task suite, none cancelled.
const STALL_S: f64 = 3.5;
const TTFT_MULT: f64 = 2.0;

/// Syntax check of one candidate file: `gofmt -e` for Go, `bun build --no-bundle` for TS/JS (when
/// bun is installed), a JSON parse for .json. Some(error) = invalid. ~1-10 ms per file.
fn check(path: &str, content: &str) -> Option<String> {
    use std::io::Write;
    use std::process::{Command, Stdio};
    let ext = path.rsplit('.').next().unwrap_or("");
    let run = |mut c: Command, input: Option<&str>| -> Option<String> {
        let mut ch = c.stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::piped()).spawn().ok()?;
        if let (Some(i), Some(mut si)) = (input, ch.stdin.take()) {
            let _ = si.write_all(i.as_bytes());
        }
        let o = ch.wait_with_output().ok()?;
        (!o.status.success()).then(|| String::from_utf8_lossy(&o.stderr).chars().take(400).collect())
    };
    match ext {
        "go" => {
            let mut c = Command::new("gofmt");
            c.arg("-e");
            run(c, Some(content))
        }
        "ts" | "tsx" | "js" | "jsx" => {
            static BUN: std::sync::OnceLock<Option<String>> = std::sync::OnceLock::new();
            let bun = BUN.get_or_init(|| {
                let home = std::env::var("HOME").unwrap_or_default();
                ["bun".to_string(), format!("{home}/.bun/bin/bun")]
                    .into_iter()
                    .find(|b| Command::new(b).arg("--version").stdout(Stdio::null()).stderr(Stdio::null()).status().is_ok_and(|s| s.success()))
            });
            let bun = bun.as_ref()?;
            static N: AtomicU64 = AtomicU64::new(0);
            let dir = std::env::temp_dir().join(format!("orch-check-{}-{}", std::process::id(), N.fetch_add(1, SeqCst)));
            std::fs::create_dir_all(&dir).ok()?;
            let f = dir.join(format!("c.{ext}"));
            std::fs::write(&f, content).ok()?;
            let mut c = Command::new(bun);
            c.args(["build", "--no-bundle"]).arg(&f);
            let r = run(c, None);
            let _ = std::fs::remove_dir_all(&dir);
            r
        }
        "json" => serde_json::from_str::<Value>(content).err().map(|e| e.to_string()),
        _ => None,
    }
}

/// `check` over every file of a candidate (`{path: content | null}`).
fn check_all(js: &str) -> Option<String> {
    let m: serde_json::Map<String, Value> = serde_json::from_str(js).unwrap_or_default();
    let errs: Vec<String> = m.iter().filter_map(|(f, c)| c.as_str().and_then(|c| check(f, c)).map(|e| format!("{f}: {e}"))).collect();
    (!errs.is_empty()).then(|| errs.join(" | "))
}

/// A worker unit's calls: the first VALID candidate wins (not the first one back), every other
/// call is cancelled at once (its stream is dropped, which frees the provider's slot: measured on
/// Zai, speed10). Twins start only on a stalled newest call (see `STALL_S`) and only on a spare
/// slot (none while a first call waits). A failed or invalid candidate is replaced. If every call
/// came back invalid, the first invalid candidate is used (the gate and the review see it).
/// `ttft` collects first-token times of this run.
fn race(call: Arc<dyn Fn() -> Cand + Send + Sync>, label: &str, slots: &Arc<Slots>, ttft: &Lat) -> Result<(Option<String>, Value, u32), String> {
    struct Live {
        cancel: Arc<AtomicBool>,
        progress: Arc<AtomicU64>,
        start: u64,
        first: bool,
    }
    let (tx, rx) = mpsc::channel::<(usize, Cand)>();
    let mut live: Vec<Option<Live>> = vec![];
    let start = |id: usize, live: &mut Vec<Option<Live>>| {
        let (c, sl, tx) = (call.clone(), slots.clone(), tx.clone());
        let (cancel, progress) = (Arc::new(AtomicBool::new(false)), Arc::new(AtomicU64::new(0)));
        let (cc, pp) = (cancel.clone(), progress.clone());
        std::thread::spawn(move || {
            crate::models::http::CANCEL.with(|x| *x.borrow_mut() = Some(cc));
            crate::models::http::PROGRESS.with(|x| *x.borrow_mut() = Some(pp));
            let r = c();
            sl.release();
            let _ = tx.send((id, r));
        });
        live.push(Some(Live { cancel, progress, start: crate::models::http::epoch_ms(), first: false }));
    };
    slots.acquire();
    start(0, &mut live);
    let (mut started, mut usages, mut fallback, mut last_err) = (1u32, vec![], None::<(String, Value)>, String::new());
    let finish = |live: &[Option<Live>]| {
        for l in live.iter().flatten() {
            l.cancel.store(true, SeqCst);
        }
    };
    loop {
        match rx.recv_timeout(std::time::Duration::from_millis(100)) {
            Ok((id, r)) => {
                live[id] = None;
                match r {
                    Ok((js, u, None)) => {
                        finish(&live);
                        let cancelled = live.iter().flatten().count();
                        let mut u = u;
                        if !usages.is_empty() || cancelled > 0 {
                            u["twins_back"] = json!(usages);
                            u["twins_cancelled"] = json!(cancelled);
                        }
                        return Ok((Some(js), u, started));
                    }
                    Ok((js, u, Some(bad))) => {
                        eprintln!("{label}: candidate rejected by the check: {}", bad.chars().take(300).collect::<String>());
                        usages.push(u.clone());
                        fallback.get_or_insert((js, u));
                        last_err = format!("check: {bad}");
                    }
                    Err(e) => {
                        eprintln!("{label}: call failed: {}", e.chars().take(300).collect::<String>());
                        last_err = e;
                    }
                }
                if started < MAX_CALLS {
                    slots.acquire();
                    start(started as usize, &mut live);
                    started += 1;
                } else if live.iter().all(Option::is_none) {
                    return match fallback {
                        Some((js, u)) => Ok((Some(js), u, started)),
                        None => Err(last_err),
                    };
                }
            }
            Err(mpsc::RecvTimeoutError::Timeout) => {
                let now = crate::models::http::epoch_ms();
                for l in live.iter_mut().flatten() {
                    let p = l.progress.load(SeqCst);
                    if p > 0 && !l.first {
                        l.first = true;
                        if let Ok(mut v) = ttft.lock() {
                            v.push(p.saturating_sub(l.start) as f64 / 1000.0);
                        }
                    }
                }
                if started >= MAX_CALLS {
                    continue;
                }
                let Some(newest) = live.iter().rev().flatten().next() else { continue };
                let p = newest.progress.load(SeqCst);
                let quiet = (now.saturating_sub(p.max(newest.start))) as f64 / 1000.0;
                let limit = if p == 0 {
                    let mut v = ttft.lock().map(|v| v.clone()).unwrap_or_default();
                    v.sort_by(|a, b| a.total_cmp(b));
                    v.get(v.len() / 2).map_or(STALL_S, |m| (TTFT_MULT * m).max(STALL_S))
                } else {
                    STALL_S
                };
                if quiet >= limit && slots.try_acquire_spare() {
                    start(started as usize, &mut live);
                    started += 1;
                }
            }
            Err(_) => return Err(last_err),
        }
    }
}

/// The workers of one task: one per run of files (`runs`).
#[allow(clippy::too_many_arguments)]
fn spawn_task(w: &Ctx, root: &Path, msgs: Vec<Value>, n: &str, paths: &[String], fix: bool, lat: &Lat, slots: &Arc<Slots>, t0: Instant) -> Vec<std::thread::JoinHandle<WorkerResult>> {
    let units = runs(paths);
    let msgs = Arc::new(msgs);
    units
        .into_iter()
        .map(|g| {
            let (c, l, sl, m, root, n) = (w.clone(), lat.clone(), slots.clone(), msgs.clone(), root.to_path_buf(), n.to_string());
            std::thread::spawn(move || {
                let s = Instant::now();
                let g2 = g.clone();
                let k = std::sync::atomic::AtomicU32::new(0);
                let whole = Arc::new(std::sync::atomic::AtomicBool::new(false));
                let call: Arc<dyn Fn() -> Cand + Send + Sync> = Arc::new(move || {
                    let k = k.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
                    let old: Vec<Option<String>> = g2.iter().map(|f| std::fs::read_to_string(root.join(f)).ok()).collect();
                    // Edits for every existing file on the first call: a worker that rewrites a whole file
                    // drops lines nobody asked it to touch (measured, speed9 rep 1 xl t14: the docs
                    // "Fields:" line lost its "(snake_case)" note, which cost a review round).
                    // Twins answer edits too (short answers are the fast ones); after an edit
                    // that did not apply, the next calls answer whole files.
                    let edits = !whole.load(std::sync::atomic::Ordering::SeqCst) && old.iter().all(|x| x.as_ref().is_some_and(|x| !x.trim().is_empty()));
                    // A fix worker sees its file as it is now (the session holds the original).
                    let current = if fix { g2.iter().zip(&old).map(|(f, x)| format!("\n=== {f} (current)\n{}", x.as_deref().unwrap_or("(new file)"))).collect() } else { String::new() };
                    let note = if k > 0 { "Think briefly: the order is mechanical; answer right away." } else { "" };
                    let mut msgs = (*m).clone();
                    msgs.push(json!({"role": "user", "content": worker_order(&n, &g2, &current, edits, note)}));
                    let cfg = crate::hybrid::call_cfg(&c, k);
                    let (text, mut usage) = crate::shard::query_text(&c.model_name, &cfg, &msgs)?;
                    let parse = |text: &str, fs: &[String], olds: &[Option<String>]| -> Result<serde_json::Map<String, Value>, (serde_json::Map<String, Value>, String)> {
                        let r = if !edits {
                            if fs.len() == 1 { parse_answer(text).map(|a| json!({fs[0].clone(): a}).to_string()) } else { parse_group(text, fs) }
                                .map(|j| serde_json::from_str(&j).unwrap_or_default())
                                .map_err(|e| (Default::default(), e))
                        } else if fs.len() == 1 {
                            crate::hybrid::apply_edits(olds[0].as_deref().unwrap_or(""), text)
                                .map(|a| json!({fs[0].clone(): a}).as_object().cloned().unwrap_or_default())
                                .map_err(|e| (Default::default(), format!("{}: {e}", fs[0])))
                        } else {
                            group_edits(fs, olds, text)
                        };
                        r
                    };
                    let mut got = serde_json::Map::new();
                    let mut res = parse(&text, &g2, &old);
                    // An edit that does not apply is asked again IN THE SAME SESSION, for the files
                    // that failed only, with the error: the files whose edits applied are kept.
                    // speed9 switched the whole unit to complete files instead (measured, speed10
                    // rep 1 xl t19: a 4-file unit took 36.5 s that way, the others 18 s).
                    let mut conv = msgs.clone();
                    let mut last = text;
                    if edits {
                        let mut tries = 0;
                        while let Err((ok, e)) = &res {
                            got.extend(ok.clone());
                            if tries >= 1 {
                                break;
                            }
                            tries += 1;
                            let left: Vec<String> = g2.iter().filter(|f| !got.contains_key(*f)).cloned().collect();
                            let lold: Vec<Option<String>> = left.iter().map(|f| std::fs::read_to_string(root.join(f)).ok()).collect();
                            conv.push(json!({"role": "assistant", "content": last}));
                            conv.push(json!({"role": "user", "content": format!(
                                "These edits did not apply: {e}\nA SEARCH block must copy lines of the CURRENT file exactly (same characters, same order). Answer again, in the same format, only for: {}.",
                                left.join(", "))}));
                            let (t2, u2) = crate::shard::query_text(&c.model_name, &cfg, &conv)?;
                            usage = add_usage(&usage, &u2);
                            // The retry must edit: an UNCHANGED for a file whose first edits
                            // failed would drop its order (measured, speed10 rep 3 s2 t03: the docs
                            // file came back unchanged and cost a review + fix round).
                            res = parse(&t2, &left, &lold).and_then(|m| match left.iter().find(|f| m.get(*f).is_some_and(Value::is_null)) {
                                Some(f) => Err((m.clone(), format!("{f}: the retry answered UNCHANGED"))),
                                None => Ok(m),
                            });
                            last = t2;
                        }
                    }
                    let js = match res {
                        Ok(m) => {
                            got.extend(m);
                            Ok(Value::Object(got).to_string())
                        }
                        Err((_, e)) => Err(e),
                    };
                    if edits && js.is_err() {
                        whole.store(true, std::sync::atomic::Ordering::SeqCst);
                    }
                    let js = js?;
                    // Deterministic check of the candidate before it can win (it is still only in
                    // memory: twins never write the tree; only the winner is written).
                    let bad = check_all(&js);
                    Ok((js, usage, bad))
                });
                let r = race(call, &g.join(","), &sl, &l);
                (g, r, s.elapsed().as_secs_f64(), s.duration_since(t0).as_secs_f64())
            })
        })
        .collect()
}

/// A grouped worker's edit answer (`=== EDITS <path>` + SEARCH/REPLACE blocks, or `UNCHANGED
/// <path>`, per file) as `{path: new content | null}`; a file without an answer, or an edit that
/// does not apply, is an error (the hedge twin then answers whole files). Measured (speed9 rep 1,
/// xl t20, a 12-entity rename): runs of 3 whole Go files took 13-14 s and ~1000 tokens out each.
fn group_edits(group: &[String], old: &[Option<String>], text: &str) -> Result<serde_json::Map<String, Value>, (serde_json::Map<String, Value>, String)> {
    let head = regex::Regex::new(r"(?m)^[ \t]*(?:=== EDITS|UNCHANGED)[ \t]+(\S+)[ \t]*$").unwrap();
    let hs: Vec<_> = head.captures_iter(text).collect();
    let mut out = serde_json::Map::new();
    let mut errs = vec![];
    for (f, o) in group.iter().zip(old) {
        let Some(k) = hs.iter().position(|c| c[1].trim_matches('`') == f.as_str()) else {
            errs.push(format!("the answer misses {f}"));
            continue;
        };
        let m = hs[k].get(0).unwrap();
        if m.as_str().trim_start().starts_with("UNCHANGED") {
            out.insert(f.clone(), Value::Null);
            continue;
        }
        let end = hs.get(k + 1).map_or(text.len(), |n| n.get(0).unwrap().start());
        match crate::hybrid::apply_edits(o.as_deref().unwrap_or(""), &text[m.end()..end]) {
            Ok(new) => {
                out.insert(f.clone(), new.map_or(Value::Null, Value::String));
            }
            Err(e) => errs.push(format!("{f}: {e}")),
        }
    }
    if errs.is_empty() { Ok(out) } else { Err((out, errs.join("; "))) }
}

/// Sum of two usages (a worker call and its in-session retry).
fn add_usage(a: &Value, b: &Value) -> Value {
    let n = |v: &Value, p: &str| v.pointer(p).and_then(Value::as_u64).unwrap_or(0);
    json!({"prompt_tokens": n(a, "/prompt_tokens") + n(b, "/prompt_tokens"), "completion_tokens": n(a, "/completion_tokens") + n(b, "/completion_tokens"),
        "prompt_tokens_details": {"cached_tokens": n(a, "/prompt_tokens_details/cached_tokens") + n(b, "/prompt_tokens_details/cached_tokens")},
        "completion_tokens_details": {"reasoning_tokens": n(a, "/completion_tokens_details/reasoning_tokens") + n(b, "/completion_tokens_details/reasoning_tokens")}, "retried": true})
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

/// Coordinator streams: a twin starts if no TASK block (and no answer) came back from the first
/// one within `COORD_HEDGE` s. Measured (speed9, Opus 5.5 via cli-proxy, s2 t02 x5): first token
/// at 1.2-4.0 s for the same prompt. The first stream that emits a task, or finishes, OWNS the
/// plan: the other stream's tasks are dropped, so workers never mix two plans.
const COORD_HEDGE: f64 = 2.0;

enum Ev {
    Task(usize, (String, Vec<String>, String)),
    Done(usize, Result<(String, Value), String>),
}

/// One coordinator answer over `msgs` (hedged, see `COORD_HEDGE`); every TASK block starts its
/// workers as it closes. Returns the coordinator's text, its stats line and the worker handles.
#[allow(clippy::too_many_arguments)]
fn coordinate(w: &Ctx, root: &Path, files: &[String], msgs: &[Value], fix: bool, o: &Opts, t0: Instant, slots: &Arc<Slots>, label: &str) -> (String, Value, Vec<(String, std::thread::JoinHandle<WorkerResult>)>, Vec<String>) {
    let s = Instant::now();
    let (tx, rx) = mpsc::channel::<Ev>();
    let spawn = |id: usize| {
        let (c, m, fl, tx) = (o.coord.clone(), msgs.to_vec(), files.to_vec(), tx.clone());
        std::thread::spawn(move || {
            let mut raw = String::new();
            let mut sent = 0usize;
            let mut sink = |kind: &str, piece: &str| {
                if kind != "text" {
                    return;
                }
                raw.push_str(piece);
                for t in tasks(&crate::clones::visible(&raw), &fl, false).into_iter().skip(sent) {
                    let _ = tx.send(Ev::Task(id, t));
                    sent += 1;
                }
            };
            let r = crate::clones::query_streamed(&c, &m, &mut sink);
            if let Ok((text, _)) = &r {
                for t in tasks(text, &fl, true).into_iter().skip(sent) {
                    let _ = tx.send(Ev::Task(id, t));
                }
            }
            let _ = tx.send(Ev::Done(id, r));
        });
    };
    spawn(0);
    let (mut started, mut live) = (1usize, 1usize);
    let mut owner: Option<usize> = None;
    let lat: Lat = Default::default();
    let (mut hs, mut dispatched, mut first) = (vec![], vec![], None);
    let (mut text, mut usage, mut errs) = (String::new(), Value::Null, vec![]);
    let mut usages = vec![];
    loop {
        let ev = if owner.is_none() && started < 2 {
            match rx.recv_timeout(std::time::Duration::from_secs_f64(COORD_HEDGE).saturating_sub(s.elapsed())) {
                Ok(ev) => ev,
                Err(_) => {
                    spawn(started);
                    started += 1;
                    live += 1;
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
            Ev::Task(id, (n, paths, plan)) => {
                if *owner.get_or_insert(id) != id {
                    continue;
                }
                first.get_or_insert(s.elapsed().as_secs_f64());
                let paths: Vec<String> = paths.into_iter().filter(|p| !dispatched.contains(p)).collect();
                if paths.is_empty() {
                    continue;
                }
                dispatched.extend(paths.iter().cloned());
                let mut wm = msgs.to_vec();
                wm.push(json!({"role": "assistant", "content": plan}));
                for h in spawn_task(w, root, wm, &n, &paths, fix, &lat, slots, t0) {
                    hs.push((n.clone(), h));
                }
            }
            Ev::Done(id, r) => {
                live -= 1;
                match r {
                    Ok((t, u)) => {
                        usages.push(u.clone());
                        if owner.is_none() || owner == Some(id) {
                            owner = Some(id);
                            text = t;
                            usage = u;
                            break;
                        }
                    }
                    Err(e) => {
                        eprintln!("{label} stream {id}: coordinator call failed: {}", e.chars().take(400).collect::<String>());
                        errs.push(e);
                        if owner == Some(id) {
                            break;
                        }
                    }
                }
                if live == 0 {
                    if started < 2 {
                        spawn(started);
                        started += 1;
                        live += 1;
                    } else {
                        break;
                    }
                }
            }
        }
    }
    let mut st = json!({"file": label, "model": o.coord.model_name, "call_s": (s.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "first_task_s": first.map(|x| (x * 10.0).round() / 10.0), "at_s": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0,
        "calls": started, "owner": owner, "tasks_to": dispatched, "usage": usage, "text": text});
    if text.is_empty() && !errs.is_empty() {
        st["error"] = json!(errs.join(" | "));
    }
    // A twin that lost still bills its tokens: count the ones that came back.
    if usages.len() > 1 {
        st["twin_usage"] = json!(usages.into_iter().filter(|u| *u != st["usage"]).collect::<Vec<_>>());
    }
    (text, st, hs, dispatched)
}

/// Warms the WORKER model's prompt cache with the coordinator's frozen session (system + repo +
/// task), the prefix every worker shares byte for byte, at t=0, while the coordinator plans. The
/// coordinator's cache is no use to the workers: another model, another provider. Measured on
/// Zai glm-5.3-flash (speed10 probes): a request whose prefix was sent before gets cached_tokens =
/// the prefix rounded down to 64 tokens, also when it starts while the first one is in flight;
/// warm first-token 1.0-2.5 s vs 2.4-5.5 s cold on a 22k-token prefix. One token out.
fn warmup(w: &Ctx, msgs: &[Value], slots: &Arc<Slots>, t0: Instant) -> std::thread::JoinHandle<Value> {
    let (c, m, sl) = (w.clone(), msgs.to_vec(), slots.clone());
    std::thread::spawn(move || {
        let s = Instant::now();
        let mut cfg = crate::hybrid::call_cfg(&c, 0);
        let mut kw = cfg.get("model_kwargs").and_then(Value::as_object).cloned().unwrap_or_default();
        kw.insert("max_tokens".into(), json!(1));
        cfg.insert("model_kwargs".into(), Value::Object(kw));
        sl.acquire();
        let r = crate::shard::query_usage(&c.model_name, &cfg, &m);
        sl.release();
        let mut st = json!({"file": "(worker warmup)", "model": c.model_name, "call_s": (s.elapsed().as_secs_f64() * 10.0).round() / 10.0, "at_s": (t0.elapsed().as_secs_f64() * 10.0).round() / 10.0});
        match r {
            Ok(u) => st["usage"] = u,
            Err(e) => st["error"] = json!(e.chars().take(200).collect::<String>()),
        }
        st
    })
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
    let _ = repair_go_imports(root);
    let _ = sh(root, "gofmt -w $(git ls-files -co --exclude-standard '*.go') 2>/dev/null");
}

/// Standard-library packages a worker forgets to import (or leaves imported): name -> path.
const STD: [(&str, &str); 18] = [
    ("strings", "strings"), ("strconv", "strconv"), ("sort", "sort"), ("sync", "sync"), ("errors", "errors"), ("fmt", "fmt"),
    ("math", "math"), ("time", "time"), ("http", "net/http"), ("json", "encoding/json"), ("bytes", "bytes"), ("io", "io"),
    ("os", "os"), ("slices", "slices"), ("maps", "maps"), ("context", "context"), ("regexp", "regexp"), ("unicode", "unicode"),
];

/// Deterministic import repair before the gate and the coordinator's review: `go build` in every
/// Go module of the tree; an `"x" imported and not used` drops that import line, an `undefined: x`
/// for a standard package adds its import. Up to 3 passes (`go build` stops at 10 errors per
/// package). Measured (speed9 reps 1-8 + speed10 rep 1): 21 of 74 coordinator FIX orders were
/// about imports, each one a review + fix round (4-10 s). Returns the files it changed.
fn repair_go_imports(root: &Path) -> Vec<String> {
    let (_, mods) = sh(root, "git ls-files -co --exclude-standard '*go.mod' 'go.mod'");
    let unused = regex::Regex::new(r#"(?m)^(\S+\.go):(\d+):\d+: "([^"]+)" imported and not used"#).unwrap();
    let undef = regex::Regex::new(r"(?m)^(\S+\.go):\d+:\d+: undefined: (\w+)$").unwrap();
    let mut changed = vec![];
    for m in mods.lines().filter(|l| !l.is_empty()) {
        let dir = Path::new(m).parent().map(|d| root.join(d)).unwrap_or_else(|| root.to_path_buf());
        for _ in 0..3 {
            let (ok, out) = sh(&dir, "go build ./... 2>&1");
            if ok {
                break;
            }
            let mut edits: std::collections::BTreeMap<String, (Vec<usize>, Vec<&str>)> = Default::default();
            for c in unused.captures_iter(&out) {
                edits.entry(c[1].to_string()).or_default().0.push(c[2].parse().unwrap_or(0));
            }
            for c in undef.captures_iter(&out) {
                if let Some((_, path)) = STD.iter().find(|(n, _)| *n == &c[2]) {
                    let e = edits.entry(c[1].to_string()).or_default();
                    if !e.1.contains(path) {
                        e.1.push(path);
                    }
                }
            }
            if edits.is_empty() {
                break;
            }
            for (f, (drop, add)) in edits {
                let p = dir.join(f.trim_start_matches("./"));
                let Ok(src) = std::fs::read_to_string(&p) else { continue };
                let mut lines: Vec<String> = src.lines().map(String::from).collect();
                for &n in drop.iter().rev() {
                    let i = n.saturating_sub(1);
                    if i < lines.len() && lines[i].trim_start().starts_with("import") && lines[i].contains('"') && !lines[i].contains('(') {
                        lines.remove(i);
                    } else if i < lines.len() && lines[i].trim().starts_with('"') {
                        lines.remove(i);
                    }
                }
                if !add.is_empty() {
                    let new: Vec<String> = add.iter().map(|a| format!("\t\"{a}\"")).collect();
                    if let Some(i) = lines.iter().position(|l| l.trim() == "import (") {
                        for (k, n) in new.into_iter().enumerate() {
                            lines.insert(i + 1 + k, n);
                        }
                    } else if let Some(i) = lines.iter().position(|l| l.starts_with("package ")) {
                        let block: Vec<String> = std::iter::once(String::new()).chain(std::iter::once("import (".to_string())).chain(new).chain(std::iter::once(")".to_string())).collect();
                        for (k, n) in block.into_iter().enumerate() {
                            lines.insert(i + 1 + k, n);
                        }
                    }
                }
                let out = lines.join("\n") + "\n";
                if out != src && std::fs::write(&p, out).is_ok() {
                    let rel = p.strip_prefix(root).map(|r| r.to_string_lossy().to_string()).unwrap_or_default();
                    eprintln!("import repair: {rel}");
                    if !changed.contains(&rel) {
                        changed.push(rel);
                    }
                }
            }
        }
    }
    changed
}

/// The whole run: plan + workers, then gate + coordinator review rounds. Returns the stats lines,
/// the files written, whether the gate passes, and how many review rounds sent fixes.
pub(crate) fn run(w: &Ctx, root: &Path, files: &[String], o: &Opts, t0: Instant, slots: &Arc<Slots>) -> (Vec<Value>, Vec<String>, bool, u32) {
    let mut msgs = session(&dump(root, files), &w.task);
    let warm = o.warmup.then(|| warmup(w, &msgs, slots, t0));
    let (plan, st, hs, mut targets) = coordinate(w, root, files, &msgs, false, o, t0, slots, "(coordinator plan)");
    let mut stats = vec![st];
    if let Some(h) = warm {
        stats.push(h.join().unwrap_or_else(|_| json!({"file": "(worker warmup)", "error": "panicked"})));
    }
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
        // The coordinator already reviewed every change and wrote exact FIX orders for what was
        // wrong; if the gate passes after them, a second full review only adds its latency
        // (measured, speed9 rep 1: 1.4-6 s per run). It reviews again when the gate fails.
        if files.iter().chain(&targets).any(|f| f.ends_with(".go")) {
            gofmt(root);
        }
        if o.verify.is_empty() || sh(root, &o.verify).0 {
            return (stats, targets, true, rounds);
        }
    }
}
