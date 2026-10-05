//! What the box can still give a subagent, and how many may run at once.
//!
//! The orchestrating session needs three numbers before it fans out: how much memory is free, what
//! an average running subagent costs, and how many more fit. It reads them with
//! `mini-agent-rs agent resources`; the hub then *enforces* the same calculation at every `spawn`,
//! so a batch that does not fit is refused at the gate instead of taking the box down.
//!
//! Everything is read from `/proc` and the cgroup v2 limit: no new dependency, no shell-out, a few
//! small files per sample. Sampling is driven by the hub's monitor tick (throttled), so it costs
//! nothing when no subagent runs.

use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

/// Memory kept out of the fan-out budget: the session itself, the page cache it needs, the UIs.
/// Overridable, but the default is the 10 GiB of headroom an orchestrated session must leave.
const RESERVE_DEFAULT_MB: u64 = 10 * 1024;

/// A child that has not been sampled yet is charged this (a Rust agent process's floor).
const FLOOR_DEFAULT_MB: u64 = 256;

/// A live subagent's memory, sampled over time: its group's resident set and CPU time.
#[derive(Debug, Clone, Default)]
pub struct Sample {
    pub rss_mb: u64,
    pub cpu_s: f64,
    pub at_ms: u64,
}

impl Sample {
    fn diff(&self, after: &Sample) -> (u64, f64, f64) {
        let secs = (after.at_ms.saturating_sub(self.at_ms)) as f64 / 1000.0;
        let rss = after.rss_mb.max(self.rss_mb);
        let cpu = (after.cpu_s - self.cpu_s).max(0.0);
        (rss, cpu, secs)
    }
}

/// Rolling stats of one subagent's whole process group.
#[derive(Debug, Clone, Default)]
pub struct ChildUsage {
    pub rss_mb: u64,
    /// Mean RSS over the samples of this turn (KiB summed / count).
    pub avg_rss_mb: u64,
    pub peak_rss_mb: u64,
    /// Mean of CPU seconds consumed per second of wall time across the samples.
    pub avg_cpu: f64,
    pub samples: u32,
}

impl ChildUsage {
    fn push(&mut self, s: &Sample, prev: Option<&Sample>) {
        let (rss, cpu, secs) = match prev {
            Some(p) => {
                let (r, c, secs) = p.diff(s);
                let per_s = if secs > 0.2 { c / secs } else { self.avg_cpu };
                let avg = self.samples.min(1) as f64 * self.avg_rss_mb as f64;
                let total = avg + r as f64;
                self.avg_rss_mb = (total / (self.samples.min(1) as f64 + 1.0)).round() as u64;
                self.avg_cpu = if secs > 0.2 { per_s } else { self.avg_cpu };
                (r, c, secs)
            }
            None => (s.rss_mb, 0.0, 0.0),
        };
        self.rss_mb = rss;
        self.peak_rss_mb = self.peak_rss_mb.max(rss);
        let _ = cpu;
        let _ = secs;
        self.samples += 1;
    }
}

// ---- reading the box -----------------------------------------------------------------------

fn read_to_string_lossy(path: &Path) -> Option<String> {
    std::fs::read_to_string(path).ok()
}

/// `MemAvailable: 12345 kB` from `/proc/meminfo` (what the kernel says is freeable), plus `MemTotal`.
pub fn meminfo() -> Option<(u64, u64)> {
    let text = read_to_string_lossy(Path::new("/proc/meminfo"))?;
    let field = |name: &str| -> Option<u64> {
        text.lines().find_map(|l| {
            let rest = l.strip_prefix(name)?;
            let rest = rest.strip_prefix(':')?;
            let kb = rest.split_whitespace().next()?;
            kb.parse::<u64>().ok().map(|kb| kb / 1024) // kB -> MiB
        })
    };
    Some((field("MemAvailable")?, field("MemTotal")?))
}

