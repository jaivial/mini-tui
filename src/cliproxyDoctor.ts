/**
 * `mini-tui doctor [-m <model>]` - why is `cliproxy/...` failing?
 *
 * cli-proxy is a local gateway, so a `cliproxy/` model has more moving parts than a hosted
 * provider: the gateway process, its config, the OAuth file it reads, and an API key both sides
 * have to agree on. Each of those failing looks like the others in a transcript (a refusal, a
 * 401, a 503 in the gateway's own jargon), so the checks run in the order they break a run and
 * stop naming causes at the first one that is wrong. The last stage is mini's own `test-model`,
 * so a green report means a run will work, not merely that a port answers.
 */

import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

import { runHelperScript } from "./helpers";
import { MODELS } from "./models";
import { rustAgentBin } from "./mini/spawn";

export const DOCTOR_SCRIPT = join(import.meta.dir, "..", "scripts", "cliproxy-doctor.py");
const TEST_MODEL_SCRIPT = join(import.meta.dir, "..", "scripts", "test_model.py");

/** The `cliproxy/` model `doctor` probes when none was named: the catalog's first one. */
export function defaultDoctorModel(): string {
  const hit = MODELS.find((option) => String(option.value).startsWith("cliproxy/"));
  return String(hit?.value ?? "cliproxy/claude-opus-5-5");
}

export interface DoctorStage {
  name: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

export interface DoctorReport {
  base: string;
  model: string;
  ok: boolean;
  stages: DoctorStage[];
}

interface RawCheck {
  check: string;
  ok: boolean;
  detail: string;
  fix?: string;
}

/** `scripts/cliproxy-doctor.py --json --skip-completion` (the checks a run cannot skip). */
function probeScript(model: string, env: NodeJS.ProcessEnv): RawCheck[] {
  const result = spawnSync(env.MINITUI_PYTHON || "python3", [DOCTOR_SCRIPT, "-m", model, "--json", "--skip-completion"], {
    env,
    encoding: "utf8",
    timeout: 60_000,
  });
  try {
    const parsed = JSON.parse((result.stdout || "").trim()) as { checks?: RawCheck[] };
    return Array.isArray(parsed.checks) ? parsed.checks : [];
  } catch {
    // Missing script or unparsable output: the end-to-end helper below still decides.
    return [];
  }
}


/** A diagnostic must stay a diagnostic: `test-model` retries, so bound it hard. */
const PROBE_TIMEOUT_MS = 20_000;

/**
 * mini's own one-word completion: the same thing a run does (`test-model`).
 *
 * It is bounded, because `test-model` retries transient errors and a diagnostic that waits out a
 * gateway's backoff is no longer a diagnosis - the earlier stages already said what is wrong.
 */
async function testModel(model: string, env: NodeJS.ProcessEnv): Promise<number> {
  const vars: Record<string, string> = {};
  for (const [key, value] of Object.entries(env)) if (value !== undefined) vars[key] = value;
  const rust = rustAgentBin(env);
  if (rust) {
    return new Promise((resolve) => {
      const child = spawn(rust, ["test-model", model], { env: vars, stdio: "ignore" });
      const timer = setTimeout(() => {
        child.kill("SIGKILL");
        resolve(124); // timeout: the stage above already named the cause
      }, PROBE_TIMEOUT_MS);
      child.on("close", (code) => {
        clearTimeout(timer);
        resolve(code ?? -1);
      });
      child.on("error", () => {
        clearTimeout(timer);
        resolve(-1);
      });
    });
  }
  return runHelperScript(TEST_MODEL_SCRIPT, [model], vars);
}

/**
 * Probe one `cliproxy/` model. `runTestModel` is injectable so tests never touch the network.
 */
export async function runDoctor(
  model: string = defaultDoctorModel(),
  options: { env?: NodeJS.ProcessEnv; runTestModel?: (model: string) => Promise<number> } = {},
): Promise<DoctorReport> {
  const env = options.env ?? process.env;
  const base = env.CLIPROXY_API_BASE || "http://127.0.0.1:8317/v1";
  // An injected helper replaces the whole probe: a test stubs the end-to-end stage, so the
  // network stages it cannot know about must not be reported as failures beside it.
  const stages: DoctorStage[] = (options.runTestModel ? [] : probeScript(model, env)).map((check) => ({
    name: check.check,
    ok: check.ok,
    detail: check.detail,
    fix: check.fix,
  }));

  const run = options.runTestModel ?? ((name: string) => testModel(name, env));
  const code = await run(model);
  const ok = code === 0;
  stages.push({
    name: "run works (mini test-model)",
    ok,
    detail: ok ? `${model} answered a one-word completion` : `mini could not complete with ${model} (exit ${code})`,
    fix: ok ? undefined : "see the last FAIL above, or run `mini-tui -p hi -m <model>` for the whole log",
  });

  return { base, model, ok: ok && stages.slice(0, -1).every((stage) => stage.ok), stages };
}

/** Human-readable report. */
export function formatDoctor(report: DoctorReport): string {
  const lines = [`cliproxy via ${report.base}`, ""];
  const width = Math.max(...report.stages.map((stage) => stage.name.length));
  for (const stage of report.stages) {
    lines.push(`${stage.ok ? "PASS" : "FAIL"}  ${stage.name.padEnd(width)}  ${stage.detail}`);
    if (stage.fix) lines.push(`      fix: ${stage.fix}`);
  }
  lines.push("", report.ok ? `${report.model} is ready to run` : `${report.model} is broken at the first FAIL above`);
  return lines.join("\n");
}
