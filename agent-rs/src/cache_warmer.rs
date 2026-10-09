//! Prompt-cache warmer (plan item 5, `docs/pi-speed-analysis.md` SS7), after pi's
//! `core/cache-warmer.ts`.
//!
//! mini has nothing that keeps a prompt-cache entry alive, and the analysis measured the cost of
//! that: the first model call of a run is uncached (1.3-5.7 s) and 17 compactions in 28 headless
//! runs each paid an uncached call. pi's warmer replays the last request at 90% of the entry's
//! TTL so the prefix stays warm for the call that is about to need it.
//!
//! Shape here, matched to what this agent already has:
//!
//! * **When.** A run is *idle* when it holds at its exit waiting for a follow-up (the
//!   `MSWEA_CONTROL_FILE` loop) or for its subagents: those waits already poll every 200 ms, so
//!   the warmer is a check in the same loop, not a new thread.
//! * **What.** The last assistant message's prompt: a replay of the request that produced it,
//!   with `max_tokens` forced to 1 (pi's `maxTokens: 1`) so the reply itself is one token. It
//!   only replays a request the provider already answered; it never invents a turn.
//! * **When to refresh.** [`warming_delay`] is pi's `getCacheWarmingDelayMs` verbatim:
//!   `max(1, floor(min(0.9 x TTL, TTL - 10s)))`, and `None` when the TTL is 10 s or less, which
//!   is the analysis' "refresh at 0.9x TTL with a >= 10 s margin".
//! * **Whether it is worth it.** pi's economics: refresh only when the expected saving is at
//!   least [`MIN_EXPECTED_SAVINGS`] ($0.05), with the idle continuation probability discounted
//!   to 0.15. Costs come from the model's own price row (`cache_read` for the warm, `cache_write`
//!   or `input` for the miss), so the decision is made from the same table that bills the run.
//! * **Off by default for headless runs**, where nobody is coming back: `MINI_AGENT_CACHE_WARMER`
//!   is `1`/`auto`/`0`, default `auto` (on only for a run that has a control file, i.e. a
//!   follow-up can actually arrive). A warm call's cost is recorded in the run's journal as a
//!   `cache_warm` usage note, never into `model_stats` (it did no work).
//!
//! Everything here is best-effort: a warm call that fails is logged and forgotten, exactly as
//! pi's `catch {}` does, because warming must never break the run it is trying to speed up.

use crate::util::now;
use serde_json::{json, Value};

/// pi's `CACHE_WARMING_MINIMUM_EXPECTED_SAVINGS`: a refresh must be expected to save at least
/// this many dollars.
pub const MIN_EXPECTED_SAVINGS: f64 = 0.05;
/// pi's `IDLE_CONTINUATION_PROBABILITY`: measured chance a real request arrives before the entry
/// expires while the agent sits idle.
pub const IDLE_CONTINUATION_PROBABILITY: f64 = 0.15;
/// The margin the refresh must leave inside the TTL (pi's ten seconds).
const MARGIN_SECS: f64 = 10.0;
/// One token of output is the cheapest reply a provider will bill.
const WARM_OUTPUT_TOKENS: i64 = 1;

pub fn mode() -> Mode {
    match std::env::var("MINI_AGENT_CACHE_WARMER").ok().filter(|v| !v.is_empty()).unwrap_or_default().as_str() {
        "1" | "on" | "true" => Mode::On,
        "0" | "off" | "false" => Mode::Off,
        _ => Mode::Auto,
    }
}

#[derive(PartialEq, Eq, Copy, Clone, Debug)]
pub enum Mode {
    On,
    Off,
    /// On for a run that can still be continued (a control file exists): an idle run nobody can
    /// talk to has no next call to keep the entry warm for.
    Auto,
}

/// Whether the warmer is active for this run.
pub fn active() -> bool {
    match mode() {
        Mode::On => true,
        Mode::Off => false,
        Mode::Auto => crate::agent::Agent::control_file_exists(),
    }
}

/// pi's `getPromptCacheTtlMs`: the lifetime of the cache entry a request writes. From the model's
/// `cache_ttl` setting (`MSWEA_CACHE_TTL`, the same field the cache-control markers use) in
/// seconds; `None` when unset, which means "the provider's default, unknown" and therefore no
/// warming (guessing a TTL would refresh either far too early or after the entry died).
pub fn ttl_secs(config: &Value) -> Option<f64> {
    let raw = config.get("cache_ttl").and_then(Value::as_str)?.trim().to_lowercase();
    let secs = match raw.as_str() {
        "5m" => 300.0,
        "1h" => 3600.0,
        other => other.trim_end_matches('s').parse().ok()?,
    };
    (secs > 0.0).then_some(secs)
}

/// pi's `getCacheWarmingDelayMs`: refresh at `min(0.9 x TTL, TTL - 10s)`, at least 1 s, and
/// never when the TTL cannot preserve a 10 s margin. Seconds, not milliseconds, because every
/// other clock in this agent is seconds.
pub fn warming_delay(ttl_secs: f64) -> Option<f64> {
    if ttl_secs <= MARGIN_SECS {
        return None;
    }
    Some((ttl_secs * 0.9).min(ttl_secs - MARGIN_SECS).max(1.0))
}

/// One warm-or-skip decision, pi's `CacheWarmingDecision` in the fields the journal records.
#[derive(Debug, Clone)]
pub struct Decision {
    pub warm: bool,
    pub prompt_tokens: i64,
    pub warm_cost: f64,
    pub miss_cost: f64,
    pub expected_savings: f64,
    pub continuation_probability: f64,
    pub reason: &'static str,
}