/// The cgroup v2 hard ceiling, when this run lives in a limited one.
pub fn cgroup_limit_mb() -> Option<u64> {
    let text = read_to_string_lossy(Path::new("/sys/fs/cgroup/memory.max"))?;
    let t = text.trim();
    t.parse::<u64>().ok().map(|b| b / 1024 / 1024)
}

/// Logical CPUs (`nproc`), from the std library: the affinity mask, not the machine size.
pub fn cpu_count() -> u64 {
    std::thread::available_parallelism().map(|n| n.get() as u64).unwrap_or(1)
}

/// 1/5/15-minute load from `/proc/loadavg`.
pub fn loadavg() -> (f64, f64, f64) {
    let t = read_to_string_lossy(Path::new("/proc/loadavg")).unwrap_or_default();
    let nums: Vec<f64> = t.split_whitespace().take(3).filter_map(|v| v.parse().ok()).collect();
    (
        nums.first().copied().unwrap_or(0.0),
        nums.get(1).copied().unwrap_or(0.0),
        nums.get(2).copied().unwrap_or(0.0),
    )
}

/// Resident set and cumulative CPU time of a process **group**: `/proc/<pid>/task/*/children` is
/// followed down one level, which covers a subagent and the bash command it is running.
pub fn sample_group(pgid: i32) -> Option<Sample> {
    let stat_path = |pid: i32| PathBuf::from(format!("/proc/{pid}/stat"));
    let rss_of = |pid: i32| -> u64 {
        read_to_string_lossy(&stat_path(pid))
            .and_then(|s| s.rsplit_once(')').map(|(_, rest)| rest.to_string()))
            .and_then(|rest| {
                let f: Vec<&str> = rest.split_whitespace().collect();
                // `rss` is field 24 of stat, the 22nd entry after the comm field
                f.get(21).and_then(|v| v.parse::<u64>().ok())
            })
            .map(|pages| pages * 4 / 1024) // 4 KiB pages -> MiB
            .unwrap_or(0)
    };
    let utime_of = |pid: i32| -> f64 {
        read_to_string_lossy(&stat_path(pid))
            .map(|s| {
                let f: Vec<&str> = s.rsplit_once(')').map(|(_, r)| r).unwrap_or("").split_whitespace().collect();
                let u: f64 = f.get(11).and_then(|v| v.parse().ok()).unwrap_or(0.0);
                let s: f64 = f.get(12).and_then(|v| v.parse().ok()).unwrap_or(0.0);
                (u + s) / crate::util::clk_tck()
            })
            .unwrap_or(0.0)
    };
    // The subagent's own pid plus its descendants: the bash command it runs is a child of it.
    let mut pids = vec![pgid];
    let kids = |pid: i32| -> Vec<i32> {
        read_to_string_lossy(&PathBuf::from(format!("/proc/{pid}/task/{pid}/children")))
            .map(|t| t.split_whitespace().filter_map(|c| c.parse().ok()).collect())
            .unwrap_or_default()
    };
    let mut i = 0;
    while i < pids.len() && pids.len() < 64 {
        for k in kids(pids[i]) {
            if !pids.contains(&k) {
                pids.push(k);
            }
        }
        i += 1;
    }
    let mut rss = 0;
    let mut cpu = 0.0;
    for pid in pids {
        rss += rss_of(pid);
        cpu += utime_of(pid);
    }
    if rss == 0 {
        return None;
    }
    let at_ms = (crate::util::now() * 1000.0) as u64;
    Some(Sample { rss_mb: rss, cpu_s: cpu, at_ms })
}

// ---- the calculation -----------------------------------------------------------------------

/// The knobs of one calculation, so a call site and a test use the same numbers.
#[derive(Debug, Clone)]
pub struct Budget {
    /// Free memory right now (MiB), what the kernel says is available.
    pub available_mb: u64,
    /// The box's total or the cgroup limit, whichever binds (MiB).
    pub limit_mb: u64,
    /// Memory kept free whatever happens (MiB): the headroom an orchestrated session must leave.
    pub reserve_mb: u64,
    /// What an average running subagent costs (MiB): rolling mean over its own samples.
    pub avg_child_mb: u64,
    /// The floor charged to a child with no samples yet (MiB).
    pub floor_mb: u64,
    /// CPUs usable by this run.
    pub cpus: u64,
    /// The 1-minute load average.
    pub load1: f64,
    /// Live subagents right now (already counted in `available_mb` only as their own RSS).
    pub live: u64,
    /// The configured ceiling (never above 100).
    pub cap: u64,
}

