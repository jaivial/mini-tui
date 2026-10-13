//! Durable multi-project task graph with vector recall and lease-fenced workers.
//! Small task registries use exact cosine search, not an invented approximate index.
use rusqlite::{params, Connection, OptionalExtension, TransactionBehavior};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

fn error(e: impl std::fmt::Display) -> String {
    e.to_string()
}
fn now() -> i64 {
    crate::util::now() as i64
}
fn ident(s: &str) -> Result<(), String> {
    if s.is_empty()
        || s.len() > 128
        || !s
            .chars()
            .all(|c| c.is_ascii_alphanumeric() || "_-.:/".contains(c))
    {
        return Err("invalid task/project/owner identifier".into());
    }
    Ok(())
}
pub struct Store {
    db: Connection,
}
impl Store {
    pub fn open(path: &Path) -> Result<Self, String> {
        if let Some(parent) = path.parent().filter(|p| !p.as_os_str().is_empty()) {
            std::fs::create_dir_all(parent).map_err(error)?;
        }
        let db = Connection::open(path).map_err(error)?;
        use std::os::unix::fs::PermissionsExt;
        std::fs::set_permissions(path, std::fs::Permissions::from_mode(0o600)).map_err(error)?;
        db.busy_timeout(std::time::Duration::from_secs(5))
            .map_err(error)?;
        db.execute_batch("PRAGMA journal_mode=WAL; PRAGMA synchronous=FULL; PRAGMA foreign_keys=ON;
          CREATE TABLE IF NOT EXISTS task_nodes(
            id TEXT PRIMARY KEY, project TEXT NOT NULL, cwd TEXT NOT NULL, goal TEXT NOT NULL,
            priority INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL DEFAULT 'pending',
            owner TEXT, fence INTEGER NOT NULL DEFAULT 0, lease_until INTEGER,
            result TEXT, vector BLOB, created INTEGER NOT NULL, updated INTEGER NOT NULL);
          CREATE INDEX IF NOT EXISTS queue_ready ON task_nodes(status,priority,created);
          CREATE TABLE IF NOT EXISTS task_edges(
            task TEXT NOT NULL REFERENCES task_nodes(id), dependency TEXT NOT NULL REFERENCES task_nodes(id),
            PRIMARY KEY(task,dependency), CHECK(task != dependency));
          CREATE INDEX IF NOT EXISTS graph_reverse ON task_edges(dependency);
          CREATE TABLE IF NOT EXISTS registry_meta(key TEXT PRIMARY KEY, value TEXT NOT NULL);
          INSERT OR IGNORE INTO registry_meta VALUES('embedding_model','sentence-transformers/all-MiniLM-L6-v2:384');").map_err(error)?;
        db.execute_batch("BEGIN IMMEDIATE").map_err(error)?;
        let has_version = {
            let mut q = db.prepare("PRAGMA table_info(task_nodes)").map_err(error)?;
            let cols = q.query_map([], |r| r.get::<_, String>(1)).map_err(error)?;
            cols.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?.iter().any(|c| c == "goal_version")
        };
        if !has_version { db.execute_batch("ALTER TABLE task_nodes ADD COLUMN goal_version INTEGER NOT NULL DEFAULT 1;").map_err(error)?; }
        db.execute_batch("CREATE TABLE IF NOT EXISTS task_events(
          seq INTEGER PRIMARY KEY AUTOINCREMENT, task TEXT NOT NULL, kind TEXT NOT NULL,
          goal_version INTEGER NOT NULL, fence INTEGER NOT NULL, status TEXT NOT NULL, created INTEGER NOT NULL);
          CREATE TRIGGER IF NOT EXISTS queue_insert_event AFTER INSERT ON task_nodes BEGIN
            INSERT INTO task_events(task,kind,goal_version,fence,status,created) VALUES(new.id,'created',new.goal_version,new.fence,new.status,new.updated); END;
          CREATE TRIGGER IF NOT EXISTS queue_change_event AFTER UPDATE ON task_nodes
          WHEN old.status != new.status OR old.goal_version != new.goal_version OR old.fence != new.fence BEGIN
            INSERT INTO task_events(task,kind,goal_version,fence,status,created) VALUES(new.id,
              CASE WHEN old.goal_version != new.goal_version THEN 'goal_updated' ELSE 'state_changed' END,
              new.goal_version,new.fence,new.status,new.updated); END;").map_err(error)?;
        db.execute_batch("COMMIT").map_err(error)?;
        Ok(Self { db })
    }
    pub fn put(
        &mut self,
        id: &str,
        project: &str,
        cwd: &str,
        goal: &str,
        priority: i64,
        deps: &[String],
        vector: Option<&[f32]>,
    ) -> Result<(), String> {
        ident(id)?;
        ident(project)?;
        if goal.trim().is_empty() || goal.len() > 64_000 {
            return Err("goal must contain 1..64000 bytes".into());
        }
        let cwd = std::fs::canonicalize(cwd).map_err(error)?;
        if !cwd.is_dir() {
            return Err("project cwd is not a directory".into());
        }
        let vector = vector.map(pack).transpose()?;
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        let active: Option<String> = tx
            .query_row("SELECT status FROM task_nodes WHERE id=?1", [id], |r| {
                r.get(0)
            })
            .optional()
            .map_err(error)?;
        if active.as_deref().is_some_and(|s| s != "pending") {
            return Err("only pending tasks may be edited".into());
        }
        tx.execute("INSERT INTO task_nodes(id,project,cwd,goal,priority,vector,created,updated) VALUES(?1,?2,?3,?4,?5,?6,?7,?7)
          ON CONFLICT(id) DO UPDATE SET project=excluded.project,cwd=excluded.cwd,goal=excluded.goal,priority=excluded.priority,vector=excluded.vector,goal_version=task_nodes.goal_version+1,result=NULL,updated=excluded.updated",
          params![id,project,cwd.to_string_lossy(),goal,priority,vector,now()]).map_err(error)?;
        tx.execute("DELETE FROM task_edges WHERE task=?1", [id])
            .map_err(error)?;
        for dep in deps {
            ident(dep)?;
            tx.execute("INSERT INTO task_edges VALUES(?1,?2)", params![id, dep])
                .map_err(error)?;
            let cycle: bool = tx.query_row("WITH RECURSIVE reach(id) AS (SELECT dependency FROM task_edges WHERE task=?1 UNION SELECT e.dependency FROM task_edges e JOIN reach r ON e.task=r.id) SELECT EXISTS(SELECT 1 FROM reach WHERE id=?1)", [id], |r| r.get(0)).map_err(error)?;
            if cycle {
                return Err("task dependency cycle refused".into());
            }
        }
        tx.commit().map_err(error)
    }
    pub fn claim(&mut self, owner: &str, ttl: i64, limit: usize) -> Result<Vec<Value>, String> {
        ident(owner)?;
        if !(30..=86400).contains(&ttl) || !(1..=10).contains(&limit) {
            return Err("lease TTL 30..86400 seconds; parallel limit 1..10".into());
        }
        let tx = self
            .db
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .map_err(error)?;
        // Do not silently relaunch expired work: its process might still be running. Operator
        // reconciliation is required before retry, avoiding concurrent writes to a project.
        tx.execute("UPDATE task_nodes SET status='interrupted',updated=?1 WHERE status='running' AND lease_until<?1", [now()]).map_err(error)?;
        let tasks = {
            let mut stmt = tx.prepare("SELECT t.id,t.project,t.cwd,t.goal,t.fence,t.goal_version FROM task_nodes t WHERE t.status='pending'
              AND NOT EXISTS(SELECT 1 FROM task_edges e JOIN task_nodes d ON d.id=e.dependency WHERE e.task=t.id AND d.status!='done')
              AND NOT EXISTS(SELECT 1 FROM task_nodes r WHERE (r.project=t.project OR r.cwd=t.cwd OR substr(r.cwd,1,length(t.cwd)+1)=t.cwd||'/' OR substr(t.cwd,1,length(r.cwd)+1)=r.cwd||'/') AND r.status IN ('running','interrupted'))
              ORDER BY t.priority DESC,t.created,t.id").map_err(error)?;
            let rows = stmt
                .query_map([], |r| {
                    Ok((
                        r.get::<_, String>(0)?,
                        r.get::<_, String>(1)?,
                        r.get::<_, String>(2)?,
                        r.get::<_, String>(3)?,
                        r.get::<_, i64>(4)?,
                        r.get::<_, i64>(5)?,
                    ))
                })
                .map_err(error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?
        };
        let mut out = Vec::new();
        let mut cwds: Vec<PathBuf> = Vec::new();
        let mut projects = std::collections::BTreeSet::new();
        for (id, project, cwd, goal, fence, goal_version) in tasks {
            if out.len() == limit {
                break;
            }
            let path = PathBuf::from(&cwd);
            if projects.contains(&project)
                || cwds
                    .iter()
                    .any(|p| path.starts_with(p) || p.starts_with(&path))
            {
                continue;
            }
            projects.insert(project.clone());
            cwds.push(path);
            tx.execute("UPDATE task_nodes SET status='running',owner=?2,fence=fence+1,lease_until=?3,updated=?4 WHERE id=?1",params![id,owner,now()+ttl,now()]).map_err(error)?;
            out.push(json!({"id":id,"project":project,"cwd":cwd,"goal":goal,"owner":owner,"fence":fence+1,"goal_version":goal_version,"lease_until":now()+ttl}));
        }
        tx.commit().map_err(error)?;
        Ok(out)
    }
    pub fn finish(
        &self,
        id: &str,
        owner: &str,
        fence: i64,
        status: &str,
        result: &str,
    ) -> Result<(), String> {
        ident(id)?;
        ident(owner)?;
        if result.len() > 64_000 { return Err("task result exceeds 64000 bytes".into()); }
        if !matches!(status, "done" | "blocked") {
            return Err("finish requires done or blocked".into());
        }
        if status == "done" {
            let evidence: Value = serde_json::from_str(result).map_err(|_| "done requires structured closure evidence".to_string())?;
            let verdict = evidence.get("closure_verdict").unwrap_or(&Value::Null);
            let valid = verdict.get("complete").and_then(Value::as_bool) == Some(true)
                && verdict.get("score").and_then(Value::as_f64) == Some(100.0)
                && verdict.get("gaps").and_then(Value::as_array).is_some_and(Vec::is_empty)
                && evidence.get("closure_verified").and_then(Value::as_bool) == Some(true)
                && evidence.get("task_id").and_then(Value::as_str) == Some(id)
                && evidence.get("fence").and_then(Value::as_i64) == Some(fence)
                && evidence.get("trajectory").and_then(Value::as_str).is_some_and(|s| !s.is_empty());
            if !valid { return Err("done requires positive closure and task/fence/artifact binding".into()); }
            let version: i64 = self.db.query_row("SELECT goal_version FROM task_nodes WHERE id=?1", [id], |r| r.get(0)).map_err(error)?;
            if evidence.get("goal_version").and_then(Value::as_i64) != Some(version) {
                return Err("closure evidence is for a stale goal version".into());
            }
            let path = evidence["trajectory"].as_str().ok_or("missing trajectory")?;
            let file = std::fs::File::open(path).map_err(error)?;
            if !file.metadata().map_err(error)?.is_file() { return Err("trajectory is not a regular file".into()); }
            use std::io::Read;
            let mut bytes = Vec::new();
            file.take(64_000_001).read_to_end(&mut bytes).map_err(error)?;
            if bytes.len() > 64_000_000 { return Err("trajectory exceeds 64MB cap".into()); }
            let artifact: Value = serde_json::from_slice(&bytes).map_err(error)?;
            let binding = artifact.pointer("/info/queue_binding").ok_or("trajectory lacks queue binding")?;
            let actual = artifact.pointer("/info/goal_oracle/attempts").and_then(Value::as_array).and_then(|a| a.last());
            if binding.get("task_id").and_then(Value::as_str) != Some(id)
                || binding.get("fence").and_then(Value::as_i64) != Some(fence)
                || binding.get("goal_version").and_then(Value::as_i64) != Some(version)
                || actual != Some(verdict)
                || artifact.pointer("/info/exit_status").and_then(Value::as_str) != Some("Submitted") {
                return Err("trajectory does not back the current closure evidence".into());
            }
        }
        let n = self.db.execute("UPDATE task_nodes SET status=?4,result=?5,lease_until=NULL,owner=NULL,updated=?6 WHERE id=?1 AND owner=?2 AND fence=?3 AND status='running' AND lease_until>=?6",params![id,owner,fence,status,result,now()]).map_err(error)?;
        if n != 1 {
            return Err("stale lease or wrong owner: result not accepted".into());
        }
        Ok(())
    }
    pub fn heartbeat(&self, id: &str, owner: &str, fence: i64, ttl: i64) -> Result<(), String> {
        ident(id)?;
        ident(owner)?;
        if !(30..=86400).contains(&ttl) {
            return Err("invalid lease TTL".into());
        }
        let n = self.db.execute("UPDATE task_nodes SET lease_until=?4,updated=?5 WHERE id=?1 AND owner=?2 AND fence=?3 AND status='running' AND lease_until>=?5",params![id,owner,fence,now()+ttl,now()]).map_err(error)?;
        if n != 1 {
            return Err("stale lease cannot heartbeat".into());
        }
        Ok(())
    }
    pub fn retry(&self, id: &str) -> Result<(), String> {
        ident(id)?;
        let n=self.db.execute("UPDATE task_nodes SET status='pending',owner=NULL,lease_until=NULL,fence=fence+1,updated=?2 WHERE id=?1 AND status IN ('blocked','interrupted')",params![id,now()]).map_err(error)?;
        if n != 1 {
            return Err(
                "retry requires blocked/interrupted task and reconciliation of its worker".into(),
            );
        }
        Ok(())
    }
    pub fn events(&self, after: i64, limit: i64) -> Result<Value, String> {
        if after < 0 || !(1..=1000).contains(&limit) { return Err("events requires nonnegative cursor and limit 1..1000".into()); }
        let mut q = self.db.prepare("SELECT seq,task,kind,goal_version,fence,status,created FROM task_events WHERE seq>?1 ORDER BY seq LIMIT ?2").map_err(error)?;
        let rows = q.query_map(params![after,limit], |r| Ok(json!({"seq":r.get::<_,i64>(0)?,"task":r.get::<_,String>(1)?,"kind":r.get::<_,String>(2)?,"goal_version":r.get::<_,i64>(3)?,"fence":r.get::<_,i64>(4)?,"status":r.get::<_,String>(5)?,"created":r.get::<_,i64>(6)?}))).map_err(error)?;
        let events = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        let cursor = events.last().and_then(|e| e["seq"].as_i64()).unwrap_or(after);
        Ok(json!({"events":events,"cursor":cursor}))
    }
    pub fn graph(&self) -> Result<Value, String> {
        let has_version = self.db.prepare("SELECT goal_version FROM task_nodes LIMIT 0").is_ok();
        let sql = if has_version { "SELECT id,project,cwd,goal,priority,status,owner,fence,lease_until,result,goal_version FROM task_nodes ORDER BY created,id" }
            else { "SELECT id,project,cwd,goal,priority,status,owner,fence,lease_until,result,1 AS goal_version FROM task_nodes ORDER BY created,id" };
        let mut stmt=self.db.prepare(sql).map_err(error)?;
        let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"project":r.get::<_,String>(1)?,"cwd":r.get::<_,String>(2)?,"goal":r.get::<_,String>(3)?,"priority":r.get::<_,i64>(4)?,"status":r.get::<_,String>(5)?,"owner":r.get::<_,Option<String>>(6)?,"fence":r.get::<_,i64>(7)?,"lease_until":r.get::<_,Option<i64>>(8)?,"result":r.get::<_,Option<String>>(9)?,"goal_version":r.get::<_,i64>(10)?}))).map_err(error)?;
        let nodes = rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?;
        let mut stmt = self
            .db
            .prepare("SELECT task,dependency FROM task_edges ORDER BY task,dependency")
            .map_err(error)?;
        let edges = stmt
            .query_map([], |r| {
                Ok(json!({"task":r.get::<_,String>(0)?,"dependency":r.get::<_,String>(1)?}))
            })
            .map_err(error)?
            .collect::<rusqlite::Result<Vec<_>>>()
            .map_err(error)?;
        Ok(json!({"nodes":nodes,"edges":edges}))
    }
    pub fn search(&self, vector: &[f32], limit: usize) -> Result<Value, String> {
        pack(vector)?;
        let mut stmt = self
            .db
            .prepare(
                "SELECT id,project,goal,status,vector FROM task_nodes WHERE vector IS NOT NULL",
            )
            .map_err(error)?;
        let rows = stmt
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, String>(2)?,
                    r.get::<_, String>(3)?,
                    r.get::<_, Vec<u8>>(4)?,
                ))
            })
            .map_err(error)?;
        let mut out = Vec::new();
        let query_norm = vector.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
        if query_norm == 0.0 { return Err("query embedding has zero norm".into()); }
        for row in rows {
            let (id, project, goal, status, blob) = row.map_err(error)?;
            let v = unpack(&blob)?;
            let stored_norm = v.iter().map(|x| (*x as f64).powi(2)).sum::<f64>().sqrt();
            if stored_norm == 0.0 { continue; }
            let dot = vector.iter().zip(v.iter()).map(|(a, b)| *a as f64 * *b as f64).sum::<f64>();
            let score = (dot / (query_norm * stored_norm)).clamp(-1.0, 1.0) as f32;
            out.push((
                score,
                json!({"id":id,"project":project,"goal":goal,"status":status,"similarity":score}),
            ));
        }
        out.sort_by(|a, b| b.0.total_cmp(&a.0));
        Ok(
            json!({"results":out.into_iter().take(limit.clamp(1,100)).map(|(_,v)|v).collect::<Vec<_>>(),"search":"exact cosine","model":"all-MiniLM-L6-v2"}),
        )
    }
}
fn pack(v: &[f32]) -> Result<Vec<u8>, String> {
    if v.len() != 384 || v.iter().any(|x| !x.is_finite()) {
        return Err("expected 384 finite embedding values".into());
    }
    Ok(v.iter().flat_map(|x| x.to_le_bytes()).collect())
}
fn unpack(v: &[u8]) -> Result<Vec<f32>, String> {
    if v.len() != 384 * 4 {
        return Err("invalid stored vector length".into());
    }
    let out = v
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes(b.try_into().unwrap()))
        .collect::<Vec<_>>();
    if out.iter().any(|x| !x.is_finite()) {
        return Err("invalid stored vector".into());
    }
    Ok(out)
}

