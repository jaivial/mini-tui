/**
 * The optional verifier phase: a cheap LLM reads the diff and proposes candidate defects, then Jev
 * (System One) turns them into a typed verdict with probabilities, and fixed thresholds branch it
 * into `auto-fix` / `flag` / `ignore`.
 *
 * Why two steps: the big agent that wrote the code is a poor judge of its own diff, and Jev is a
 * decision model — it answers closed questions with calibrated numbers, it does not read code for
 * defects itself. So a small, cheap reader proposes the candidates ("this `==` compares a number
 * to a string") and Jev answers only the questions whose answers are actionable
 * ("is this a real defect", "how severe", "is it safe to fix without the author").
 *
 * All thresholds live in `THRESHOLDS` below, in one place, so they can be tuned without reading
 * the workflow. They are deliberately conservative: a wrong auto-fix costs more than a missed nit.
 *
 * Degrade honestly: no key, no network or no reader → `degraded` with a reason. Never invent a
 * verdict, and never block the run (this phase runs after the code, so it only ever adds a notice).
 */

import { jevAsk, resolveJevKey, type JevQuestion, type JevResponse } from "./client";
import { gitDiff } from "./diff";

export type VerdictAction = "auto-fix" | "flag" | "ignore";

/** Candidate defects proposed by the cheap reader, before Jev has judged anything. */
export interface VerifierCandidate {
  id: string;
  /** One line: what is wrong and where. */
  summary: string;
  /** The code the candidate points at, so Jev can judge without the whole diff. */
  snippet?: string;
  severity?: string;
  fix?: string;
}

export interface VerifierFinding extends VerifierCandidate {
  /** P(this is a real defect) — the number the primary branch threshold reads. */
  real?: number;
  /** P(this must be fixed before the work is called done). */
  serious?: number;
  /** P(a fix can be applied without asking the author). */
  safe?: number;
  action: VerdictAction;
  why: string;
}

export interface VerifierReport {
  /** `skipped` (both toggles off) · `degraded` (could not run) · `ok`. */
  status: "ok" | "degraded" | "skipped";
  reason?: string;
  /** Jev's concrete model id (`jev-1.13.0`), so a report says what actually judged it. */
  model?: string;
  latencyMs?: number;
  candidates: VerifierCandidate[];
  findings: VerifierFinding[];
  counts: Record<VerdictAction, number>;
}

export const THRESHOLDS = {
  /** P(real defect) at or above this is worth acting on at all. */
  real: 0.5,
  /** P(serious) at or above this escalates a real defect from a note to an auto-fix candidate. */
  serious: 0.6,
  /** P(safe to fix unattended) required before anything is auto-fixed. */
  safe: 0.7,
} as const;

const IGNORE: VerdictAction = "ignore";

/**
 * The verdict branch, in code. Kept separate from the transport so the policy is readable on its
 * own: probabilities in, one of three actions out, no other decision hiding anywhere.
 */
export function branchFinding(candidate: VerifierCandidate, real = 0, serious = 0, safe = 0): VerifierFinding {
  const why = `P(real)=${real.toFixed(2)} P(serious)=${serious.toFixed(2)} P(safe)=${safe.toFixed(2)}`;
  let action: VerdictAction = IGNORE;
  if (real >= THRESHOLDS.real) action = serious >= THRESHOLDS.serious && safe >= THRESHOLDS.safe ? "auto-fix" : "flag";
  return { ...candidate, real, serious, safe, action, why };
}

function countActions(findings: VerifierFinding[]): Record<VerdictAction, number> {
  const counts: Record<VerdictAction, number> = { "auto-fix": 0, flag: 0, ignore: 0 };
  for (const finding of findings) counts[finding.action] += 1;
  return counts;
}