impl Budget {
    pub fn reserve_default() -> u64 {
        std::env::var("MINI_AGENT_RESERVE_MEM_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(RESERVE_DEFAULT_MB)
    }
    pub fn floor_default() -> u64 {
        std::env::var("MINI_AGENT_CHILD_MEM_MB").ok().and_then(|v| v.parse().ok()).unwrap_or(FLOOR_DEFAULT_MB)
    }
    pub fn cap_default() -> u64 {
        std::env::var("MINI_AGENT_MAX_SUBAGENTS").ok().and_then(|v| v.parse().ok()).unwrap_or(100).clamp(1, 100)
    }

    /// The rate an average subagent is charged: never below the floor.
    pub fn per_child_mb(&self) -> u64 {
        self.avg_child_mb.max(self.floor_mb)
    }

    /// Memory left to spend after the reserve: at least 0, and never below it.
    pub fn free_mb(&self) -> u64 {
        self.available_mb.saturating_sub(self.reserve_mb)
    }

    /// How many more subagents fit, memory-side.
    pub fn by_memory(&self) -> u64 {
        let per = self.per_child_mb() as u64;
        if per == 0 {
            return 0;
        }
        self.free_mb() / per
    }

    /// How many more fit, CPU-side. Subagents spend most of their time waiting on the model, so the
    /// guard only binds when the box is actually getting saturated (load within a quarter of a core
    /// of the usable CPUs): then each needs roughly half a core to make progress.
    pub fn by_cpu(&self) -> u64 {
        const PER_CHILD: f64 = 0.5;
        // Stage 1: below saturation the fan-out is not limited by the CPU at all ...
        if self.load1 < self.cpus as f64 {
            return u64::MAX;
        }
        // ... stage 2: past it, the room to run into shrinks to nothing at 1.5x the CPUs.
        let spare = (self.cpus as f64 * 1.5 - self.load1).max(0.0);
        (spare / PER_CHILD).floor() as u64
    }

    /// **The answer: how many more may be spawned now.** Memory binds first, then CPU, then the
    /// configured cap (100 by default). `live` is already running, so it is subtracted.
    pub fn max_fanout(&self) -> u64 {
        let by_mem = self.by_memory();
        let by_cpu = self.by_cpu();
        let head = self.cap.saturating_sub(self.live);
        by_mem.min(by_cpu).min(head)
    }

    /// Whether we are already spending the memory the session keeps for itself (the reserve):
    /// the hub sheds subagents instead of starting new ones.
    pub fn under_pressure(&self) -> bool {
        self.available_mb < self.reserve_mb
    }
}

// ---- per-child bookkeeping -----------------------------------------------------------------

/// Rolling usage of every live child, keyed by name.
#[derive(Debug, Default)]
pub struct Tracker {
    samples: BTreeMap<String, (Option<Sample>, ChildUsage)>,
}

impl Tracker {
    /// Record this child's latest sample. Cheap: two small reads per child, at most every other tick.
    pub fn observe(&mut self, name: &str, pgid: i32, age_s: f64) -> ChildUsage {
        let fresh = sample_group(pgid);
        let entry = self.samples.entry(name.to_string()).or_insert_with(|| (None, ChildUsage::default()));
        match fresh {
            Some(s) => {
                let prev = entry.0.clone();
                // A child's first seconds are its startup, not its steady cost: wait for one.
                if age_s < 2.0 {
                    entry.0 = Some(s);
                } else {
                    entry.1.push(&s, prev.as_ref());
                    entry.0 = Some(s);
                }
                entry.1.clone()
            }
            None => entry.1.clone(),
        }
    }

