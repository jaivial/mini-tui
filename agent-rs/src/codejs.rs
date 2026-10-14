//! Opt-in JavaScript batching. Each invocation has a fresh bounded QuickJS runtime.
//! Host tools execute sequentially on the agent thread, including Promise.all calls.
use crate::writing::CodeCtx;
use std::collections::HashMap;
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
    let description = "Run an async JavaScript function body in a fresh QuickJS sandbox. await tools.read({path,offset?,limit?}), tools.write({path,content}), tools.edit({path,edits:[{oldText,newText}]}), tools.bash({command}). Results are structured tool observations; failures throw with the observation. text(value), print(...values), console.log/info/warn/error/debug(...values), return a value. Host calls are sequential even in Promise.all. No filesystem/network/process access except these tools, no imports. 128 host calls, 64MB memory, 300s wall limit, 60KB output. Filesystem changes before failure are real. store(key,value) and load(key) keep small JSON state between codejs calls in this agent run (64 keys, 16KB/value, 128KB total); store(key,undefined) deletes. Store writes commit only on successful execution, reset on run/resume, never persist to disk. Image reads return an image_handle instead of base64. image(readResult) forwards its verified native read image to the model. At most 4 emitted images and 8MB decoded image bytes total per execution. Images emitted before a later script failure are preserved.";
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
pub fn outcome(args: &Value, host: &mut CodeCtx, state: &mut crate::util::Obj) -> Value {
    let started = std::time::Instant::now();
    let candidate = Arc::new(Mutex::new(state.clone()));
    let calls = Arc::new(AtomicUsize::new(0));
    let printed = Arc::new(Mutex::new(String::new()));
    let truncated = Arc::new(AtomicBool::new(false));
    let ended = Arc::new(AtomicBool::new(false));
    let images: Arc<Mutex<HashMap<String, String>>> = Arc::new(Mutex::new(HashMap::new()));
    let emitted: Arc<Mutex<Vec<String>>> = Arc::new(Mutex::new(Vec::new()));
    let image_bytes = Arc::new(AtomicUsize::new(0));
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
    let _host_deadline = crate::environment::host_deadline(deadline);
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
            let known=images.clone(); let attachments=emitted.clone(); let bytes=image_bytes.clone();
            ctx.globals().set("__host",Function::new(ctx.clone(),move |js:Ctx<'_>,name:String,raw:String| -> rquickjs::Result<String> {
                if crate::agent::STOP.load(Ordering::SeqCst)||std::time::Instant::now()>=deadline||end.load(Ordering::SeqCst) {
                    return Err(Exception::throw_message(&js,"codejs cancelled, timed out, or run ended"));
                }
                if c.fetch_add(1,Ordering::SeqCst)>=CALL_MAX { return Err(Exception::throw_message(&js,"codejs host call limit (128)")); }
                let a:Value=serde_json::from_str(&raw).map_err(|_|Exception::throw_message(&js,"Invalid tool argument JSON"))?;
                if !a.is_object() { return Err(Exception::throw_message(&js,"Tool arguments must be an object")); }
                let mut out=match name.as_str() {
                    "image"=> {
                        let handle=a.get("image_handle").and_then(Value::as_str).ok_or_else(||Exception::throw_message(&js,"image requires a native image read result"))?;
                        let url=known.lock().unwrap().get(handle).cloned().ok_or_else(||Exception::throw_message(&js,"Unknown image handle"))?;
                        let mut attached=attachments.lock().unwrap();
                        if !attached.contains(&url) {
                            if attached.len()>=4 { return Err(Exception::throw_message(&js,"At most four emitted images")); }
                            attached.push(url);
                        }
                        json!({"output":"Image attached","returncode":0})
                    },
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
                if let Some(url)=if name=="read" {out.as_object_mut().and_then(|o|o.remove("image_url")).and_then(|v|v.as_str().map(str::to_owned))} else {None} {
                    let size=out.pointer("/extra/bytes").and_then(Value::as_u64).unwrap_or(u64::MAX);
                    if size>8*1024*1024 || bytes.load(Ordering::SeqCst)>8*1024*1024-size as usize {
                        return Err(Exception::throw_message(&js,"Image read budget: 8MB decoded total per execution"));
                    }
                    bytes.fetch_add(size as usize,Ordering::SeqCst);
                    let handle=crate::util_hex(24);
                    known.lock().unwrap().insert(handle.clone(),url);
                    out["image_handle"]=json!(handle);
                    out["output"]=json!("Native image read. Call image(result) to forward visual content to the model.");
                }
                Ok(out.to_string())
            })?)?;
            let cache=candidate.clone();
            ctx.globals().set("__state",Function::new(ctx.clone(),move |js:Ctx<'_>,mode:String,raw:String| -> rquickjs::Result<String> {
                if crate::agent::STOP.load(Ordering::SeqCst)||std::time::Instant::now()>=deadline {
                    return Err(Exception::throw_message(&js,"State access cancelled or timed out"));
                }
                if raw.len()>20*1024 {return Err(Exception::throw_message(&js,"State request exceeds 20KB"));}
                let args:Value=serde_json::from_str(&raw).map_err(|_|Exception::throw_message(&js,"Invalid state JSON"))?;
                let key=args.get("key").and_then(Value::as_str).filter(|s|!s.is_empty()&&s.len()<=128).ok_or_else(||Exception::throw_message(&js,"State key must be a non-empty string up to 128 bytes"))?;
                let mut store=cache.lock().unwrap();
                if mode=="load" {
                    return Ok(store.get(key).map(|v|json!({"found":true,"value":v})).unwrap_or(json!({"found":false})).to_string());
                }
                if mode!="store" {return Err(Exception::throw_message(&js,"Unknown state operation"));}
                if args.get("delete").and_then(Value::as_bool)==Some(true) {store.remove(key);return Ok("null".into());}
                let value=args.get("value").ok_or_else(||Exception::throw_message(&js,"Missing state value"))?;
                let size=value.to_string().len();
                if size>16*1024 {return Err(Exception::throw_message(&js,"State value exceeds 16KB JSON"));}
                if !store.contains_key(key)&&store.len()>=64 {return Err(Exception::throw_message(&js,"State limit: 64 keys"));}
                let total:usize=store.iter().filter(|(k,_)|k.as_str()!=key).map(|(k,v)|k.len()+v.to_string().len()).sum();
                if total+key.len()+size>128*1024 {return Err(Exception::throw_message(&js,"State exceeds 128KB total"));}
                store.insert(key.into(),value.clone());Ok("null".into())
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
                const state=globalThis.__state; delete globalThis.__state;
                globalThis.store=(key,value)=>{
                    if(typeof key!=='string') throw new TypeError('store key must be a string');
                    if(value===undefined) {state('store',JSON.stringify({key,delete:true}));return;}
                    const raw=JSON.stringify(value);
                    if(raw===undefined) throw new TypeError('store value must be JSON serializable');
                    state('store',JSON.stringify({key,value:JSON.parse(raw)}));
                };
                globalThis.load=key=>{
                    if(typeof key!=='string') throw new TypeError('load key must be a string');
                    const out=JSON.parse(state('load',JSON.stringify({key})));
                    return out.found?out.value:undefined;
                };
                globalThis.tools=Object.freeze(Object.fromEntries(['read','write','edit','bash'].map(name=>[name,async args=>{
                    const out=JSON.parse(bridge(name,JSON.stringify(args)));
                    if(out.returncode!==0) {const error=new Error(out.output||'Tool failed');error.observation=out;throw error;}
                    return out;
                }])));
                globalThis.image=async result=>JSON.parse(bridge('image',JSON.stringify(result)));
                // Pi-shaped text output: primitives use String, objects use JSON.
                // No inspection hooks, shell, or unbounded host log sink.
                const outputText=value=>{
                    if(value===null || (typeof value!=='object' && typeof value!=='function')) return String(value);
                    const json=JSON.stringify(value);
                    return json===undefined?String(value):json;
                };
                const writeText=(...values)=>emit(values.map(outputText).join(' '));
                globalThis.text=value=>emit(outputText(value));
                globalThis.print=writeText;
                globalThis.console=Object.freeze(Object.fromEntries(
                    ['log','info','warn','error','debug'].map(level=>[level,writeText])
                ));
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
    let result = run().and_then(|value| {
        if crate::agent::STOP.load(Ordering::SeqCst)||std::time::Instant::now()>=deadline||ended.load(Ordering::SeqCst) {
            Err("Execution cancelled, timed out, or environment ended; state not committed".into())
        } else {Ok(value)}
    });
    host.bash = std::mem::replace(&mut *bash.lock().unwrap(), Box::new(|_| Value::Null));
    let failed = result.is_err();
    if !failed { *state=candidate.lock().unwrap().clone(); }
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
    json!({"output":text,"returncode":i64::from(failed),"exception_info":if failed{text.clone()}else{String::new()},"extra":{"tool":"codejs","calls":calls.load(Ordering::SeqCst).min(CALL_MAX),"store_committed":!failed,"store_keys":state.len(),"wall_ms":started.elapsed().as_millis() as u64,"output_truncated":output_truncated},"image_urls":emitted.lock().unwrap().clone()})
}
