//! The ContextStore end to end: a scripted orchestrator fills the store once, spawns children
//! that get their repo's slice without re-discovering, and the hub runs the handshake and the
//! contract check at the end of a child's turn. No model, no network.

use serde_json::Value;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::Command;
use std::time::{Duration, Instant};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("ctxstore-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

fn write(path: &Path, text: &str) {
    if let Some(p) = path.parent() {
        std::fs::create_dir_all(p).unwrap();
    }
    std::fs::File::create(path).unwrap().write_all(text.as_bytes()).unwrap();
}

fn script(name: &str, steps: &[(&str, &str)]) -> String {
    let mut out = format!(
        "agent:\n  system_template: s\n  instance_template: \"{{{{task}}}}\"\n  step_limit: 40\nmodel:\n  model_class: deterministic_toolcall\n  model_name: {name}\n  cost_per_call: 0.01\n  outputs:\n"
    );
    for (kind, text) in steps {
        let text = serde_json::to_string(text).unwrap();
        if *kind == "run" {
            out.push_str(&format!("    - {{role: assistant, content: step, extra: {{actions: [{{command: {text}}}]}}}}\n"));
        } else {
            out.push_str(&format!("    - {{role: assistant, content: {text}, extra: {{submission: {text}}}}}\n"));
        }
    }
    out
}

/// `run_parent` with a deliberate PATH, so a test about what the hub puts on PATH measures the
/// hub and not the shell the developer happened to be in.
fn run_parent_with_path(dir: &Path, parent_yaml: &str, child_yaml: &str, until: &str, path: &str) -> Vec<Value> {
    let old = std::env::var("PATH").ok();
    // SAFETY: single-threaded test setup, restored before returning.
    unsafe { std::env::set_var("PATH", path) };
    let out = run_parent(dir, parent_yaml, child_yaml, until);
    if let Some(p) = old {
        unsafe { std::env::set_var("PATH", p) };
    }
    out
}

fn messages(journal: &Path) -> Vec<Value> {
    let text = std::fs::read_to_string(journal).unwrap_or_default();
    let mut out = vec![];
    for l in text.lines() {
        let Ok(v) = serde_json::from_str::<Value>(l) else { continue };
        match v["t"].as_str() {
            Some("meta") => out.clear(),
            Some("msg") => out.push(v["m"].clone()),
            _ => {}
        }
    }
    out
}

fn text(m: &Value) -> String {
    match m.get("content") {
        Some(Value::String(t)) => t.clone(),
        _ => m.get("content").map(|c| c.to_string()).unwrap_or_default(),
    }
}

fn run_parent(dir: &Path, parent_yaml: &str, child_yaml: &str, until: &str) -> Vec<Value> {
    write(&dir.join("parent.yaml"), parent_yaml);
    write(&dir.join("child.yaml"), child_yaml);
    let mut cmd = Command::new(exe());
    cmd.arg("-y").arg("--exit-immediately").arg("-o").arg(dir.join("traj.json")).arg("-c").arg(dir.join("parent.yaml")).arg("-t").arg("orchestrate");
    cmd.env("MSWEA_SILENT_STARTUP", "1")
        .env("MSWEA_CONTROL_FILE", "")
        .env("MINI_AGENT_CHILD_CONFIG", dir.join("child.yaml"))
        .env("MINI_AGENT_MONITOR_MS", "50")
        .env_remove("MINI_AGENT_SOCKET")
        .env_remove("MINI_AGENT_PARENT_SOCKET")
        .env_remove("MINI_AGENT_DEPTH")
        .env_remove("MINI_AGENT_CONTEXT_DIR")
        .env_remove("MINI_AGENT_CONTEXT").env_remove("MINI_AGENT_BIN").env_remove("MINI_AGENT_CONFIG_DIR").env_remove("MINI_AGENT_CONTEXT");
    cmd.current_dir(dir);
    cmd.stdout(std::process::Stdio::null()).stderr(std::fs::File::create(dir.join("parent.log")).unwrap());
    let mut child = cmd.spawn().unwrap();
    let journal = dir.join("traj.jsonl");
    let deadline = Instant::now() + Duration::from_secs(30);
    loop {
        if let Ok(Some(_)) = child.try_wait() {
            return messages(&journal);
        }
        if messages(&journal).iter().any(|m| text(m).contains(until)) || Instant::now() > deadline {
            std::thread::sleep(Duration::from_millis(300));
            unsafe {
                libc::kill(child.id() as i32, libc::SIGTERM);
            }
            let _ = child.wait();
            return messages(&journal);
        }
        std::thread::sleep(Duration::from_millis(50));
    }
}

#[test]
fn children_are_handed_the_shared_context_the_orchestrator_filled_once() {
    let dir = tmp("handover");
    write(&dir.join("findings.md"), "# backend\n`internal/api/group_menus_party_size.go:21 handleGetValidMenusForPartySize <- boRouter`\n\n# preact\n`src/lib/types.ts:506 GroupMenuDisplay <- Reservas.tsx`\n");
    write(&dir.join("contracts.md"), "- backend: emits `group_menu_display`\n- preact: consumes `group_menu_display`\n");
    write(&dir.join("backend-api.md"), "# callers of the handler\n`internal/api/server.go:650 handleToggle <- server`\n");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent state put findings.md --prompt-file findings.md && mini-agent-rs agent state put contracts.md --prompt-file contracts.md && mini-agent-rs agent state put surface.backend.md --prompt-file backend-api.md > out0.txt 2>&1; cat out0.txt"),
            // The backend child gets its slice: the backend surface doc and the backend contract
            // clause, and NOT the preact-only symbol.
            ("run", "mini-agent-rs agent spawn be-worker --cwd /tmp --repo backend 'edit the handler' && mini-agent-rs agent wait be-worker --timeout 20 > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    // The child answers with a handshake: what it touched, who calls it, what contract it emitted.
    let child = script(
        "child",
        &[(
            "submit",
            "Done.\nsurface: internal/api/server.go:650 handleToggle <- server\ncontract: group_menu_display -> preact GroupMenuDisplay\nsurprise: none",
        )],
    );
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("parent done"), "{all}");

    // 1. The child's own task carries the ContextStore slice.
    let child_msgs = messages(&dir.join("subagents/be-worker/traj.jsonl"));
    let task = child_msgs.iter().find(|m| m["role"] == "user").map(text).unwrap_or_default();
    assert!(task.contains("<context name=\"findings.md\">"), "{task}");
    assert!(task.contains("<context name=\"contracts.md\">"), "{task}");
    assert!(task.contains("<context name=\"surface.backend.md\">"), "{task}");
    // It is HANDED, not rediscovered: the spawn message says so.
    assert!(all.contains("handed") && all.contains("context doc"), "{all}");

    // 2. The handshake went back into the store as <child>.md.
    let hs = dir.join("context/be-worker.md");
    assert!(hs.is_file(), "the handshake was not stored: {}", dir.join("context").display());
    let hs_body = std::fs::read_to_string(&hs).unwrap();
    assert!(hs_body.contains("## surface") && hs_body.contains("handleToggle"), "{hs_body}");
    assert!(hs_body.contains("## contract") && hs_body.contains("group_menu_display"), "{hs_body}");
}

#[test]
fn contract_check_runs_at_the_end_of_a_child_turn() {
    let dir = tmp("contract-check");
    write(&dir.join("contracts.md"), "- backend: emits `group_menu_display` for preact\n");
    // A real repo the child "touches": the file does NOT carry the contract field, so the check fails.
    write(&dir.join("backend/handler.go"), "package main\nfunc handleToggle() {}\n");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent state put contracts.md --prompt-file contracts.md > /dev/null 2>&1; mini-agent-rs agent spawn be-worker --cwd backend --repo backend 'edit the handler' && mini-agent-rs agent wait be-worker --timeout 20 > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "Done.\nsurface: handler.go:2 handleToggle <- server\ncontract: none\nsurprise: none")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    // The check found the claim does not hold (handler.go lacks the contract field) and told the parent.
    assert!(all.contains("contract-check") && all.contains("FAIL"), "the failed contract check did not reach the parent:\n{all}");
}