pub fn client(args: &[String]) -> i32 {
    match run(args) {
        Ok(v) => {
            println!("{v}");
            0
        }
        Err(e) => {
            eprintln!("queue: {e}");
            2
        }
    }
}
fn run(args: &[String]) -> Result<Value, String> {
    let cmd = args.first().map(String::as_str).unwrap_or("help");
    if matches!(cmd, "help" | "--help" | "-h") {
        return Ok(
            json!({"usage":"mini-agent-rs queue put|graph|events|search|run|claim|heartbeat|finish|retry --db PATH [--id ID --project PROJECT --cwd DIR --goal-file FILE --deps ID,ID --priority N --embed-dir DIR --owner OWNER --ttl SECONDS --limit N --fence N --status done|blocked --result-file FILE]"}),
        );
    }
    let mut flags = std::collections::BTreeMap::new();
    let mut i = 1;
    while i < args.len() {
        let key = &args[i];
        if !key.starts_with("--") {
            return Err(format!("unexpected argument {key}"));
        }
        let val = args
            .get(i + 1)
            .ok_or_else(|| format!("{key} requires a value"))?;
        if flags.insert(key.clone(), val.clone()).is_some() {
            return Err(format!("duplicate flag {key}"));
        }
        i += 2;
    }
    let get = |key: &str| {
        flags
            .get(key)
            .map(String::as_str)
            .ok_or_else(|| format!("missing {key}"))
    };
    let number = |key: &str, default: i64| -> Result<i64, String> {
        flags
            .get(key)
            .map(|s| s.parse().map_err(error))
            .unwrap_or(Ok(default))
    };
    let path = flags.get("--db").map(PathBuf::from).unwrap_or_else(|| {
        PathBuf::from(std::env::var("HOME").unwrap_or_default())
            .join(".local/share/mini-tui/task-graph.sqlite")
    });
    // The web projection must never create a registry or run schema migrations.
    if matches!(cmd, "graph-read" | "events-read") {
        let db = Connection::open_with_flags(&path, rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY).map_err(error)?;
        db.busy_timeout(std::time::Duration::from_secs(2)).map_err(error)?;
        return if cmd == "graph-read" { Store { db }.graph() } else { Store { db }.events(number("--after",0)?,number("--limit",100)?) };
    }
    let mut store = Store::open(&path)?;
    match cmd {
        "run" => {
            let run_dir = flags
                .get("--run-dir")
                .map(PathBuf::from)
                .unwrap_or_else(|| path.parent().unwrap_or(Path::new(".")).join("queue-runs"));
            let mut waves = Vec::new();
            loop {
                let wave = execute_wave(
                    &mut store,
                    &path,
                    get("--owner")?,
                    number("--limit", 2)?.clamp(1, 4) as usize,
                    number("--ttl", 600)?,
                    &run_dir,
                )?;
                if wave
                    .get("completed_wave")
                    .and_then(Value::as_array)
                    .is_none_or(|a| a.is_empty())
                {
                    break;
                }
                waves.push(wave);
                if crate::agent::STOP.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
            }
            Ok(json!({"waves":waves,"graph":store.graph()?}))
        }
        "graph" => store.graph(),
        "put" => {
            let goal = std::fs::read_to_string(get("--goal-file")?).map_err(error)?;
            let deps = flags
                .get("--deps")
                .map(|s| {
                    s.split(',')
                        .filter(|s| !s.is_empty())
                        .map(String::from)
                        .collect::<Vec<_>>()
                })
                .unwrap_or_default();
            let vector = match flags.get("--embed-dir") {
                Some(dir) => {
                    Some(crate::graph_embed::Embedder::load(Path::new(dir))?.embed(&goal)?)
                }
                None => None,
            };
            store.put(
                get("--id")?,
                get("--project")?,
                get("--cwd")?,
                &goal,
                number("--priority", 0)?,
                &deps,
                vector.as_deref(),
            )?;
            Ok(json!({"stored":get("--id")?,"embedded":vector.is_some()}))
        }
        "search" => {
            let text = std::fs::read_to_string(get("--query-file")?).map_err(error)?;
            let vector =
                crate::graph_embed::Embedder::load(Path::new(get("--embed-dir")?))?.embed(&text)?;
            store.search(&vector, number("--limit", 10)?.max(1) as usize)
        }
        "events" => store.events(number("--after",0)?,number("--limit",100)?),
        "claim" => Ok(
            json!({"claimed":store.claim(get("--owner")?,number("--ttl",600)?,number("--limit",2)?.max(1) as usize)?}),
        ),
        "heartbeat" => {
            store.heartbeat(
                get("--id")?,
                get("--owner")?,
                number("--fence", -1)?,
                number("--ttl", 600)?,
            )?;
            Ok(json!({"renewed":true}))
        }
        "finish" => {
            let result = std::fs::read_to_string(get("--result-file")?).map_err(error)?;
            store.finish(
                get("--id")?,
                get("--owner")?,
                number("--fence", -1)?,
                get("--status")?,
                &result,
            )?;
            Ok(json!({"finished":true}))
        }
        "retry" => {
            if get("--reconciled")? != "yes" {
                return Err(
                    "retry requires --reconciled yes after checking the previous worker is stopped"
                        .into(),
                );
            }
            store.retry(get("--id")?)?;
            Ok(json!({"requeued":true}))
        }
        _ => Err(format!("unknown queue command {cmd}")),
    }
}

