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

/// `/proc/<pid>/stat` fields 3 (state) and 22 (start time, in clock ticks since boot). `comm`
/// (field 2) may contain spaces and parentheses, so parsing starts after the LAST `)`.
fn proc_stat(pid: i64) -> Option<(char, u64)> {
    let stat = std::fs::read_to_string(format!("/proc/{pid}/stat")).ok()?;
    let mut fields = stat.rsplit_once(')')?.1.split_whitespace();
    let state = fields.next()?.chars().next()?;
    // Fields 3..=21 were skipped by the iterator above plus this `nth`: field 22 is the start.
    Some((state, fields.nth(18)?.parse().ok()?))
}

/// The boot id changes on every reboot: a lease recorded under a different one cannot have a
/// live worker, because the machine that would have run it no longer exists.
fn boot_id() -> String {
    std::fs::read_to_string("/proc/sys/kernel/random/boot_id")
        .map(|s| s.trim().to_string())
        .unwrap_or_default()
}

/// What can be *proved* about the worker behind an expired lease.
#[derive(PartialEq)]
enum Worker {
    Alive,
    /// Nothing can write for this fence any more: the process is gone, its pid was recycled by
    /// an unrelated one, it is a zombie, or the machine rebooted under it.
    Gone,
    /// Never recorded, or the evidence is unreadable. Nothing is proven either way.
    Unknown,
}

/// One running card whose lease has run out, together with the identity of its worker.
struct Expired {
    id: String,
    pid: Option<i64>,
    start: Option<i64>,
    boot: Option<String>,
}