    /// Forget a child (it exited).
    pub fn drop(&mut self, name: &str) {
        self.samples.remove(name);
    }

    pub fn get(&self, name: &str) -> Option<ChildUsage> {
        self.samples.get(name).map(|(_, u)| u.clone())
    }

    /// The mean RSS of the children that have been sampled; 0 when none (the floor applies).
    pub fn average_rss_mb(&self) -> u64 {
        let mut sum = 0u64;
        let mut n = 0u32;
        for (_, u) in self.samples.values() {
            if u.samples > 0 && u.avg_rss_mb > 0 {
                sum += u.avg_rss_mb;
                n += 1;
            }
        }
        if n == 0 {
            0
        } else {
            (sum as f64 / n as f64).round() as u64
        }
    }

}

/// "1.5 GiB" / "512 MiB", for the human-readable answers.
pub fn gb_g(mb: u64) -> String {
    if mb >= 1024 { format!("{:.1} GiB", mb as f64 / 1024.0) } else { format!("{mb} MiB") }
}

// ---- the report ----------------------------------------------------------------------------

/// Everything `agent resources` shows: the numbers and the conclusion.
pub struct Report {
    pub budget: Budget,
    /// Per live child: name, rss now, average, peak.
    pub children: Vec<(String, u64, u64, u64)>,
    pub max_fanout: u64,
    pub next: Option<String>,
}

pub fn snapshot(
    available_mb: Option<u64>,
    total_mb: Option<u64>,
    cpus: u64,
    load1: f64,
    tracker: &Tracker,
    live: u64,
) -> Report {
    // An unknown MemAvailable must read as "nothing to spend": refuse rather than guess big.
    let (available_mb, total_mb) = available_mb.zip(total_mb).unwrap_or((0, 0));
    let mut budget = Budget {
        available_mb,
        limit_mb: cgroup_limit_mb().map(|c| c.min(total_mb)).unwrap_or(total_mb),
        reserve_mb: Budget::reserve_default(),
        avg_child_mb: tracker.average_rss_mb(),
        floor_mb: Budget::floor_default(),
        cpus,
        load1,
        live,
        cap: Budget::cap_default(),
    };
    if budget.limit_mb > 0 {
        budget.available_mb = budget.available_mb.min(budget.limit_mb);
    }
    let max_fanout = budget.max_fanout();
    let children = tracker
        .samples
        .iter()
        .map(|(k, (_, u))| (k.clone(), u.rss_mb, u.avg_rss_mb, u.peak_rss_mb))
        .collect();
    let next = if max_fanout == 0 {
        Some(format!(
            "spawning is refused now: {} MiB free, less than the {} MiB reserve + one subagent ({} MiB average)",
            budget.available_mb, budget.reserve_mb, budget.per_child_mb()
        ))
        .filter(|_| budget.by_memory() == 0)
        .or_else(|| Some("the CPU headroom or the subagent cap is what binds now".into()))
    } else {
        None
    };
    Report { budget, children, max_fanout, next }
}

impl Report {
    pub fn to_value(&self) -> serde_json::Value {
        serde_json::json!({
            "available_mb": self.budget.available_mb,
            "limit_mb": self.budget.limit_mb,
            "reserve_mb": self.budget.reserve_mb,
            "free_mb": self.budget.free_mb(),
            "avg_child_mb": self.budget.avg_child_mb,
            "floor_mb": self.budget.floor_mb,
            "per_child_mb": self.budget.per_child_mb(),
            "cpus": self.budget.cpus,
            "load1": self.budget.load1,
            "live": self.budget.live,
            "cap": self.budget.cap,
            "by_memory": self.budget.by_memory(),
            // u64::MAX means "not the binding constraint": report the cap instead.
            "by_cpu": self.budget.by_cpu().min(self.budget.cap),
            "max_fanout": self.max_fanout,
            "under_pressure": self.budget.under_pressure(),
            "children": self.children.iter().map(|(n, rss, avg, peak)| serde_json::json!({
                "name": n, "rss_mb": rss, "avg_rss_mb": avg, "peak_rss_mb": peak,
            })).collect::<Vec<_>>(),
        })
    }