fn execute_wave(
    store: &mut Store,
    db: &Path,
    owner: &str,
    limit: usize,
    ttl: i64,
    run_dir: &Path,
) -> Result<Value, String> {
    use std::os::unix::process::CommandExt;
    use std::sync::atomic::Ordering;
    std::fs::create_dir_all(run_dir).map_err(error)?;
    let db = std::fs::canonicalize(db).map_err(error)?;
    let run_dir = std::fs::canonicalize(run_dir).map_err(error)?;
    if crate::agent::STOP.load(Ordering::SeqCst) { return Ok(json!({"completed_wave":[]})); }
    let tasks = store.claim(owner, ttl, limit)?;
    let mut workers = Vec::new();
    for task in tasks {
        let db = db.to_path_buf();
        let run_dir = run_dir.to_path_buf();
        workers.push(std::thread::spawn(move || -> Result<Value,String>{
            let id=task["id"].as_str().ok_or("missing task id")?;
            let owner=task["owner"].as_str().ok_or("missing lease owner")?;
            let fence=task["fence"].as_i64().ok_or("missing fence")?;
            // Identifier is not used as a filesystem path (slashes are legal task IDs).
            let output=run_dir.join(format!("{}-{fence}.json",crate::util_hex(16)));
            let log=std::fs::File::create(output.with_extension("log")).map_err(error)?;
            let mut cmd=std::process::Command::new(std::env::current_exe().map_err(error)?);
            cmd.args(["-y","--exit-immediately","-c","mini.yaml","-o"])
                .arg(&output).arg("-t").arg(task["goal"].as_str().ok_or("missing goal")?)
                .current_dir(task["cwd"].as_str().ok_or("missing cwd")?)
                .stdin(std::process::Stdio::null()).stdout(log.try_clone().map_err(error)?).stderr(log);
            if let Ok(model)=std::env::var("MINI_AGENT_QUEUE_MODEL"){if !model.is_empty(){cmd.arg("-m").arg(model);}}
            cmd.env("MINI_QUEUE_TASK_ID", id).env("MINI_QUEUE_FENCE", fence.to_string())
                .env("MINI_QUEUE_GOAL_VERSION", task["goal_version"].as_i64().ok_or("missing goal version")?.to_string());
            cmd.env_remove("MSWEA_CONTROL_FILE").env_remove("MINI_AGENT_SOCKET").env_remove("MINI_AGENT_PARENT_SOCKET").env_remove("MINI_AGENT_NAME");
            unsafe {cmd.pre_exec(||{if libc::setpgid(0,0)!=0{return Err(std::io::Error::last_os_error());}Ok(())});}
            let store=Store::open(&db)?;
            let mut child=match cmd.spawn(){Ok(c)=>c,Err(e)=>{store.finish(id,owner,fence,"blocked",&format!("spawn failed: {e}"))?;return Err(error(e));}};
            let mut beat=std::time::Instant::now();
            let exit=loop {
                if crate::agent::STOP.load(Ordering::SeqCst){
                    unsafe{libc::killpg(child.id() as i32,libc::SIGTERM);}
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    unsafe{libc::killpg(child.id() as i32,libc::SIGKILL);}
                    let _=child.wait();store.finish(id,owner,fence,"blocked","queue worker cancelled")?;
                    return Ok(json!({"id":id,"status":"blocked","reason":"cancelled"}));
                }
                if let Some(status)=child.try_wait().map_err(error)?{break status;}
                if beat.elapsed().as_secs() >= (ttl/3) as u64 {
                    if let Err(e)=store.heartbeat(id,owner,fence,ttl){
                        unsafe{libc::killpg(child.id() as i32,libc::SIGTERM);}
                        std::thread::sleep(std::time::Duration::from_millis(500));
                        unsafe{libc::killpg(child.id() as i32,libc::SIGKILL);}
                        let _=child.wait();return Err(e);
                    }
                    beat=std::time::Instant::now();
                }
                std::thread::sleep(std::time::Duration::from_millis(200));
            };
            let trajectory:Value=std::fs::read_to_string(&output).ok().and_then(|s|serde_json::from_str(&s).ok()).unwrap_or(Value::Null);
            // A worker may run with its oracle disabled. Submitted alone is a
            // proposal; dependent tasks must wait for a recorded positive verdict.
            let closure = trajectory.pointer("/info/goal_oracle/attempts")
                .and_then(Value::as_array).and_then(|a| a.last());
            let verified = closure.is_some_and(|v|
                v.get("complete").and_then(Value::as_bool) == Some(true)
                && v.get("score").and_then(Value::as_f64) == Some(100.0)
                && v.get("gaps").and_then(Value::as_array).is_some_and(Vec::is_empty));
            let status=if exit.success() && verified && trajectory.pointer("/info/exit_status").and_then(Value::as_str)==Some("Submitted"){"done"}else{"blocked"};
            let result=json!({"task_id":id,"fence":fence,"goal_version":task["goal_version"],"trajectory":output,"exit":exit.code(),"exit_status":trajectory.pointer("/info/exit_status"),"submission":trajectory.pointer("/info/submission"),"closure_verified":verified,"closure_verdict":closure,"provisional":trajectory.pointer("/info/goal_oracle/provisional")});
            store.finish(id,owner,fence,status,&result.to_string())?;
            Ok(json!({"id":id,"status":status,"result":result}))
        }));
    }
    // Threads and subprocesses are joined; no orphaned background jobs. The caller can launch
    // this CLI as a managed background service while its conversation keeps moving.
    let mut results = Vec::new();
    for worker in workers {
        results.push(match worker.join() {
            Ok(Ok(v)) => v,
            Ok(Err(e)) => json!({"error":e}),
            Err(_) => json!({"error":"queue worker panicked; reconcile interrupted lease"}),
        });
    }
    Ok(json!({"completed_wave":results}))
}

// The ordinary runner's SIGTERM handler re-raises immediately. Queue workers need time to
// terminate their own process groups and close leases first, so the queue only sets STOP.
extern "C" fn stop_queue(_: libc::c_int) {
    crate::agent::STOP.store(true, std::sync::atomic::Ordering::SeqCst);
}
pub fn install_signals() {
    unsafe {
        let mut action: libc::sigaction = std::mem::zeroed();
        action.sa_sigaction = stop_queue as extern "C" fn(libc::c_int) as libc::sighandler_t;
        libc::sigemptyset(&mut action.sa_mask);
        libc::sigaction(libc::SIGINT, &action, std::ptr::null_mut());
        libc::sigaction(libc::SIGTERM, &action, std::ptr::null_mut());
    }
}
