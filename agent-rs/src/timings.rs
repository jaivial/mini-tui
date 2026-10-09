//! Per-phase step timing (plan item 6, `docs/pi-speed-analysis.md` SS7): pi's `core/timings.ts`
//! behind `PI_TIMING=1`, stamped into the trajectory instead of stderr.
//!
//! The analysis could not attribute mini's ~15-30 ms of per-step overhead to a phase, because
//! the journal only records one number per step (`thinking_seconds`, the whole model call) and
//! the tool messages are timestamped after their batch renders. [`StepTimings`] fills that gap:
//! one object per assistant message under `extra.timings`, in milliseconds, with the phases the
//! loop actually has.
//!
//! Always on (it is a handful of `Instant::now()` reads and one small JSON object per step, not
//! a `PI_TIMING` switch): the point is to be able to answer "where did the time go" from a run
//! that already happened, which an opt-in flag defeats. `MINI_AGENT_TIMINGS=0` turns it off.
//!
//! Fields, all milliseconds and all rounded to 0.1 ms:
//!
//! | field | phase |
//! | --- | --- |
//! | `step` | the whole step: control + limits + model + actions + observation rendering |
//! | `model` | the model call itself (retries included), i.e. what `thinking_seconds` covers |
//! | `view` | building the context view / token estimate before the call (compaction check) |
//! | `actions` | executing the step's actions (shell spawns and reads) |
//! | `observe` | rendering the observation messages |
//! | `save` | journal append + throttled export after the step |
//! | `overhead_ms` | `step - model`: the harness' own share of the step |
//!
//! `total_ms` accumulates the harness share over the run so a trajectory answers "was it the
//! model or was it us" without post-processing.

use crate::util::round1;
use serde_json::{json, Value};
use std::time::Instant;

/// Whether timings are stamped into `extra`. On unless `MINI_AGENT_TIMINGS=0`.
pub fn enabled() -> bool {
    std::env::var("MINI_AGENT_TIMINGS").map(|v| v != "0").unwrap_or(true)
}

/// One step's phase clock. `mark` is cheap and the labels are fixed strings, so the common path
/// is a compare and (when the phase changed) an `Instant::now()`.
#[derive(Default)]
pub struct StepTimings {
    /// Milliseconds spent in each labelled phase, in the order the labels were first seen.
    phases: Vec<(&'static str, f64)>,
    last: Option<(&'static str, Instant)>,
    total_ms: f64,
}

impl StepTimings {
    pub fn start() -> Self {
        StepTimings::default()
    }

    /// Close the previous label (if any) and open `label`. Calling it twice with the same label
    /// in a row is a no-op, so guard-heavy code does not fragment a phase.
    pub fn mark(&mut self, label: &'static str) {
        let t = Instant::now();
        if let Some((prev, at)) = self.last.replace((label, t)) {
            if prev == label {
                return;
            }
            self.add(prev, at, t);
        }
    }

    /// Close the open label without opening another (the end of a measured region).
    pub fn close(&mut self) {
        if let Some((prev, at)) = self.last.take() {
            self.add(prev, at, Instant::now());
        }
    }

    fn add(&mut self, label: &'static str, from: Instant, to: Instant) {
        let ms = (to - from).as_secs_f64() * 1000.0;
        self.total_ms += ms;
        match self.phases.iter_mut().find(|(l, _)| *l == label) {
            Some((_, acc)) => *acc += ms,
            None => self.phases.push((label, ms)),
        }
    }

    /// Add a phase that was measured outside this clock (a sub-phase a caller timed itself).
    pub fn add_phase(&mut self, label: &'static str, ms: f64) {
        self.total_ms += ms;
        match self.phases.iter_mut().find(|(l, _)| *l == label) {
            Some((_, acc)) => *acc += ms,
            None => self.phases.push((label, ms)),
        }
    }

    pub fn total(&self) -> f64 {
        self.total_ms
    }

    /// The `extra.timings` object for the step's assistant message.
    pub fn to_value(&self, model_ms: f64) -> Value {
        let mut o = serde_json::Map::new();
        for (label, ms) in &self.phases {
            o.insert((*label).to_string(), json!(round1(*ms)));
        }
        // The model call dominates a step; the rest is what the harness can still improve.
        let overhead = (self.total_ms - self.phases.iter().filter(|(l, _)| *l == "model").map(|(_, m)| *m).sum::<f64>()).max(0.0);
        o.insert("overhead_ms".into(), json!(round1(overhead)));
        o.insert("model_ms".into(), json!(round1(model_ms)));
        o.insert("harness_ms".into(), json!(round1(overhead)));
        Value::Object(o)
    }
}

/// Stamp `timings` onto an assistant message's `extra` (a no-op when disabled).
pub fn stamp(message: &mut Value, timings: &StepTimings, model_ms: f64) {
    if !enabled() {
        return;
    }
    if !message.get("extra").is_some_and(Value::is_object) {
        message["extra"] = json!({});
    }
    message["extra"]["timings"] = timings.to_value(model_ms);
}

/// Run bookkeeping timings (`extra.timings` on the `info` object of the export): how long the
/// run spent in its own code, next to the model totals it already reports.
pub fn run_summary(harness_ms: f64, model_ms: f64, steps: i64) -> Value {
    json!({
        "steps": steps,
        "harness_ms": round1(harness_ms),
        "model_ms": round1(model_ms),
        "overhead_ms": round1(harness_ms),
    })
}