#[test]
fn surface_answers_from_the_index_without_grepping() {
    let dir = tmp("surface");
    write(&dir.join("findings.md"), "# backend\n`internal/api/server.go:650 handleToggle <- server boRouter` [contract group_menu_display]\n");
    let parent = script(
        "parent",
        &[
            ("run", "mini-agent-rs agent state put findings.md --prompt-file findings.md > /dev/null 2>&1; mini-agent-rs agent surface handleToggle > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "unused")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("handleToggle") && all.contains("internal/api/server.go:650"), "{all}");
    assert!(all.contains("called by") && all.contains("contract: group_menu_display"), "{all}");
}

/// Review 1: `agent contract-check --repo X` run BY HAND reads the recorded handshake, and the
/// parser only understood the raw answer, so the command reported a vacuous pass. This is the CLI
/// path, end to end.
#[test]
fn contract_check_by_hand_reads_the_recorded_handshake() {
    let dir = tmp("cc-hand");
    write(&dir.join("contracts.md"), "- backend: emits `group_menu_display` for preact\n");
    write(&dir.join("backend/handler.go"), "package main\nfunc handleToggle() {}\n");
    let parent = script(
        "parent",
        &[
            // A child finishes with a handshake naming a file that does NOT carry the contract field.
            ("run", "mini-agent-rs agent state put contracts.md --prompt-file contracts.md > /dev/null 2>&1; mini-agent-rs agent spawn be-worker --cwd backend --repo backend 'edit it' && mini-agent-rs agent wait be-worker --timeout 20 > /dev/null 2>&1; sleep 1; mini-agent-rs agent contract-check --repo backend --name be-worker backend > out1.txt 2>&1; cat out1.txt"),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "Done.\nsurface: handler.go:2 handleToggle <- server\ncontract: none\nsurprise: none")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("contract-check"), "{all}");
    // The file the child claimed must be recognised, otherwise the contracts check greps nothing.
    assert!(!all.contains("the handshake names no file"), "the by-hand check read no handshake at all:\n{all}");
    assert!(all.contains("handler.go:2 handleToggle") || all.contains("1 claimed file"), "the claimed file was not found:\n{all}");
    assert!(all.contains("FAIL"), "the claim does not hold (handler.go lacks the field) and it must say so:\n{all}");
}

/// Review 2: the store is handed over by default, and the cap check that used to guard
/// `--context-file` now also guards the store: a big findings.md made EVERY spawn fail with
/// "the --context-file blocks are N chars" -- blaming a flag the parent never passed. The store
/// is the parent's own paid-for text, so it degrades (drop, then trim) instead of failing the
/// spawn; only an explicit --context-file is still refused.
#[test]
fn a_big_store_degrades_the_handover_instead_of_failing_the_spawn() {
    let dir = tmp("big-store");
    // One big findings doc and one small one: the child must still start, and get what fits.
    let big = format!("# backend\n{}\n", "filler line about the backend handler\n".repeat(1200));
    write(&dir.join("findings.md"), &big);
    write(&dir.join("contracts.md"), "- backend: emits `group_menu_enabled`\n");
    write(&dir.join("big.md"), &big);
    // The other side of the wave handed its artifacts back: five 8 KB handshakes, which together
    // with the two docs above are over the 32 KB the spawn used to cap --context-file against.
    let puts: Vec<String> = (0..5)
        .map(|i| format!("mini-agent-rs agent state put child{i}.md --prompt-file big.md > /dev/null 2>&1"))
        .collect();
    let parent = script(
        "parent",
        &[
            ("run", &format!("mini-agent-rs agent state put findings.md --prompt-file findings.md > /dev/null 2>&1; {}; mini-agent-rs agent spawn be-worker --cwd /tmp --repo backend 'do it' > out1.txt 2>&1; cat out1.txt", &puts.join("; "))),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "Done.\nsurface: none\ncontract: none\nsurprise: none")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("started subagent be-worker"), "the spawn must not fail on a big store:\n{all}");
    assert!(!all.contains("over the"), "no cap failure:\n{all}");
}

/// Review 3: the DEFAULT (no --repo) must reach the repo a child works in, from its cwd alone --
/// the point of the default is that the parent does not have to remember it. It took the first
/// path segments, so `/home/jaime/work/newvillacarmen/backend` truncated the repo name away.
#[test]
fn a_child_gets_its_surface_doc_without_being_told_which_repo_it_is() {
    let dir = tmp("default-repo");
    // A findings doc with a per-repo section and a per-repo surface doc, as the orchestrator writes.
    write(&dir.join("findings.md"), "# backend\n`internal/api/handler.go:20 handleToggle`\n\n# preact\n`src/lib/Reservas.tsx:900 row`\n");
    write(&dir.join("surface.backend.md"), "# backend\n`internal/api/router.go:9 handleToggle <- server`\n");
    // The child works deep inside a worktree of the backend repo, and is told nothing.
    let deep = dir.join("work/backend/.worktrees/be-worker");
    std::fs::create_dir_all(&deep).unwrap();
    let parent = script(
        "parent",
        &[
            ("run", &format!("mini-agent-rs agent state put findings.md --prompt-file {} > /dev/null 2>&1; mini-agent-rs agent state put surface.backend.md --prompt-file {} > /dev/null 2>&1; mini-agent-rs agent spawn be-worker --cwd {} 'do it' > out1.txt 2>&1; cat out1.txt", dir.join("findings.md").display(), dir.join("surface.backend.md").display(), deep.display())),
            ("submit", "parent done"),
        ],
    );
    let child = script("child", &[("submit", "Done.\nsurface: none\ncontract: none\nsurprise: none")]);
    let msgs = run_parent(&dir, &parent, &child, "parent done");
    let all = msgs.iter().map(text).collect::<Vec<_>>().join("\n---\n");
    assert!(all.contains("handed"), "the store was not handed over at all:\n{all}");
    // The child's own task message is where it lands: read the child's journal.
    let cj = messages(&dir.join("subagents/be-worker/traj.jsonl"));
    let ctext = cj.iter().map(text).collect::<Vec<_>>().join("\n");
    assert!(ctext.contains("surface.backend.md") || ctext.contains("handleToggle"), "the backend child did not get its own surface:\n{ctext}");
    assert!(!ctext.contains("Reservas.tsx"), "it must not be billed for the preact repo's surface:\n{ctext}");
}

/// Measured in the browser: the system prompt tells every agent to keep a task card with
/// `mini-tui tasks set`, and it was not on the child's PATH, so the model burned ~20 calls
/// hunting for it (and for bun). The hub puts `mini-agent-rs` there; it now puts `mini-tui`
/// next to it, resolved the same way the runner resolves it.
#[test]
fn mini_tui_is_on_the_path_of_a_child() {
    let dir = tmp("tui-path");
    let parent = script(
        "parent",
        &[("run", "mini-agent-rs agent spawn be-worker --cwd /tmp 'check your tools' > /dev/null 2>&1; mini-agent-rs agent wait be-worker --timeout 20 > /dev/null 2>&1; sleep 1; true")],
    );
    // The child just reports what it can see of its own PATH.
    let child = script("child", &[("run", "command -v mini-agent-rs > p1.txt; command -v mini-tui > p2.txt; cat p1.txt p2.txt"), ("submit", "Done.")]);
    // The whole point is that the HUB puts it there, so the parent must not bring it: start from
    // a PATH with neither binary on it, or the test would pass on the ambient environment.
    let msgs = run_parent_with_path(&dir, &parent, &child, "Done.", "/usr/bin:/bin");
    let cj = messages(&dir.join("subagents/be-worker/traj.jsonl"));
    let ctext = cj.iter().map(text).collect::<Vec<_>>().join("\n");
    assert!(ctext.contains("mini-agent-rs"), "mini-agent-rs must stay on PATH:\n{ctext}");
    // mini-tui is only put there when the binary actually exists on this machine; assert the
    // resolution, not the outcome, so the test is meaningful wherever it runs.
    let resolved = mini_tui_bin().is_some();
    if resolved {
        assert!(ctext.contains("mini-tui"), "mini-tui is installed but not on the child's PATH:\n{ctext}");
    }
}

/// The same resolution `start()` does, exposed so the test can assert what it resolved.
fn mini_tui_bin() -> Option<String> {
    std::env::var("MINI_TUI_BIN").ok().filter(|v| !v.is_empty()).or_else(|| {
        let home = std::env::var("HOME").ok()?;
        let installed = PathBuf::from(&home).join(".local/bin/mini-tui");
        installed.is_file().then(|| installed.display().to_string())
    })
}
