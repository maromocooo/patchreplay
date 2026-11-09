#!/usr/bin/env node
import path from "node:path";
import { parseArgs } from "node:util";
import { recordBaseline, runProof } from "./core/proof.js";
import { VERDICT_EMOJI } from "./core/verdict.js";
import { repoRoot } from "./core/git.js";
import { runCmd } from "./core/util.js";
import { isHerdrAvailable, listAgents, request } from "./herdr/client.js";
import { watchDirectory, watchHerdr } from "./herdr/watch.js";
import type { Generator } from "./core/scenario.js";
import fs from "node:fs";

const HELP = `patchreplay — your agent said "fixed." Here's the replay.

Usage:
  patchreplay run [options]        Record before/after of the current change and write a report
  patchreplay baseline             Save the current working tree as "before" (run before the agent starts)
  patchreplay watch [options]      Auto-run whenever a herdr agent finishes a turn
                                  (without herdr: when edits in this repo go quiet)
  patchreplay open                 Open the latest report

Options:
  --base <ref>         Compare against this git ref instead of the saved baseline / HEAD
  --task <text>        What the agent was asked to do (improves the generated check)
  --scenario <file>    Use a scenario JSON instead of generating one (.patchreplay/scenario.json is picked up automatically)
  --generator <name>   claude | codex | none | auto (default: auto — first CLI found)
  --dev-cmd <cmd>      Dev server command; {port} is replaced, e.g. "npm run dev -- --port {port}"
  --no-gif             Skip GIF rendering
  --open               Open the HTML report when done
  --herdr-focused      (herdr) run in the repo of the focused agent pane
  --dir                (watch) force directory mode even when herdr is running
  -h, --help
`;

/** cwd of the focused agent pane, falling back to the focused pane of any kind. */
async function focusedAgentCwd(): Promise<string | null> {
  const agents = await listAgents();
  const a = agents.find((x) => x.focused);
  if (a) return a.foreground_cwd ?? a.cwd ?? null;
  const { panes } = await request<{ panes: { focused?: boolean; cwd?: string | null; foreground_cwd?: string | null }[] }>(
    "pane.list",
  );
  const p = panes?.find((x) => x.focused);
  return p ? (p.foreground_cwd ?? p.cwd ?? null) : null;
}

async function openFile(p: string) {
  await runCmd(process.platform === "darwin" ? "open" : "xdg-open", [p]).catch(() => {});
}

async function main() {
  const { values, positionals } = parseArgs({
    allowPositionals: true,
    options: {
      base: { type: "string" },
      task: { type: "string" },
      scenario: { type: "string" },
      generator: { type: "string" },
      "dev-cmd": { type: "string" },
      "no-gif": { type: "boolean" },
      open: { type: "boolean" },
      "herdr-focused": { type: "boolean" },
      "pause-at-end": { type: "boolean" },
      dir: { type: "boolean" },
      help: { type: "boolean", short: "h" },
    },
  });
  const cmd = positionals[0] ?? "help";
  if (values.help || cmd === "help") {
    process.stdout.write(HELP);
    return;
  }
  const generator = (values.generator ?? "auto") as Generator | "auto";
  let cwd = process.cwd();
  if (values["herdr-focused"]) {
    const c = await focusedAgentCwd();
    if (!c) throw new Error("no focused pane found in herdr");
    cwd = c;
  }

  switch (cmd) {
    case "run": {
      const rec = await runProof({
        cwd,
        base: values.base,
        task: values.task,
        scenarioFile: values.scenario ? path.resolve(values.scenario) : undefined,
        generator,
        devCmd: values["dev-cmd"]?.split(" ").filter(Boolean),
        gif: !values["no-gif"],
      });
      process.stdout.write(
        `\n${VERDICT_EMOJI[rec.verdict.kind]} ${rec.verdict.headline}\n   ${rec.verdict.detail}\n\n` +
          `   report:   ${rec.files.html}\n   markdown: ${rec.files.markdown}\n` +
          (rec.files.gif ? `   gif:      ${rec.files.gif}\n` : ""),
      );
      if (values.open) await openFile(rec.files.html);
      process.exitCode = rec.verdict.kind === "after-fails" ? 1 : 0;
      break;
    }
    case "baseline": {
      const b = await recordBaseline(cwd, "cli", values.task);
      process.stdout.write(`baseline saved: ${b.commit.slice(0, 8)}\n`);
      break;
    }
    case "watch": {
      if (isHerdrAvailable() && !values.dir) await watchHerdr({ generator, open: values.open });
      else await watchDirectory({ generator, open: values.open, cwd });
      break;
    }
    case "open": {
      const root = await repoRoot(cwd);
      const p = root && path.join(root, ".patchreplay", "latest", "report.html");
      if (!p || !fs.existsSync(p)) throw new Error("no report yet — run `patchreplay run` first");
      await openFile(p);
      process.stdout.write(`${p}\n`);
      break;
    }
    default:
      process.stderr.write(`unknown command: ${cmd}\n\n${HELP}`);
      process.exitCode = 2;
  }
}

main()
  .catch((err) => {
    process.stderr.write(`patchreplay: ${String((err as Error).message ?? err)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    if (process.argv.includes("--pause-at-end")) {
      process.stdout.write("\nPress Enter to close.");
      await new Promise((r) => process.stdin.once("data", r));
      process.exit();
    }
  });
