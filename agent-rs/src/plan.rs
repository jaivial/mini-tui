//! The DAG plan the hub executes (`<traj dir>/subagents/plan.json`).
//!
//! The parent plans and reviews; the hub's scheduler launches each task the moment its
//! dependencies are satisfied (Fase 2 of docs/orchestration-plan.md). Tasks carry their budget and
//! the artifacts they commit to leave on disk; successors inherit both (handoff).

use crate::subagents::valid_name;
use serde_json::{json, Value};
use std::collections::BTreeMap;

/// Where a task sits: `pending -> ready -> running -> review -> done`, or `failed`/`blocked`.
/// Deps in `review` or `done` satisfy a successor: it launches at once (the parent reviews later).
pub const SATISFIED: &[&str] = &["review", "done"];

#[derive(Clone, Debug)]
pub struct Task {
    pub id: String,
    pub title: String,
    pub task: String,
    pub deps: Vec<String>,
    pub group: String,
    pub priority: i64,
    pub steps: i64,
    pub cost: f64,
    pub artifacts: Vec<String>,
    pub status: String,
    /// The result shown in handoffs and `plan show` (the child's answer or failure reason).
    pub result: String,
    pub error: String,
}

impl Task {
    fn from_value(v: &Value) -> Result<Task, String> {
        let id = v.get("id").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if !valid_name(&id) {
            return Err(format!("task id {id:?}: letters, digits, '.', '_' or '-' (it becomes the subagent's name)"));
        }
        let task = v.get("task").and_then(Value::as_str).unwrap_or("").trim().to_string();
        if task.is_empty() {
            return Err(format!("task {id}: empty task"));
        }
        let budget = v.get("budget");
        Ok(Task {
            id,
            title: v.get("title").and_then(Value::as_str).unwrap_or("").to_string(),
            task,
            deps: v.get("deps").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default(),
            group: v.get("group").and_then(Value::as_str).unwrap_or("").to_string(),
            priority: v.get("priority").and_then(Value::as_i64).unwrap_or(0),
            steps: budget.and_then(|b| b.get("steps")).and_then(Value::as_i64).unwrap_or(0),
            cost: budget.and_then(|b| b.get("cost")).and_then(Value::as_f64).unwrap_or(0.0),
            artifacts: v.get("artifacts").and_then(Value::as_array).map(|a| a.iter().filter_map(Value::as_str).map(String::from).collect()).unwrap_or_default(),
            status: v.get("status").and_then(Value::as_str).unwrap_or("pending").to_string(),
            result: v.get("result").and_then(Value::as_str).unwrap_or("").to_string(),
            error: v.get("error").and_then(Value::as_str).unwrap_or("").to_string(),
        })
    }

    pub fn to_value(&self) -> Value {
        let mut v = json!({
            "id": self.id,
            "title": self.title,
            "task": self.task,
            "deps": self.deps,
            "priority": self.priority,
            "budget": {"steps": self.steps, "cost": self.cost},
            "artifacts": self.artifacts,
            "status": self.status,
        });
        if !self.group.is_empty() {
            v["group"] = json!(self.group);
        }
        if !self.result.is_empty() {
            v["result"] = json!(self.result);
        }
        if !self.error.is_empty() {
            v["error"] = json!(self.error);
        }
        v
    }
}

#[derive(Clone, Debug, Default)]
pub struct Plan {
    /// Tasks in submission order: the stable tie-break of the launch order.
    pub tasks: Vec<Task>,
}

impl Plan {
    /// Parse and validate a whole plan: unique ids, existing deps, no cycles.
    pub fn parse(v: &Value) -> Result<Plan, String> {
        let Some(list) = v.get("tasks").and_then(Value::as_array) else {
            return Err("a plan is {\"tasks\": [{\"id\", \"title\", \"task\", \"deps\"…}]}".into());
        };
        if list.is_empty() {
            return Err("the plan has no tasks".into());
        }
        let mut tasks = Vec::with_capacity(list.len());
        for item in list {
            tasks.push(Task::from_value(item)?);
        }
        let plan = Plan { tasks };
        plan.validate()?;
        Ok(plan)
    }

