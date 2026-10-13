# Goal closure in the Rust runner

A final answer or `COMPLETE_TASK_AND_SUBMIT_FINAL_OUTPUT` is now a proposed closure. The runner asks a goal oracle before it records `Submitted`.

Default: the run's current model judges a separate, tool-free request. This is a provisional opinion, not independent proof. It sees the exact goal, explicit follow-ups, a recent evidence window and bounded working-tree diff in the execution environment. It checks missing requirements and concrete defects, including unfinished/placeholder code. A rejection returns the gaps to the same worker, which continues with its existing context. There is no fixed count of goal-repair rounds. Explicit step/cost/time limits and cancellation still apply.

The closure judgement replaces the old second plain-text confirmation turn. After twelve identical actions, the runner skips re-execution and asks for a different approach rather than aborting the open goal. A repeated approach can still be stopped by the user or the configured resource limits.

## Configuration

- `MINI_AGENT_GOAL_ORACLE=model` (default): current model, provisional judge.
- `MINI_AGENT_GOAL_ORACLE=off`: legacy closure and exact-loop abort behavior.
- `MINI_AGENT_GOAL_ORACLE_URL`: exact HTTP(S) endpoint for a replacement service, including a future Laya adapter. No port is guessed and no service is installed automatically.
- `MINI_AGENT_GOAL_ORACLE_KEY`: optional bearer key for that service.

The replacement endpoint receives a JSON object with `goal`, `proposal`, `observations` and `diff` strings. It returns:

```json
{"complete": false, "score": 75, "gaps": ["The required output file is missing"]}
```

A successful verdict must have `complete: true`, `score: 100` and an empty `gaps` array. Invalid, contradictory or unavailable verdicts never count as approval. Three consecutive oracle errors produce `GoalOracleUnavailable`, an explicit infrastructure blocker rather than `Submitted`. Model-judge calls have a 1024-token cap and a 60-second request timeout; the replacement endpoint has a 60-second timeout and 64 KB response bound. The worker's model configuration is restored after each judgement. Costs and model-call counts include the provisional judge.

`info.goal_oracle.attempts` records each verdict and error in the trajectory. A post-run Jev notice no longer erases the exit status or submission returned to the caller.

## Limits

- Evidence windows and diffs are bounded. Untracked paths are listed, but their content is not automatically read, since they can contain credentials or unrelated files.
- The judge can make mistakes. Official benchmark verifier results, not oracle opinions, establish pass rate.
- This does not supply Laya itself, benchmark results, a graph/vector task store or a new parallel scheduler.
- No live terminal binary is replaced by merely building this change.
