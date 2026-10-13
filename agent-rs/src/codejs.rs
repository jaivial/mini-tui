//! Opt-in JavaScript batching. Each invocation has a fresh bounded QuickJS runtime.
//! Host tools execute sequentially on the agent thread, including Promise.all calls.
use crate::writing::CodeCtx;
use rquickjs::{Context, Ctx, Exception, Function, Promise, Runtime};
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicBool, AtomicUsize, Ordering},
    Arc, Mutex,
};
const OUTPUT_MAX: usize = 60 * 1024;
const CALL_MAX: usize = 128;
pub fn enabled() -> bool {
    crate::writing::write_enabled() && std::env::var("MINITUI_CODEJS").as_deref() == Ok("1")
}
pub fn tool(kind: &str) -> Value {
    let description = "Run an async JavaScript function body in a fresh QuickJS sandbox. await tools.read({path,offset?,limit?}), tools.write({path,content}), tools.edit({path,edits:[{oldText,newText}]}), tools.bash({command}). Results are structured tool observations; failures throw with the observation. print(...values), return a value. Host calls are sequential even in Promise.all. No filesystem/network/process access except these tools, no imports. 128 host calls, 64MB memory, 300s wall limit, 60KB output. Changes before a failure are real and are not undone. Read images stay in structured results; this tool does not forward image blocks to the model.";
    let params = json!({"type":"object","properties":{"code":{"type":"string","description":"Async JavaScript function body"}},"required":["code"]});
    match kind {
        "chat" => {
            json!({"type":"function","function":{"name":"codejs","description":description,"parameters":params}})
        }
        "responses" => {
            json!({"type":"function","name":"codejs","description":description,"parameters":params})
        }
        _ => json!({"name":"codejs","description":description,"input_schema":params}),
    }
}
fn prefix(s: &str, max: usize) -> &str {
    let mut n = s.len().min(max);
    while !s.is_char_boundary(n) {
        n -= 1;
    }
    &s[..n]
}
pub fn outcome(args: &Value, host: &mut CodeCtx) -> Value {
    let started = std::time::Instant::now();
    let calls = Arc::new(AtomicUsize::new(0));
    let printed = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(AtomicBool::new(false));
    let bash = Arc::new(Mutex::new(std::mem::replace(
        &mut host.bash,
        Box::new(|_| Value::Null),
    )));
    let code = args.get("code").and_then(Value::as_str).unwrap_or("");
    let secs = std::env::var("MINI_CODE_TIMEOUT")
        .ok()
        .and_then(|s| s.parse::<u64>().ok())
        .unwrap_or(300)
        .clamp(1, 300);
    let deadline = started + std::time::Duration::from_secs(secs);
    let run = || -> Result<String, String> {
        if code.trim().is_empty() || code.len() > crate::writing::WRITE_HARD_CAP {
            return Err("Missing or oversized code body".into());
        }
        let rt = Runtime::new().map_err(|e| e.to_string())?;
        rt.set_memory_limit(64 * 1024 * 1024);
        rt.set_max_stack_size(512 * 1024);
        rt.set_interrupt_handler(Some(Box::new(move || {
            crate::agent::STOP.load(Ordering::SeqCst) || std::time::Instant::now() >= deadline
        })));
        let context = Context::full(&rt).map_err(|e| e.to_string())?;
        context.with(|ctx| -> rquickjs::Result<String> {
            let cwd=host.cwd.clone(); let b=bash.clone(); let c=calls.clone(); let end=ended.clone();
            ctx.globals().set("__host",Function::new(ctx.clone(),move |js:Ctx<'_>,name:String,raw:String| -> rquickjs::Result<String> {
                if crate::agent::STOP.load(Ordering::SeqCst)||std::time::Instant::now()>=deadline||end.load(Ordering::SeqCst) {
                    return Err(Exception::throw_message(&js,"codejs cancelled, timed out, or run ended"));
                }
                if c.fetch_add(1,Ordering::SeqCst)>=CALL_MAX { return Err(Exception::throw_message(&js,"codejs host call limit (128)")); }
                let a:Value=serde_json::from_str(&raw).map_err(|_|Exception::throw_message(&js,"Invalid tool argument JSON"))?;
                if !a.is_object() { return Err(Exception::throw_message(&js,"Tool arguments must be an object")); }
                let out=match name.as_str() {
                    "read"=>crate::tools::read_outcome(&a,&cwd),
                    "write"=>crate::writing::write_outcome(&a,&cwd),
                    "edit"=>crate::writing::edit_outcome(&a,&cwd),
                    "bash"=> {
                        let cmd=a.get("command").and_then(Value::as_str).filter(|s|!s.trim().is_empty()).ok_or_else(||Exception::throw_message(&js,"Missing bash command"))?;
                        let out=(b.lock().unwrap())(cmd);
                        if out.get("returncode").and_then(Value::as_i64)==Some(-1) {end.store(true,Ordering::SeqCst);}
                        out
                    },
                    _=>return Err(Exception::throw_message(&js,"Unknown codejs host tool")),
                };
                Ok(out.to_string())
            })?)?;
            let p=printed.clone();let t=truncated.clone();
            ctx.globals().set("__print",Function::new(ctx.clone(),move |s:String| {
                let mut out=p.lock().unwrap(); let room=OUTPUT_MAX.saturating_sub(out.len());
                let part=prefix(&s,room.saturating_sub(1)); if part.len()<s.len(){t.store(true,Ordering::SeqCst);}
                out.push_str(part);if out.len()<OUTPUT_MAX{out.push('\n');}
            })?)?;
            ctx.eval::<(),_>(r#"
                const bridge=globalThis.__host; delete globalThis.__host;
                const emit=globalThis.__print; delete globalThis.__print;
                globalThis.tools=Object.freeze(Object.fromEntries(['read','write','edit','bash'].map(name=>[name,async args=>{
                    const out=JSON.parse(bridge(name,JSON.stringify(args)));
                    if(out.returncode!==0) {const error=new Error(out.output||'Tool failed');error.observation=out;throw error;}
                    return out;
                }])));
                globalThis.print=(...values)=>emit(values.map(v=>typeof v==='string'?v:JSON.stringify(v)).join(' '));
            "#)?;
            let source=format!("(async()=>{{\n{code}\n}})().then(value=>JSON.stringify(value)??'undefined')");
            let promise:Promise=ctx.eval(source)?;
            let result=promise.finish::<String>();
            result.map_err(|e| { if e.is_exception() {
                let caught=ctx.catch();
                let text=ctx.eval::<Function,_>("e=>String(e)+(e&&e.stack?'\\n'+e.stack:'')")
                    .and_then(|stringify| stringify.call::<_,String>((caught,)))
                    .unwrap_or_else(|_|"JavaScript exception".into());
                // Store the message before returning the exception to the outer layer.
                let mut buf=printed.lock().unwrap(); let room=OUTPUT_MAX.saturating_sub(buf.len()); let note=format!("\nJavaScript error: {text}"); buf.push_str(prefix(&note,room));
            } e })
        }).map_err(|e|e.to_string())
    };
    let result = run();
    host.bash = std::mem::replace(&mut *bash.lock().unwrap(), Box::new(|_| Value::Null));
    let failed = result.is_err();
    let mut text = format!(
        "JavaScript {} in {:.2}s, {} host calls\n{}",
        if failed { "failed" } else { "completed" },
        started.elapsed().as_secs_f64(),
        calls.load(Ordering::SeqCst).min(CALL_MAX),
        printed.lock().unwrap()
    );
    match result {
        Ok(v) => text.push_str(&format!("\n=> {v}")),
        Err(e) => text.push_str(&format!(
            "\nScript error: {e}. Changes already made are not undone."
        )),
    };
    let output_truncated = text.len() > OUTPUT_MAX || truncated.load(Ordering::SeqCst);
    if output_truncated {
        let note = "\n[JavaScript output truncated at 60KB.]";
        text = format!("{}{note}", prefix(&text, OUTPUT_MAX - note.len()));
    }
    json!({"output":text,"returncode":i64::from(failed),"exception_info":if failed{text.clone()}else{String::new()},"extra":{"tool":"codejs","calls":calls.load(Ordering::SeqCst).min(CALL_MAX),"wall_ms":started.elapsed().as_millis() as u64,"output_truncated":output_truncated}})
}