    pub fn text(&self) -> String {
        let b = &self.budget;
        let mut out = format!(
            "free memory {} of {} · reserve {} · available to spend {}\navg subagent {} (floor {}) · {} live of a cap of {}\ncpus {} · load {:.2}\n",
            gb_g(b.available_mb),
            gb_g(b.limit_mb),
            gb_g(b.reserve_mb),
            gb_g(b.free_mb()),
            gb_g(b.per_child_mb()),
            gb_g(b.floor_mb),
            b.live,
            b.cap,
            b.cpus,
            b.load1,
        );
        out.push_str(&format!("max fan-out now: {} more subagent{}\n", self.max_fanout, if self.max_fanout == 1 { "" } else { "s" }));
        for (name, rss, avg, peak) in &self.children {
            out.push_str(&format!("  {name}: {rss} MiB now, {avg} average, {peak} peak\n"));
        }
        if let Some(n) = &self.next {
            out.push_str(n);
            out.push('\n');
        }
        out.trim_end().to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn budget(available: u64, reserve: u64, avg: u64, live: u64) -> Budget {
        Budget { available_mb: available, limit_mb: 65536, reserve_mb: reserve, avg_child_mb: avg, floor_mb: FLOOR_DEFAULT_MB, cpus: 12, load1: 0.0, live, cap: 100 }
    }

    #[test]
    fn free_room_is_what_is_left_after_the_reserve() {
        assert_eq!(budget(40960, 10240, 512, 0).free_mb(), 30720);
        assert_eq!(budget(8192, 10240, 512, 0).free_mb(), 0);
    }

    #[test]
    fn fanout_is_memory_divided_by_the_average_child() {
        // 30720 / 512 = 60
        assert_eq!(budget(40960, 10240, 512, 0).max_fanout(), 60);
        // larger children cost more headroom: fewer of them
        assert_eq!(budget(40960, 10240, 2048, 0).max_fanout(), 15);
    }

    #[test]
    fn the_cap_of_100_binds_when_there_is_plenty() {
        let mut b = budget(60 * 1024, 10240, 256, 0);
        assert_eq!(b.max_fanout(), 100, "memory would allow more");
        b.live = 100;
        assert_eq!(b.max_fanout(), 0, "the cap counts the live ones too");
        b.live = 97;
        assert_eq!(b.max_fanout(), 3);
    }

    #[test]
    fn nothing_fits_below_the_reserve_plus_one_child() {
        assert_eq!(budget(10240 + 256 - 1, 10240, 256, 0).max_fanout(), 0);
        assert_eq!(budget(10240, 10240, 256, 0).max_fanout(), 0);
    }

    #[test]
    fn a_normal_load_does_not_bind_but_a_saturated_box_stops_the_fanout() {
        let mut b = budget(40960, 10240, 256, 0);
        b.load1 = 6.0; // 12 cpus, mostly waiting on the model: memory/cap is what counts
        assert_eq!(b.max_fanout(), 100, "memory would allow 120, the cap binds");
        b.load1 = 96.0; // badly oversubscribed: nothing can make progress
        assert_eq!(b.by_cpu(), 0);
        assert_eq!(b.max_fanout(), 0);
        b.load1 = 15.0; // 1.25x oversubscribed: a few still make progress
        assert_eq!(b.by_cpu(), 6);
        b.load1 = 30.0; // badly oversubscribed: none
        assert_eq!(b.by_cpu(), 0);
    }

    #[test]
    fn the_cap_never_goes_past_100() {
        std::env::remove_var("MINI_AGENT_MAX_SUBAGENTS");
        assert_eq!(Budget::cap_default(), 100, "the default is 100");
        // SAFETY: tests run with a single thread touching this variable at a time.
        std::env::set_var("MINI_AGENT_MAX_SUBAGENTS", "500");
        assert_eq!(Budget::cap_default(), 100, "500 is clamped to the ceiling of 100");
        std::env::set_var("MINI_AGENT_MAX_SUBAGENTS", "12");
        assert_eq!(Budget::cap_default(), 12, "a tighter cap of the user's own is kept");
        std::env::remove_var("MINI_AGENT_MAX_SUBAGENTS");
    }

    #[test]
    fn pressure_is_the_reserve_being_spent() {
        assert!(budget(3000, 10240, 512, 0).under_pressure());
        assert!(!budget(16000, 10240, 512, 0).under_pressure());
    }

    /// A 100-agent fan-out on a big box: the cap binds, so nothing else is admitted.
    #[test]
    fn a_hundred_agent_fanout_on_a_big_box_is_capped_not_memory_bound() {
        // 128 GiB free after the reserve, 512 MiB a child: memory alone would allow 256 children.
        let b = budget(128 * 1024 + 10240, 10240, 512, 0);
        assert_eq!(b.by_memory(), 256);
        assert_eq!(b.max_fanout(), 100, "the ceiling is 100 live children");
    }

    /// The room shrinks as the batch runs: 60 live children of 2 GiB leave room for fewer.
    #[test]
    fn the_room_shrinks_as_the_batch_grows() {
        let mut b = budget(60 * 1024 + 10240, 10240, 2048, 0);
        assert_eq!(b.by_memory(), 30);
        b.live = 30;
        assert_eq!(b.max_fanout(), 30, "the memory is still what binds (the cap is 100)");
        b.live = 80;
        assert_eq!(b.max_fanout(), 20);
        b.live = 100;
        assert_eq!(b.max_fanout(), 0);
    }

    #[test]
    fn the_average_of_samples_is_the_mean_that_is_kept() {
        let mut t = Tracker::default();
        t.samples.insert("a".into(), (None, ChildUsage { avg_rss_mb: 300, samples: 3, ..Default::default() }));
        t.samples.insert("b".into(), (None, ChildUsage { avg_rss_mb: 500, samples: 1, ..Default::default() }));
        assert_eq!(t.average_rss_mb(), 400);
    }
}


#[cfg(test)]
mod gate_tests {
    use super::*;
    // A spawn whose Math evaluates the real kernel numbers is covered by the e2e suite; here the
    // arithmetic itself is what matters (see the `Budget` tests above).