/** The questions, all in one request: Jev answers them in parallel at roughly one round trip. */
function questionsFor(candidates: VerifierCandidate[]): Record<string, JevQuestion> {
  const questions: Record<string, JevQuestion> = {};
  for (const candidate of candidates) {
    // The state is keyed by candidate id (`{"c1": {"summary": …}}`) so each instruction can point
    // at a field Jev can actually resolve. A question referring to a field that does not exist
    // gets no evidence and answers near the prior — which reads as "nothing is wrong" for every
    // candidate at once, i.e. a verifier that silently never fires.
    const where = candidate.snippet ? `\`${candidate.id}.snippet\`` : `\`${candidate.id}.summary\``;
    questions[`${candidate.id}.real`] = {
      type: "noul",
      instructions: `Is the problem described in \`${candidate.id}.summary\` a real defect in the code it points at (${where})? A style preference, a naming choice or a correct-but-odd line is not a defect.`,
    };
    questions[`${candidate.id}.serious`] = {
      type: "noul",
      instructions: `Will the problem in \`${candidate.id}.summary\` cause wrong behaviour, a crash, a security problem or silent data loss if the code in ${where} ships as is?`,
    };
    questions[`${candidate.id}.safe`] = {
      type: "noul",
      instructions: `Can the problem in \`${candidate.id}.summary\` be fixed mechanically, without anyone adding information that is not already in ${where}?`,
    };
  }
  return questions;
}

/** One state entry per candidate, keyed by id (see `questionsFor` on why it is shaped this way). */
export function verdictState(candidates: VerifierCandidate[]): Record<string, VerifierCandidate> {
  const state: Record<string, VerifierCandidate> = {};
  for (const candidate of candidates) state[candidate.id] = candidate;
  return state;
}

function readAnswer(response: JevResponse, id: string): number {
  const answer = response.answers?.[id];
  if (!answer) return 0;
  if (typeof answer.noul === "number") return answer.noul;
  // A choice/score answer still carries probabilities: take P(first label) as the yes-share so a
  // re-typed question degrades into a usable number instead of a silent zero.
  const probs = answer.probabilities ?? {};
  const values = Object.values(probs);
  return values.length ? Math.max(...values) : (typeof answer.confidence === "number" ? answer.confidence : 0);
}

const REVIEWER_PROMPT = [
  "You review a code diff and propose candidate defects for a second, typed judge to verify.",
  "Be specific and terse. Propose at most 6 candidates. Report only defects in the diff itself.",
  "Answer with JSON only: {\"candidates\":[{\"id\":\"c1\",\"summary\":\"...\",\"snippet\":\"...\",\"fix\":\"...\"}]}",
  "Return {\"candidates\":[]} when the diff has no defect you can point at.",
].join("\n");

/**
 * The cheap reader. It is the same OpenAI-compatible shape `/connect` already speaks, so the key
 * comes from the saved connections instead of a second one: any connected provider can play this
 * part. With no connection there is nothing to call, and the phase degrades honestly.
 */
export interface CheapReader {
  model: string;
  call: (prompt: string) => Promise<string>;
}

/** Build a reader over an OpenAI-compatible base url + key (one chat completion, tiny max_tokens). */
export function cheapReader(baseUrl: string, key: string, model: string): CheapReader {
  return {
    model,
    call: async (prompt: string) => {
      const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({
          model,
          messages: [
            { role: "system", content: REVIEWER_PROMPT },
            { role: "user", content: prompt },
          ],
          temperature: 0,
          max_tokens: 800,
        }),
        signal: AbortSignal.timeout(60_000),
      });
      if (!response.ok) throw new Error(`reader: HTTP ${response.status}`);
      const data = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> };
      return data.choices?.[0]?.message?.content ?? "";
    },
  };
}

