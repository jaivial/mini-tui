//! The RLM harness end to end: `mini-agent-rs rlm` runs scripts where long-horizon context is
//! program variables and sub-agents are function calls, over scripted models. No network.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

fn exe() -> PathBuf {
    PathBuf::from(env!("CARGO_BIN_EXE_mini-agent-rs"))
}

fn tmp(name: &str) -> PathBuf {
    let d = std::env::temp_dir().join(format!("rlm-test-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&d);
    std::fs::create_dir_all(&d).unwrap();
    d
}

/// A scripted model config: each query returns the next output.
fn yaml(name: &str, outputs: &[(&str, &str)]) -> String {
    let mut items = String::new();
    for (kind, text) in outputs {
        let text = serde_json::to_string(text).unwrap();
        if *kind == "answer" {
            items.push_str(&format!("    - {{role: assistant, content: {text}, extra: {{submission: {text}, cost: 0.01}}}}\n"));
        } else {
            items.push_str(&format!("    - {{role: assistant, content: {text}, extra: {{cost: 0.01}}}}\n"));
        }
    }
    let outputs = if items.is_empty() { "[]\n".to_string() } else { format!("\n{items}") };
    format!("model:\n  model_class: deterministic\n  model_name: {name}\n  cost_per_call: 0.01\n  outputs: {outputs}")
}

/// A scripted tool-calling model: `run` outputs execute `cmd`, `answer` outputs submit.
fn tool_yaml(name: &str, outputs: &[(&str, &str)]) -> String {
    let mut items = String::new();
    for (kind, text) in outputs {
        let text = serde_json::to_string(text).unwrap();
        if *kind == "run" {
            items.push_str(&format!("    - {{role: assistant, content: step, extra: {{actions: [{{command: {text}}}], cost: 0.01}}}}\n"));
        } else {
            items.push_str(&format!("    - {{role: assistant, content: {text}, extra: {{submission: {text}, cost: 0.01}}}}\n"));
        }
    }
    let outputs = if items.is_empty() { "[]\n".to_string() } else { format!("\n{items}") };
    format!("model:\n  model_class: deterministic_toolcall\n  model_name: {name}\n  cost_per_call: 0.01\n  outputs: {outputs}")
}

struct Out {
    stdout: String,
    stderr: String,
    code: i32,
}

/// Run the REPL on a script (on stdin, so both input paths are covered) in a fresh state dir.
fn rlm(dir: &Path, cfg: &str, script: &str, args: &[&str]) -> Out {
    std::fs::write(dir.join("run.yaml"), cfg).unwrap();
    let mut cmd = Command::new(exe());
    cmd.arg("rlm")
        .arg("-c")
        .arg(dir.join("run.yaml"))
        .arg("--state")
        .arg(dir.join("rlm.json"))
        .args(args)
        .arg("-")
        .env("MSWEA_GLOBAL_CONFIG_DIR", dir)
        .env("MSWEA_SILENT_STARTUP", "1")
        .env_remove("MINI_AGENT_SOCKET").env_remove("MINI_AGENT_BIN").env_remove("MINI_AGENT_CONFIG_DIR").env_remove("MINI_AGENT_CONTEXT")
        .current_dir(dir)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    let mut child = cmd.spawn().unwrap();
    child.stdin.as_mut().unwrap().write_all(script.as_bytes()).unwrap();
    let out = child.wait_with_output().unwrap();
    Out {
        stdout: String::from_utf8_lossy(&out.stdout).into_owned(),
        stderr: String::from_utf8_lossy(&out.stderr).into_owned(),
        code: out.status.code().unwrap_or(-1),
    }
}

/// The lines of stdout, trimmed.
fn lines(out: &Out) -> Vec<String> {
    out.stdout.lines().map(|l| l.trim().to_string()).collect()
}

#[test]
fn variables_are_the_long_horizon_context() {
    let d = tmp("vars");
    let out = rlm(
        &d,
        &yaml("t", &[]),
        "# comment\nlet repo = mini-tui\nlet branch = {{repo}}-main\nshow branch\nvars\nunset repo\nvars\n",
        &[],
    );
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(
        lines(&out),
        vec!["mini-tui-main", "branch = mini-tui-main", "repo = mini-tui", "branch = mini-tui-main"]
    );
}

#[test]
fn undefined_variables_are_errors() {
    let d = tmp("undef");
    let out = rlm(&d, &yaml("t", &[]), "let x = {{missing}}\n", &[]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("error:"), "stderr: {}", out.stderr);
    assert!(out.stderr.contains("undefined"), "stderr: {}", out.stderr);
}

#[test]
fn function_calls_return_values() {
    let d = tmp("fncall");
    let out = rlm(
        &d,
        &yaml("t", &[]),
        "def greet(name)\nreturn hello {{name}}\nend\nlet x = call greet(world)\nshow x\nlet y = call greet({{x}})\nshow y\n",
        &[],
    );
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(lines(&out), vec!["hello world", "hello hello world"]);
}

#[test]
fn calls_compose_recursively() {
    let d = tmp("recurse");
    let out = rlm(
        &d,
        &yaml("t", &[]),
        "def outer(n)\nlet inner = call inner({{n}})\nreturn done: {{inner}}\nend\ndef inner(n)\nreturn got {{n}}\nend\nlet x = call outer(41)\nshow x\n",
        &[],
    );
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(lines(&out), vec!["done: got 41"]);
}

#[test]
fn recursion_stops_at_the_depth_cap() {
    let d = tmp("depth");
    let out = rlm(&d, &yaml("t", &[]), "def loop(n)\nreturn call loop({{n}})\nend\ncall loop(1)\n", &[]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("max recursion depth"), "stderr: {}", out.stderr);
    // The cap is configurable.
    let out = rlm(
        &d,
        &yaml("t", &[]),
        "def loop(n)\nreturn call loop({{n}})\nend\ncall loop(1)\n",
        &["--max-depth", "3"],
    );
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("max recursion depth (3)"), "stderr: {}", out.stderr);
}

#[test]
fn lets_are_local_to_a_call_and_set_is_global() {
    let d = tmp("scope");
    let out = rlm(
        &d,
        &yaml("t", &[]),
        "let g = outer\ndef f()\nlet g = inner\nset kept = from-fn\nreturn {{g}}\nend\nlet r = call f()\nshow r\nshow g\nshow kept\n",
        &[],
    );
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(lines(&out), vec!["inner", "outer", "from-fn"]);
}

#[test]
fn ask_returns_the_model_answer() {
    let d = tmp("ask");
    let out = rlm(
        &d,
        &yaml("t", &[("answer", "four"), ("answer", "done")]),
        "let a = ask What is 2+2?\nshow a\nask And now?\ncost\n",
        &[],
    );
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(lines(&out), vec!["four", "done", "cost $0.0200 over 2 model calls"]);
}

#[test]
fn sub_agents_are_function_calls_with_tools() {
    let d = tmp("tools");
    let out = rlm(
        &d,
        &tool_yaml("t", &[("run", "echo from-tool"), ("answer", "answer: from-tool")]),
        "def worker(q)\nlet r = ask {{q}}\nreturn {{r}}\nend\nlet out = call worker(check the tool)\nshow out\n",
        &[],
    );
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(lines(&out), vec!["answer: from-tool"]);
}

#[test]
fn run_executes_shell_in_the_session() {
    let d = tmp("run");
    let out = rlm(&d, &yaml("t", &[]), "let x = run echo hi\nshow x\nrun pwd\n", &[]);
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    let l = lines(&out);
    assert_eq!(l[0], "hi");
    assert_eq!(l[1], d.display().to_string());
}

#[test]
fn state_persists_across_restarts() {
    let d = tmp("persist");
    let first = rlm(
        &d,
        &yaml("t", &[]),
        "let notes = remember me\ndef helper()\nreturn recalled {{notes}}\nend\n",
        &[],
    );
    assert_eq!(first.code, 0, "stderr: {}", first.stderr);
    let second = rlm(&d, &yaml("t", &[]), "show notes\ncall helper()\n", &[]);
    assert_eq!(second.code, 0, "stderr: {}", second.stderr);
    assert_eq!(lines(&second), vec!["remember me", "recalled remember me"]);
}

#[test]
fn unknown_functions_and_statements_are_errors() {
    let d = tmp("unknown");
    let out = rlm(&d, &yaml("t", &[]), "call nope()\n", &[]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("unknown function: nope"), "stderr: {}", out.stderr);
    let out = rlm(&d, &yaml("t", &[]), "nonsense\n", &[]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("unknown statement"), "stderr: {}", out.stderr);
}

#[test]
fn wrong_arity_is_an_error() {
    let d = tmp("arity");
    let out = rlm(&d, &yaml("t", &[]), "def f(a, b)\nreturn {{a}}{{b}}\nend\ncall f(1)\n", &[]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("takes 2 args, got 1"), "stderr: {}", out.stderr);
}

#[test]
fn quit_stops_the_script() {
    let d = tmp("quit");
    let out = rlm(&d, &yaml("t", &[]), "quit\nshow never\n", &[]);
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert!(out.stdout.trim().is_empty(), "stdout: {}", out.stdout);
}

#[test]
fn eval_statements_run_before_the_script() {
    let d = tmp("eval");
    let out = rlm(&d, &yaml("t", &[]), "show x\n", &["-e", "let x = hi"]);
    assert_eq!(out.code, 0, "stderr: {}", out.stderr);
    assert_eq!(lines(&out), vec!["hi"]);
}

#[test]
fn a_def_must_close() {
    let d = tmp("open-def");
    let out = rlm(&d, &yaml("t", &[]), "def f()\nreturn x\n", &[]);
    assert_eq!(out.code, 1);
    assert!(out.stderr.contains("end"), "stderr: {}", out.stderr);
}