    #[test]
    fn refuse_message_names_the_numbers() {
        let b = Budget { available_mb: 9 * 1024, limit_mb: 65536, reserve_mb: 10 * 1024, avg_child_mb: 0, floor_mb: 256, cpus: 12, load1: 0.0, live: 0, cap: 100 };
        assert_eq!(b.max_fanout(), 0, "below the reserve nothing fits");
        assert!(b.under_pressure());
    }

    #[test]
    fn the_live_ones_take_the_cap_not_the_free_memory() {
        // 40 live children of 1 GiB are already out of MemAvailable: they cost the cap, not the room.
        let mut b = Budget { available_mb: 30 * 1024, limit_mb: 65536, reserve_mb: 10240, avg_child_mb: 1024, floor_mb: 256, cpus: 12, load1: 0.0, live: 40, cap: 100 };
        assert_eq!(b.free_mb(), 20 * 1024);
        assert_eq!(b.max_fanout(), 20, "10 GiB left at 1 GiB a child");
        b.live = 95;
        assert_eq!(b.max_fanout(), 5, "the cap of 100 binds before the memory does");
        b.live = 100;
        assert_eq!(b.max_fanout(), 0);
    }

    #[test]
    fn the_floor_is_charged_when_no_child_has_been_measured_yet() {
        let t = Tracker::default();
        assert_eq!(t.average_rss_mb(), 0, "no samples: the floor applies");
        let b = Budget { available_mb: 10240 + 300, limit_mb: 65536, reserve_mb: 10240, avg_child_mb: 0, floor_mb: 256, cpus: 12, load1: 0.0, live: 0, cap: 100 };
        assert_eq!(b.max_fanout(), 1, "one child of the floor fits, not two");
            }
}