fn worker_state(pid: Option<i64>, start: Option<i64>, recorded_boot: Option<&str>) -> Worker {
    let (Some(pid), Some(start), Some(recorded_boot)) = (pid, start, recorded_boot) else {
        return Worker::Unknown;
    };
    let current = boot_id();
    if current.is_empty() {
        // Without /proc there is no evidence at all, and "the process is gone" would be an
        // assumption that relaunches work. Only a positive proof may requeue a card.
        return Worker::Unknown;
    }
    if !recorded_boot.is_empty() && recorded_boot != current {
        return Worker::Gone;
    }
    // A pid that /proc cannot describe at all is only "gone" if /proc works and the entry is
    // missing -- which is what the boot-id guard above just established.
    match proc_stat(pid) {
        None => Worker::Gone,
        // A zombie has already exited; it cannot write to the project any more.
        Some(('Z', _)) => Worker::Gone,
        Some((_, ticks)) if ticks as i64 == start => Worker::Alive,
        // Same pid, different start time: the number was recycled by another process.
        Some(_) => Worker::Gone,
    }
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
        // A lease is only safe to requeue automatically if we can prove its worker is gone, so
        // the claim records the worker's identity (pid + start time + boot) with the lease.
        // Rows claimed before this column existed carry no identity and keep the old behaviour.
        let has_identity = {
            let mut q = db.prepare("PRAGMA table_info(task_nodes)").map_err(error)?;
            let cols = q.query_map([], |r| r.get::<_, String>(1)).map_err(error)?;
            cols.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?.iter().any(|c| c == "worker_pid")
        };
        if !has_identity {
            db.execute_batch("ALTER TABLE task_nodes ADD COLUMN worker_pid INTEGER;
              ALTER TABLE task_nodes ADD COLUMN worker_start INTEGER;
              ALTER TABLE task_nodes ADD COLUMN worker_boot TEXT;").map_err(error)?;
        }
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
        // An expired lease is not the same as a dead worker. Relaunching work whose process is
        // still alive would give two writers to one project, so the operator reconciles that
        // case. But when the worker is *provably* gone -- the machine rebooted under it, its
        // pid is gone or was recycled, it is a zombie -- there is nobody left to reconcile and
        // nothing to protect: the card goes back to `pending` for the next wave by itself.
        // Freezing those cards until a human typed `retry --reconciled yes` is what left a
        // whole project tree stuck after an OOM kill or a reboot, with no alive worker at all.
        let expired: Vec<Expired> = {
            let mut stmt = tx.prepare("SELECT id,worker_pid,worker_start,worker_boot FROM task_nodes WHERE status='running' AND lease_until<?1").map_err(error)?;
            let rows = stmt.query_map([now()], |r| Ok(Expired { id: r.get(0)?, pid: r.get(1)?, start: r.get(2)?, boot: r.get(3)? }))
                .map_err(error)?;
            rows.collect::<rusqlite::Result<Vec<_>>>().map_err(error)?
        };
        for Expired { id, pid, start, boot } in expired {
            match worker_state(pid, start, boot.as_deref()) {
                Worker::Gone => {
                    tx.execute("UPDATE task_nodes SET status='pending',owner=NULL,lease_until=NULL,result=NULL,fence=fence+1,updated=?4 WHERE id=?1 AND status='running'",
                        params![id, now(), now(), now()]).map_err(error)?;
                    // The generic status trigger already records `running -> pending`; this row
                    // says WHY it happened without an operator, which is the whole point.
                    tx.execute("INSERT INTO task_events(task,kind,goal_version,fence,status,created)
                        SELECT id,'lease_expired_worker_gone',goal_version,fence,status,?2 FROM task_nodes WHERE id=?1",
                        params![id, now()]).map_err(error)?;
                }
                _ => {
                    tx.execute("UPDATE task_nodes SET status='interrupted',updated=?2 WHERE id=?1 AND status='running'",
                        params![id, now()]).map_err(error)?;
                }
            }
        }
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
    /// Record which process holds this lease. The pid alone is not identity (the kernel recycles
    /// pids), so the process start time and the boot id are stored with it; a card claimed by a
    /// binary without this column keeps NULLs and is never auto-requeued.
    pub fn bind_worker(&self, id: &str, owner: &str, fence: i64, pid: i64) -> Result<(), String> {
        ident(id)?;
        ident(owner)?;
        let start = proc_stat(pid).map(|(_, ticks)| ticks as i64);
        if start.is_none() {
            return Err("worker process is not readable; refusing an unverifiable lease".into());
        }
        let n = self.db.execute("UPDATE task_nodes SET worker_pid=?4,worker_start=?5,worker_boot=?6,updated=?7
            WHERE id=?1 AND owner=?2 AND fence=?3 AND status='running' AND lease_until>=?7",
            params![id,owner,fence,pid,start,boot_id(),now()]).map_err(error)?;
        if n != 1 {
            return Err("stale lease or wrong owner: worker not bound".into());
        }
        Ok(())
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
    /// Hand a lease this process itself owns and has already terminated back to the queue.
    ///
    /// Only the runner's own shutdown path calls this: it killed and reaped the worker process
    /// group itself, so no other process can write for this fence any more. The card returns to
    /// `pending` for the next wave. `blocked` would be a lie: it discards the work and demands a
    /// manual `retry --reconciled yes` for what is really "the runner was restarted". The fence is
    /// bumped so the dead worker cannot finish, heartbeat or re-claim anything.
    pub fn release(&self, id: &str, owner: &str, fence: i64) -> Result<(), String> {
        ident(id)?;
        ident(owner)?;
        let n = self.db.execute("UPDATE task_nodes SET status='pending',result=NULL,owner=NULL,lease_until=NULL,fence=fence+1,updated=?4 WHERE id=?1 AND owner=?2 AND fence=?3 AND status='running' AND lease_until>=?4",params![id,owner,fence,now()]).map_err(error)?;
        if n != 1 {
            return Err("stale lease or wrong owner: card not requeued".into());
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
        let n=self.db.execute("UPDATE task_nodes SET status='pending',owner=NULL,lease_until=NULL,result=NULL,fence=fence+1,updated=?2 WHERE id=?1 AND status IN ('blocked','interrupted')",params![id,now()]).map_err(error)?;
        if n != 1 {
            return Err(
                "retry requires blocked/interrupted task and reconciliation of its worker".into(),
            );
        }
        Ok(())
    }
    /// Explicit task identity, never similarity-only routing. Running amendments
    /// fence the old worker and remain interrupted until its process is reconciled.
    pub fn amend(&self, id: &str, expected: i64, addition: &str) -> Result<(), String> {
        ident(id)?;
        if addition.trim().is_empty() || addition.len() > 64_000 { return Err("amendment requires 1..64000 bytes".into()); }
        let n = self.db.execute("UPDATE task_nodes SET goal=goal||char(10)||?3,goal_version=goal_version+1,vector=NULL,result=NULL,
            status=CASE WHEN status='running' THEN 'interrupted' ELSE status END,
            fence=CASE WHEN status='running' THEN fence+1 ELSE fence END,updated=?4
            WHERE id=?1 AND goal_version=?2 AND status IN ('pending','running','blocked','interrupted') AND length(CAST(goal AS BLOB))+length(CAST(?3 AS BLOB))+1<=64000",
            params![id,expected,addition,now()]).map_err(error)?;
        if n != 1 { return Err("amend refused: stale version, closed task, missing task or combined goal over64KB".into()); }
        Ok(())
    }
    pub fn cancel(&self, id: &str, expected: i64) -> Result<(), String> {
        ident(id)?;
        let n = self.db.execute("UPDATE task_nodes SET status=CASE WHEN status='running' THEN 'interrupted' ELSE 'cancelled' END,
            fence=fence+1,result=CASE WHEN status='running' THEN 'cancel requested; reconcile any running worker before retry' ELSE NULL END,updated=?3
            WHERE id=?1 AND goal_version=?2 AND status IN ('pending','running','blocked')", params![id,expected,now()]).map_err(error)?;
        if n != 1 { return Err("cancel refused: stale version or task not cancellable".into()); }
        Ok(())
    }
    pub fn reconcile_cancel(&self, id: &str, expected: i64) -> Result<(), String> {
        ident(id)?;
        let n = self.db.execute("UPDATE task_nodes SET status='cancelled',owner=NULL,lease_until=NULL,fence=fence+1,updated=?3
            WHERE id=?1 AND goal_version=?2 AND status='interrupted'", params![id,expected,now()]).map_err(error)?;
        if n != 1 { return Err("cancel reconciliation requires current interrupted task".into()); }
        Ok(())
    }
    fn lease_current(&self, id: &str, owner: &str, fence: i64, version: i64) -> Result<bool,String> {
        self.db.query_row("SELECT EXISTS(SELECT 1 FROM task_nodes WHERE id=?1 AND owner=?2 AND fence=?3 AND goal_version=?4 AND status='running' AND lease_until>=?5)",
            params![id,owner,fence,version,now()], |r| r.get(0)).map_err(error)
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
        // `worker_pid` is exposed because it is the only way to answer "is the process behind
        // this lease still alive?" from outside. Old databases without the column select NULL.
        let has_worker = self.db.prepare("SELECT worker_pid FROM task_nodes LIMIT 0").is_ok();
        let pid = if has_worker { "worker_pid" } else { "NULL AS worker_pid" };
        let sql = if has_version { format!("SELECT id,project,cwd,goal,priority,status,owner,fence,lease_until,result,goal_version,{pid} FROM task_nodes ORDER BY created,id") }
            else { format!("SELECT id,project,cwd,goal,priority,status,owner,fence,lease_until,result,1 AS goal_version,{pid} FROM task_nodes ORDER BY created,id") };
        let mut stmt=self.db.prepare(&sql).map_err(error)?;
        let rows=stmt.query_map([],|r|Ok(json!({"id":r.get::<_,String>(0)?,"project":r.get::<_,String>(1)?,"cwd":r.get::<_,String>(2)?,"goal":r.get::<_,String>(3)?,"priority":r.get::<_,i64>(4)?,"status":r.get::<_,String>(5)?,"owner":r.get::<_,Option<String>>(6)?,"fence":r.get::<_,i64>(7)?,"lease_until":r.get::<_,Option<i64>>(8)?,"result":r.get::<_,Option<String>>(9)?,"goal_version":r.get::<_,i64>(10)?,"worker_pid":r.get::<_,Option<i64>>(11)?}))).map_err(error)?;
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
            json!({"usage":"mini-agent-rs queue put|amend|cancel|cancel-reconcile|graph|tree|events|search|run|claim|heartbeat|release|finish|retry --db PATH [--run-dir DIR --max-depth N --id ID --project PROJECT --cwd DIR --goal-file FILE --deps ID,ID --priority N --embed-dir DIR --owner OWNER --ttl SECONDS --limit N --fence N --status done|blocked --result-file FILE]  ·  tree reads subagents/index.json under --run-dir (delegation hierarchy, read-only)"}),
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
    // Same for the delegation tree: it reads the filesystem, and must not touch any database.
    if cmd == "tree" {
        return tree(Path::new(get("--run-dir")?), number("--max-depth", 32)?.clamp(1, 64) as u32);
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
        "amend" => {
            let addition=std::fs::read_to_string(get("--goal-file")?).map_err(error)?;
            store.amend(get("--id")?,number("--goal-version",-1)?,&addition)?;
            Ok(json!({"amended":true,"worker_reconciliation_required":true}))
        },
        "cancel-reconcile" => {
            if get("--reconciled")? != "yes" { return Err("cancel-reconcile requires --reconciled yes after verifying worker is stopped".into()); }
            store.reconcile_cancel(get("--id")?,number("--goal-version",-1)?)?;
            Ok(json!({"cancelled":true}))
        },
        "cancel" => { store.cancel(get("--id")?,number("--goal-version",-1)?)?; Ok(json!({"cancel_requested":true})) },
        // Test-only hooks, refused unless the caller opts in explicitly. `bind-worker` could
        // otherwise point a card at a dead pid and make the sweep relaunch work that is still
        // being written -- the exact double-write this feature exists to prevent. They are not
        // part of the operator surface for that reason.
        "expire" | "bind-worker" | "unbind-worker" | "set-worker-start" => {
            if std::env::var("MINI_AGENT_QUEUE_TEST_HOOKS").as_deref() != Ok("yes") {
                return Err(format!("{cmd} is a test-only hook; set MINI_AGENT_QUEUE_TEST_HOOKS=yes to use it"));
            }
            match cmd {
                "expire" => {
                    let at = number("--at", -1)?;
                    let n = store.db.execute("UPDATE task_nodes SET lease_until=?2 WHERE id=?1 AND status='running'", params![get("--id")?, at]).map_err(error)?;
                    if n != 1 { return Err("expire requires a running card".into()); }
                    Ok(json!({"expired": true, "lease_until": at}))
                }
                "bind-worker" => {
                    let pid = number("--pid", std::process::id() as i64)?;
                    store.bind_worker(get("--id")?, get("--owner")?, number("--fence", -1)?, pid)?;
                    Ok(json!({"worker_pid": pid}))
                }
                "unbind-worker" => {
                    store.db.execute("UPDATE task_nodes SET worker_pid=NULL,worker_start=NULL,worker_boot=NULL WHERE id=?1", [get("--id")?]).map_err(error)?;
                    Ok(json!({"unbound": true}))
                }
                _ => {
                    store.db.execute("UPDATE task_nodes SET worker_start=?2 WHERE id=?1", params![get("--id")?, number("--start", -1)?]).map_err(error)?;
                    Ok(json!({"worker_start": number("--start", -1)?}))
                }
            }
        }
        "events" => store.events(number("--after",0)?,number("--limit",100)?),
        "claim" => Ok(
            json!({"claimed":store.claim(get("--owner")?,number("--ttl",600)?,number("--limit",2)?.max(1) as usize)?}),
        ),
        "release" => {
            store.release(get("--id")?, get("--owner")?, number("--fence", -1)?)?;
            Ok(json!({"released": true, "status": "pending"}))
        }
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

/// The delegation tree of one run, read from disk: every run writes `subagents/index.json`
/// (its live children: name, state, pid, model, cost), and each child's own run dir holds the
/// same record for its own children. Walking it gives who is a child of whom at any depth,
/// without a writer anywhere but the run itself. Read-only; crashes at worst leave a stale
/// `state` (the `pid` lets the reader tell), never a wrong parent link.
fn tree(run_dir: &Path, max_depth: u32) -> Result<Value, String> {
    let index_path = |dir: &Path| dir.join("subagents").join("index.json");
    if !index_path(run_dir).is_file() {
        return Err(format!(
            "no subagents/index.json under {}: this run delegated nothing (or it is not a run dir)",
            run_dir.display()
        ));
    }
    fn read_index(dir: &Path) -> Result<Value, String> {
        let text = std::fs::read_to_string(dir.join("subagents").join("index.json")).map_err(error)?;
        serde_json::from_str(&text).map_err(error)
    }
    fn index_exists(dir: &Path) -> bool {
        dir.join("subagents").join("index.json").is_file()
    }
    fn walk(dir: &Path, depth: u32, max_depth: u32) -> Value {
        let (parent_pid, children) = match read_index(dir) {
            Ok(v) => (
                v.get("parent_pid").cloned().unwrap_or(json!(0)),
                v.get("children").and_then(Value::as_array).cloned().unwrap_or_default(),
            ),
            Err(_) => (json!(0), vec![]),
        };
        let children = children
            .iter()
            .map(|c| {
                let mut node = json!({
                    "name": c.get("name").cloned().unwrap_or(json!("")),
                    "state": c.get("state").cloned().unwrap_or(json!("")),
                    "exit_status": c.get("exit_status").cloned().unwrap_or(json!("")),
                    "pid": c.get("pid").cloned().unwrap_or(json!(0)),
                    "model": c.get("model").cloned().unwrap_or(json!("")),
                    "cost": c.get("cost").cloned().unwrap_or(json!(0.0)),
                    "task": c.get("task").cloned().unwrap_or(json!("")),
                    "depth": depth,
                });
                // Recurse into the child's own run dir while there is depth left. Its traj is
                // `<run>/subagents/<name>/traj.json`, so its run dir is that traj's parent.
                if depth < max_depth {
                    if let Some(traj) = c.get("traj_path").and_then(Value::as_str) {
                        let child_dir = Path::new(traj).parent().unwrap_or(Path::new(".")).to_path_buf();
                        if index_exists(&child_dir) {
                            let sub = walk(&child_dir, depth + 1, max_depth);
                            node["parent_pid"] = sub["parent_pid"].clone();
                            node["children"] = sub["children"].clone();
                        }
                    }
                }
                node
            })
            .collect::<Vec<_>>();
        json!({"parent_pid": parent_pid, "children": children})
    }
    let mut root = walk(run_dir, 0, max_depth);
    root["run_dir"] = json!(run_dir.display().to_string());
    Ok(root)
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
            // Bind the lease to the process that actually does the work, so a later claim can
            // tell "the lease expired but the worker is still writing" from "the worker is
            // provably gone". Without this identity every expiry looks identical and the only
            // safe-looking transition is the one that needs a human.
            if let Err(e)=store.bind_worker(id,owner,fence,child.id() as i64){
                unsafe{libc::killpg(child.id() as i32,libc::SIGTERM);}
                std::thread::sleep(std::time::Duration::from_millis(500));
                unsafe{libc::killpg(child.id() as i32,libc::SIGKILL);}
                let _=child.wait();
                return Err(e);
            }
            let mut beat=std::time::Instant::now();
            let mut lease_check=std::time::Instant::now();
            let exit=loop {
                if lease_check.elapsed().as_secs() >= 1 {
                    match store.lease_current(id,owner,fence,task["goal_version"].as_i64().ok_or("missing goal version")?) {
                        Ok(true) => {},
                        state => {
                            unsafe{libc::killpg(child.id() as i32,libc::SIGTERM);}
                            std::thread::sleep(std::time::Duration::from_millis(500));
                            unsafe{libc::killpg(child.id() as i32,libc::SIGKILL);}
                            let _=child.wait();
                            return match state { Ok(false) => Ok(json!({"id":id,"status":"interrupted","reason":"lease revoked, cancelled or goal amended; worker stopped"})), Err(e) => Err(e), _ => unreachable!() };
                        }
                    }
                    lease_check=std::time::Instant::now();
                }
                if crate::agent::STOP.load(Ordering::SeqCst){
                    unsafe{libc::killpg(child.id() as i32,libc::SIGTERM);}
                    std::thread::sleep(std::time::Duration::from_millis(500));
                    unsafe{libc::killpg(child.id() as i32,libc::SIGKILL);}
                    let _=child.wait();
                    // The runner killed and reaped this worker itself, so the worker is provably
                    // stopped and the lease can be handed back without an operator: the card stays
                    // `pending` and the next wave picks it up again. Marking it `blocked` threw the
                    // work away on every restart of the lane (a deploy), for no reason.
                    return match store.release(id,owner,fence){
                        Ok(())=>Ok(json!({"id":id,"status":"pending","reason":"runner stopped; lease released for the next wave"})),
                        Err(e)=>Ok(json!({"id":id,"status":"running","reason":"runner stopped but the lease was already invalid; the next claim marks it interrupted","error":e})),
                    };
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
