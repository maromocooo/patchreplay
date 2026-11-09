import type { Scenario } from "./scenario.js";
import { isAssertion } from "./scenario.js";
import type { SideResult } from "./runner.js";

export type VerdictKind =
  | "verified" // after passes every step; before reached an assertion and failed it
  | "inconclusive" // before broke for a reason that is not an assertion (load/interaction/startup)
  | "no-difference" // both pass every step
  | "after-fails" // after fails a step
  | "capture-only" // no assertions: we recorded behavior, we did not check it
  | "after-only"; // no baseline available; after passes

export interface Verdict {
  kind: VerdictKind;
  headline: string;
  detail: string;
  /** Conditions that weaken the verdict; always shown next to it. */
  caveats: string[];
}

export interface VerdictContext {
  /** Set when a baseline existed but its dev server could not be started. */
  beforeError?: string;
  /** package.json / lockfile changed: before ran with after's node_modules. */
  depsChanged?: boolean;
}

const stepRef = (r: SideResult) => {
  const s = r.steps[r.firstFailure];
  return { s, text: `step ${s.index + 1} (${s.step.action})${s.error ? `: ${s.error}` : ""}` };
};

/**
 * Honest summary. Never claims verification the scenario did not perform:
 * "fixed" requires that BEFORE got as far as an assertion and failed *that assertion*.
 * A page that did not load or a click that could not happen is not evidence of a bug.
 */
export function decideVerdict(
  scenario: Scenario,
  before: SideResult | null,
  after: SideResult,
  ctx: VerdictContext = {},
): Verdict {
  const assertions = scenario.steps.filter(isAssertion).length;
  const caveats: string[] = [];
  if (ctx.depsChanged) {
    caveats.push("Dependencies changed between versions; BEFORE ran with AFTER's node_modules.");
  }
  if (after.firstFailure >= 0) {
    const { s, text } = stepRef(after);
    return {
      kind: "after-fails",
      headline: isAssertion(s.step)
        ? "After the change, the check fails"
        : "After the change, the check could not run to the end",
      detail: `After failed at ${text}`,
      caveats,
    };
  }
  if (assertions === 0) {
    return {
      kind: "capture-only",
      headline: "Captured only — nothing was asserted",
      detail: "This replay shows behavior; it does not verify any expectation.",
      caveats,
    };
  }
  if (!before) {
    if (ctx.beforeError) {
      return {
        kind: "inconclusive",
        headline: "Inconclusive — the BEFORE version could not be started",
        detail: `After passes ${assertions} check(s), but there is nothing to compare: ${ctx.beforeError}`,
        caveats,
      };
    }
    return {
      kind: "after-only",
      headline: `After passes ${assertions} check(s) — no "before" baseline`,
      detail: "patchreplay started after the change, so there is nothing to compare against.",
      caveats,
    };
  }
  if (before.firstFailure >= 0) {
    const { s, text } = stepRef(before);
    if (!isAssertion(s.step)) {
      return {
        kind: "inconclusive",
        headline:
          s.step.action === "goto"
            ? "Inconclusive — the BEFORE page did not load"
            : "Inconclusive — BEFORE could not perform a step",
        detail: `Before stopped at ${text}. That is not an assertion, so this is not a verified fix.`,
        caveats,
      };
    }
    const intent = scenario.intent ?? "change";
    const word = intent === "fix" ? "Fixed" : intent === "feature" ? "Added" : "Verified";
    const what =
      intent === "fix"
        ? `the bug reproduces before and is gone after (${assertions} check(s))`
        : intent === "feature"
          ? `the new behavior appears only after the change (${assertions} check(s))`
          : `the expected change appears only after the change (${assertions} check(s))`;
    return {
      kind: "verified",
      headline: `${word}${caveats.length ? " (with caveats)" : ""}: ${what}`,
      detail:
        intent === "fix"
          ? `Bug reproduced before at ${text}`
          : `Not present before (${text.replace(/^step (\d+) \(([^)]+)\).*$/, "step $1, $2")})`,
      caveats,
    };
  }
  return {
    kind: "no-difference",
    headline: "No behavior difference observed",
    detail: `Both versions pass all ${assertions} check(s). The check may not cover the change.`,
    caveats,
  };
}

export const VERDICT_EMOJI: Record<VerdictKind, string> = {
  verified: "✅",
  inconclusive: "⚠️",
  "no-difference": "➖",
  "after-fails": "❌",
  "capture-only": "📷",
  "after-only": "☑️",
};

export type Tone = "ok" | "bad" | "neutral" | "warn";

/**
 * How to show one step's result. Red is reserved for real problems: when the change is verified,
 * BEFORE "failing" a check just means the new behavior wasn't there yet (or the bug reproduced).
 */
export function stepMark(
  verdict: Verdict,
  intent: Scenario["intent"],
  side: "before" | "after",
  s: { ok: boolean } | undefined,
): { symbol: string; tone: Tone; label: string } {
  if (!s) return { symbol: "·", tone: "neutral", label: "not reached" };
  if (s.ok) return { symbol: "✓", tone: "ok", label: "pass" };
  if (side === "before" && verdict.kind === "verified") {
    if (intent === "fix") return { symbol: "✗", tone: "warn", label: "bug reproduced" };
    if (intent === "feature") return { symbol: "○", tone: "neutral", label: "not there yet" };
    return { symbol: "○", tone: "neutral", label: "different before" };
  }
  return { symbol: "✗", tone: "bad", label: "fail" };
}
