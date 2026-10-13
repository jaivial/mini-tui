# QuickJS code mode (design, 2026-10-13)

Goal: real JavaScript code-mode parity with Pi's CodemodeSandbox, replacing the
Rhai-only `code` tool path for JS. Rhai `code` stays untouched for compat.

## Current state (audited at 5106fce)
- `code` tool = Rhai, implemented in agent-rs/src/writing.rs:
  - `code_outcome()` (line ~582): builds engine per call, registers host fns
    read/read(offset)/read(offset,limit)/write/edit/edit_many/bash/reads +
    pure helpers (print/len/lines/grep/join/replace_all/slice/num/fmt2/top).
  - 60KB output cap, STOP sentinel, 128-path/8-thread reads (PR149).
- REPL mode in repl.rs also embeds Rhai (separate lane, not in scope here).
- Pi reference: quickjs-wasi 3.6.2 + @earendil-works/pi-codemode installed under
  the pi-coding-agent node_modules. CodemodeSandbox: per-execute VM worker,
  async JS body, tool table, text/image/store/load, AbortSignal/timeout/memory.

## Design
1. New module agent-rs/src/codejs.rs embedding QuickJS via the `rquickjs` crate.
2. Host bridge reuses the SAME tool closures writing.rs registers for Rhai
   (single source of truth: extract the read/write/edit/edit_many/bash
   implementations into shared fns both engines call). No second semantics.
3. JS API mirrors Pi shape: top-level async function body;
   `await tools.read({path})`, `tools.write(...)`, `tools.edit(...)`,
   `tools.bash(...)`; `print(x)` accumulates; return value or printed buffer
   becomes the tool result, same 60KB UTF-8 bound + notice as Rhai.
4. Limits: wall timeout (rquickjs interrupt handler), memory limit, stack
   limit, max tool calls per execute, no module loading.
5. Tool exposure: new `codejs` tool (schemas for Chat/Responses/Messages like
   writing.rs:60-120). Undocumented and off by default (env MINITUI_CODEJS=1)
   until end-to-end parity is proven. mini.yaml keeps documenting Rhai `code`.
6. No pretending: no "Rhai = QuickJS parity" claims; parity needs measured runs.

## Dependency feasibility (RESOLVED 15:52)
- rquickjs 0.9.0 resolves AND downloads from crates.io on this host.
  Final implementation uses NO optional features: basic runtime + promise job queue
  handles async JavaScript wrappers with synchronous host RPC. No loader/dyn-load
  or Rust futures feature is needed. This also keeps the lockfile diff to 3 crates.
- Cargo.toml in this worktree already carries the dep; Cargo.lock updated.
- Toolchain note: PATH cargo is 1.75 (too old for lock v4). Use
  ~/.rustup/toolchains/1.97.1-x86_64-unknown-linux-gnu/bin/cargo for all checks.
- quickjs-sys build + cargo check underway under CPU25%/2GB/Nice19/IOWeight1.

## Implemented candidate (16:02, compiled but not runtime-measured)
- Fresh Runtime + Context per call, 64MB memory, 512KB stack, interrupt deadline
  and STOP; timeout clamped to 300s maximum, 128 host-call cap.
- Same read_outcome/write_outcome/edit_outcome used by native tools; bash uses
  the same CodeCtx environment bridge as Rhai. Failed tools throw structured
  observations. Calls are sequential including Promise.all.
- Chat/Responses/Messages schemas behind both MINITUI_AGENT_TOOLS=1 and
  MINITUI_CODEJS=1. Environment filesystem restriction preserved.
- print/return/error combined output bounded to 60KB on UTF-8 boundaries.
- Synchronous store(key,value)/load(key) per agent run. Fresh execution snapshot,
  commit only on successful, non-cancelled execution; rollback on failure.
  64 keys, 128-byte keys, 16KB JSON/value, 128KB total. undefined deletes;
  absent load returns undefined. Run/resume resets state. No disk persistence.
  This shares Pi semantics for JSON snapshot/commit, but is not full parity.
- Native image reads return opaque handles, not base64 to the JS VM; image(result)
  explicitly emits verified native read images into separate visual user blocks.
  Four emissions and 8MB decoded bytes total per execution, deduplicated.
  Images emitted before failure are kept. Payload compilation only, no endpoint
  or pixel verification yet.
- Capped compilation passes; runtime proof remains pending. No tests or benchmark changed.
- Pi-shaped text(value) and console.log/info/warn/error/debug(...values), plus
  existing print(...values), all append to the same bounded UTF-8 output buffer.
  Primitive text uses String (including undefined, null and BigInt); objects
  use JSON. Circular JSON still throws. console is frozen; no host stdout sink.
  This is API preparation, not full Pi parity. Pi uses separate output items and
  fail-on-output-limit; mini currently combines text and truncates with a notice.

## Out of scope
- REPL Rhai (repl.rs), web UI, benchmark wiring. No change to r1b anything.