    /// The whole plan's invariants (also run after every mutation).
    pub fn validate(&self) -> Result<(), String> {
        let mut ids: Vec<&str> = vec![];
        for t in &self.tasks {
            if ids.contains(&t.id.as_str()) {
                return Err(format!("duplicate task id {}", t.id));
            }
            ids.push(&t.id);
        }
        for t in &self.tasks {
            for d in &t.deps {
                if !ids.contains(&d.as_str()) {
                    return Err(format!("task {}: unknown dependency {d}", t.id));
                }
                if *d == t.id {
                    return Err(format!("task {} depends on itself: that is a cycle", t.id));
                }
            }
        }
        if let Some(cycle) = self.find_cycle() {
            return Err(format!("the deps form a cycle: {}", cycle.join(" -> ")));
        }
        Ok(())
    }

    /// A cycle as a path of ids (DFS with a stack), or None.
    fn find_cycle(&self) -> Option<Vec<String>> {
        let by_id: BTreeMap<&str, &Task> = self.tasks.iter().map(|t| (t.id.as_str(), t)).collect();
        fn walk(id: &str, by_id: &BTreeMap<&str, &Task>, seen: &mut Vec<String>, done: &mut Vec<String>) -> Option<Vec<String>> {
            if done.contains(&id.to_string()) {
                return None;
            }
            if let Some(i) = seen.iter().position(|s| s == id) {
                let mut cycle = seen[i..].to_vec();
                cycle.push(id.to_string());
                return Some(cycle);
            }
            seen.push(id.to_string());
            for d in &by_id[id].deps {
                if let Some(c) = walk(d, by_id, seen, done) {
                    return Some(c);
                }
            }
            seen.pop();
            done.push(id.to_string());
            None
        }
        for t in &self.tasks {
            if let Some(c) = walk(&t.id, &by_id, &mut vec![], &mut vec![]) {
                return Some(c);
            }
        }
        None
    }

    pub fn get(&self, id: &str) -> Option<&Task> {
        self.tasks.iter().find(|t| t.id == id)
    }

    pub fn get_mut(&mut self, id: &str) -> Option<&mut Task> {
        self.tasks.iter_mut().find(|t| t.id == id)
    }

    /// Tasks whose deps are all satisfied and that nothing keeps serialized (group, failure):
    /// the ready queue, in priority then submission order.
    pub fn ready(&self) -> Vec<String> {
        let satisfied = |id: &str| self.get(id).map(|t| SATISFIED.contains(&t.status.as_str())).unwrap_or(false);
        let failed = |id: &str| self.get(id).map(|t| matches!(t.status.as_str(), "failed" | "blocked")).unwrap_or(false);
        let running_groups: Vec<&str> = self.tasks.iter().filter(|t| t.status == "running").map(|t| t.group.as_str()).filter(|g| !g.is_empty()).collect();
        let mut out: Vec<&Task> = self
            .tasks
            .iter()
            .filter(|t| {
                if t.status != "pending" {
                    return false;
                }
                if t.deps.iter().any(|d| failed(d)) {
                    return false;
                }
                if !t.deps.iter().all(|d| satisfied(d)) {
                    return false;
                }
                // A group serializes: a running task of the group holds the rest back.
                t.group.is_empty() || !running_groups.contains(&t.group.as_str())
            })
            .collect();
        out.sort_by(|a, b| b.priority.cmp(&a.priority).then(self.index_of(&a.id).cmp(&self.index_of(&b.id))));
        // ... and only one task per group is queued at a time (priority, then submission order).
        let mut queued_groups: Vec<&str> = vec![];
        out.retain(|t| {
            if t.group.is_empty() {
                return true;
            }
            if queued_groups.contains(&t.group.as_str()) {
                false
            } else {
                queued_groups.push(t.group.as_str());
                true
            }
        });
        out.into_iter().map(|t| t.id.clone()).collect()
    }

    fn index_of(&self, id: &str) -> usize {
        self.tasks.iter().position(|t| t.id == id).unwrap_or(usize::MAX)
    }

