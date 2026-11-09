import type { Scenario } from "./scenario.js";
import { isAssertion } from "./scenario.js";
import type { SideResult } from "./runner.js";

export type VerdictKind =
  | "fixed" // after passes every step; before reached an assertion and failed it
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
    const fixed: Verdict = {
      kind: "fixed",
      headline: `Fixed: before fails, after passes ${assertions} check(s)`,
      detail: `Before failed at ${text}`,
      caveats,
    };
    if (caveats.length) fixed.headline = `Fixed (with caveats): before fails, after passes ${assertions} check(s)`;
    return fixed;
  }
  return {
    kind: "no-difference",
    headline: "No behavior difference observed",
    detail: `Both versions pass all ${assertions} check(s). The check may not cover the change.`,
    caveats,
  };
}

export const VERDICT_EMOJI: Record<VerdictKind, string> = {
  fixed: "✅",
  inconclusive: "⚠️",
  "no-difference": "➖",
  "after-fails": "❌",
  "capture-only": "📷",
  "after-only": "☑️",
};