/** Parse the reader's JSON, tolerating a code fence and surrounding prose. Never throws. */
export function parseCandidates(text: string): VerifierCandidate[] {
  const fenced = text.match(/```(?:json)?\s*([\s\S]*?)```/);
  const body = fenced ? fenced[1]! : text;
  const start = body.indexOf("{");
  const end = body.lastIndexOf("}");
  if (start < 0 || end <= start) return [];
  try {
    const parsed = JSON.parse(body.slice(start, end + 1)) as { candidates?: unknown };
    const rows = Array.isArray(parsed.candidates) ? parsed.candidates : [];
    const out: VerifierCandidate[] = [];
    for (const row of rows.slice(0, 6)) {
      if (!row || typeof row !== "object") continue;
      const candidate = row as Record<string, unknown>;
      const summary = typeof candidate.summary === "string" ? candidate.summary.trim() : "";
      if (!summary) continue;
      out.push({
        id: typeof candidate.id === "string" && candidate.id.trim() ? candidate.id.trim() : `c${out.length + 1}`,
        summary: summary.slice(0, 300),
        snippet: typeof candidate.snippet === "string" ? candidate.snippet.slice(0, 1200) : undefined,
        severity: typeof candidate.severity === "string" ? candidate.severity : undefined,
        fix: typeof candidate.fix === "string" ? candidate.fix.slice(0, 600) : undefined,
      });
    }
    return out;
  } catch {
    return [];
  }
}

/** Bound the diff the reader sees: a whole-file diff is the wrong size for a cheap model. */
export function diffForReview(diff: string, maxChars = 12_000): string {
  return diff.length <= maxChars ? diff : `${diff.slice(0, maxChars)}\n… (diff truncated at ${maxChars} chars)`;
}

export interface VerifyOptions {
  diff: string;
  reader: CheapReader | null;
  /** Why there is no reader (from `pickReader`), shown verbatim when the phase degrades. */
  readerReason?: string;
  /** Default true: a key typed into `/settings` outranks a machine-wide config file. */
  preferVaultKey?: boolean;
}

/**
 * Run the phase. Never throws and never rejects: the caller (the TUI) only ever renders the report,
 * so a failure here is a degraded phase, not a failed run.
 */
export async function verifyDiff(options: VerifyOptions): Promise<VerifierReport> {
  const degrade = (reason: string): VerifierReport => ({ status: "degraded", reason, candidates: [], findings: [], counts: countActions([]) });
  const diff = options.diff.trim();
  if (!diff) return degrade("no diff to review");

  if (!options.reader) {
    return degrade(options.readerReason ?? "no cheap reader configured (connect an OpenAI-compatible provider)");
  }

  let candidates: VerifierCandidate[];
  try {
    const raw = await options.reader.call(`Review this diff:\n\n${diffForReview(diff)}`);
    candidates = parseCandidates(raw);
  } catch (error) {
    return degrade(`reader failed: ${(error as Error).message}`);
  }
  if (!candidates.length) return { status: "ok", candidates: [], findings: [], counts: countActions([]), reason: "reader proposed no candidates" };

  const auth = resolveJevKey(options.preferVaultKey ?? true);
  if (!auth.key) return { ...degrade("no jev api key"), candidates };

  const started = Date.now();
  const result = await jevAsk(verdictState(candidates), questionsFor(candidates), auth);
  if (!result.ok || !result.response) return { ...degrade(result.error ?? "jev call failed"), candidates };

  const response = result.response;
  const findings = candidates.map((candidate) =>
    branchFinding(candidate, readAnswer(response, `${candidate.id}.real`), readAnswer(response, `${candidate.id}.serious`), readAnswer(response, `${candidate.id}.safe`)),
  );
  return {
    status: "ok",
    model: response.model,
    latencyMs: response._meta?.latency_ms ?? Date.now() - started,
    candidates,
    findings,
    counts: countActions(findings),
  };
}

/** One line per finding, for a notice in the transcript. */
export function formatReport(report: VerifierReport): string[] {
  if (report.status === "skipped") return [];
  if (report.status === "degraded") return [`jev · verifier skipped: ${report.reason ?? "unavailable"}`];
  if (!report.findings.length) return [`jev · verifier: nothing to flag (${report.candidates.length} candidates, ${report.model ?? "?"})`];
  const head = `jev · ${report.model ?? "?"} · auto-fix ${report.counts["auto-fix"]} · flag ${report.counts.flag} · ignore ${report.counts.ignore}`;
  return [head, ...report.findings.filter((f) => f.action !== "ignore").map((f) => `  ${f.action === "auto-fix" ? "⛏" : "⚑"} ${f.summary} [${f.why}]`)];
}

export { gitDiff };