    /// Tasks a finished task unblocks by name (used for `[plan]` notes).
    pub fn successors(&self, id: &str) -> Vec<String> {
        self.tasks.iter().filter(|t| t.deps.iter().any(|d| d == id)).map(|t| t.id.clone()).collect()
    }

    /// `A1 -> A2` per line plus a status line per task: what `agent plan graph` prints.
    pub fn graph(&self) -> String {
        let mut out = String::new();
        for t in &self.tasks {
            for d in &t.deps {
                out.push_str(&format!("{d} -> {}\n", t.id));
            }
        }
        for t in &self.tasks {
            out.push_str(&format!("{:<12} {:<9} {}\n", t.id, t.status, crate::subagents::first_line_pub(&t.title, 60)));
        }
        out
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn plan(json: &str) -> Plan {
        Plan::parse(&serde_json::from_str::<Value>(json).unwrap()).unwrap()
    }

    #[test]
    fn a_valid_plan_parses_and_round_trips() {
        let p = plan(r#"{"tasks":[
            {"id":"A1","title":"map spawn","task":"map it","deps":[],"group":"repo","priority":1,"budget":{"steps":60,"cost":0.5},"artifacts":["context/map.md"]},
            {"id":"A2","task":"use the map","deps":["A1"]}
        ]}"#);
        assert_eq!(p.tasks.len(), 2);
        assert_eq!(p.tasks[0].steps, 60);
        assert_eq!(p.tasks[1].deps, vec!["A1"]);
        let v = p.tasks[0].to_value();
        assert_eq!(v["budget"]["cost"].as_f64().unwrap(), 0.5);
    }

    #[test]
    fn bad_plans_are_refused() {
        let err = |json: &str| Plan::parse(&serde_json::from_str::<Value>(json).unwrap()).unwrap_err();
        assert!(err(r#"{"tasks":[{"id":"a","task":"x","deps":["b"]}]}"#).contains("unknown dependency"));
        assert!(err(r#"{"tasks":[{"id":"a","task":"x"},{"id":"a","task":"y"}]}"#).contains("duplicate"));
        assert!(err(r#"{"tasks":[{"id":"a","task":"x","deps":["a"]}]}"#).contains("cycle"));
        assert!(err(r#"{"tasks":[{"id":"a","task":"x","deps":["b"]},{"id":"b","task":"y","deps":["a"]}]}"#).contains("cycle"));
        assert!(err(r#"{"tasks":[{"id":"../x","task":"y"}]}"#).contains("task id"));
        assert!(err(r#"{"tasks":[]}"#).contains("no tasks"));
    }

    #[test]
    fn ready_queue_follows_deps_priority_and_groups() {
        let mut p = plan(r#"{"tasks":[
            {"id":"A1","task":"x","priority":1},
            {"id":"A2","task":"y","deps":["A1"]},
            {"id":"B","task":"z","priority":5},
            {"id":"C1","task":"c","group":"g"},
            {"id":"C2","task":"c2","group":"g"}
        ]}"#);
        // B first (priority), then A1 and the first of the group; A2 waits for A1.
        assert_eq!(p.ready(), vec!["B", "A1", "C1"]);
        p.get_mut("A1").unwrap().status = "running".into();
        p.get_mut("C1").unwrap().status = "running".into(); // holds C2 back: same group
        assert_eq!(p.ready(), vec!["B"]);
        p.get_mut("A1").unwrap().status = "review".into(); // review satisfies successors
        p.get_mut("C1").unwrap().status = "done".into();
        assert_eq!(p.ready(), vec!["B", "A2", "C2"]);
    }

    #[test]
    fn failures_block() {
        let mut p = plan(r#"{"tasks":[{"id":"A1","task":"x"},{"id":"A2","task":"y","deps":["A1"]}]}"#);
        p.get_mut("A1").unwrap().status = "failed".into();
        assert!(p.ready().is_empty());
    }

    #[test]
    fn graph_lines() {
        let p = plan(r#"{"tasks":[{"id":"A1","title":"one","task":"x"},{"id":"A2","task":"y","deps":["A1"]}]}"#);
        let g = p.graph();
        assert!(g.contains("A1 -> A2"), "{g}");
        assert!(g.contains("A1           pending   one"), "{g}");
    }
}