impl Decision {
    pub fn to_value(&self) -> Value {
        json!({
            "warm": self.warm,
            "prompt_tokens": self.prompt_tokens,
            "warm_cost": self.warm_cost,
            "miss_cost": self.miss_cost,
            "expected_savings": self.expected_savings,
            "continuation_probability": self.continuation_probability,
            "reason": self.reason,
        })
    }
}

/// The economics of one refresh, from the price row that bills the model. `cache_read` is what a
/// warm prefix costs; the miss is a `cache_write` when the provider bills one, else a plain
/// input. Unknown prices (both zero) mean the decision cannot be made: skip, as pi's
/// `economicsAvailable: false` does.
fn decide(prompt_tokens: i64, cache_read: f64, cache_write: f64, input: f64, output: f64) -> Decision {
    let per_m = |tokens: i64, price: f64| tokens as f64 * price / 1e6;
    let hit = per_m(prompt_tokens, cache_read);
    let miss_price = if cache_write > 0.0 { cache_write } else { input };
    let miss = per_m(prompt_tokens, miss_price);
    let warm_cost = hit + per_m(WARM_OUTPUT_TOKENS, output);
    let miss_cost = (miss - hit).max(0.0);
    let continuation = IDLE_CONTINUATION_PROBABILITY;
    let savings = continuation * miss_cost - warm_cost;
    let (warm, reason) = if prompt_tokens <= 0 {
        (false, "no prompt tokens recorded")
    } else if cache_read <= 0.0 && miss_price <= 0.0 {
        (false, "cache economics unavailable")
    } else if savings >= MIN_EXPECTED_SAVINGS {
        (true, "expected savings over threshold")
    } else {
        (false, "expected savings under threshold")
    };
    Decision { warm, prompt_tokens, warm_cost, miss_cost, expected_savings: savings, continuation_probability: continuation, reason }
}

/// The warmer's state for one idle wait: what the last real request was, when it happened, and
/// when the next refresh is due. Recomputed from the conversation each time the run goes idle, so
/// a follow-up that arrives and is answered resets it for free.
#[derive(Default)]
pub struct Warmer {
    last_call_at: f64,
    last_decision: Option<Decision>,
    warms: i64,
    warm_cost: f64,
}

impl Warmer {
    pub fn new() -> Self {
        Warmer::default()
    }

    /// Note that a real request just completed: the entry it wrote is the one to keep alive.
    pub fn observed_call(&mut self) {
        self.last_call_at = now();
        self.last_decision = None;
    }

    /// Whether a refresh is due **now** (gate only, no request): the caller asks this every poll
    /// and only builds the replay's view (a full conversation clone) when it passes.
    pub fn refresh_due(&mut self, ttl: Option<f64>, prompt_tokens: i64, prices: (f64, f64, f64, f64)) -> bool {
        if !active() {
            return false;
        }
        let Some(ttl) = ttl else { return false };
        let Some(delay) = warming_delay(ttl) else { return false };
        if self.last_call_at <= 0.0 || now() - self.last_call_at < delay {
            return false;
        }
        let (cache_read, cache_write, input, output) = prices;
        let d = decide(prompt_tokens, cache_read, cache_write, input, output);
        self.last_decision = Some(d);
        if !self.last_decision.as_ref().is_some_and(|d| d.warm) {
            // Do not re-evaluate every 200 ms for a decision that will not change until the
            // conversation does: park the clock so the next check is a full delay away.
            self.last_call_at = now();
            return false;
        }
        true
    }

    /// Perform the refresh [`refresh_due`] approved: `replay` issues the warm request (the caller
    /// owns the model); returning `Some(note)` means a refresh happened and the note should reach
    /// the journal.
    pub fn run_due<F: FnMut(i64) -> Result<f64, String>>(&mut self, prompt_tokens: i64, prices: (f64, f64, f64, f64), ttl: Option<f64>, replay: F) -> Option<Value> {
        if !self.refresh_due(ttl, prompt_tokens, prices) {
            return None;
        }
        // `refresh_due` just set this; the fallback only exists so a bare `run_due` call cannot
        // replay with no decision recorded.
        let d = self.last_decision.clone().unwrap_or(Decision { warm: false, prompt_tokens, warm_cost: 0.0, miss_cost: 0.0, expected_savings: 0.0, continuation_probability: IDLE_CONTINUATION_PROBABILITY, reason: "no decision recorded" });
        let mut replay = replay;
        match replay(WARM_OUTPUT_TOKENS) {
            Ok(cost) => {
                self.warms += 1;
                self.warm_cost += cost;
                self.last_call_at = now();
                Some(json!({
                    "t": "cache_warm",
                    "cost": cost,
                    "warms": self.warms,
                    "decision": d.to_value(),
                    "timestamp": now(),
                }))
            }
            Err(e) => {
                // Best-effort by contract: a failed warm must not disturb the run.
                self.last_call_at = now();
                Some(json!({"t": "cache_warm_error", "error": e, "timestamp": now()}))
            }
        }
    }

    pub fn summary(&self) -> Value {
        json!({
            "warms": self.warms,
            "cost": self.warm_cost,
            "last": self.last_decision.as_ref().map(|d| d.to_value()).unwrap_or(Value::Null),
        })
    }
}
