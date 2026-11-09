import path from "node:path";
import { commitTree, repoRoot, treeOf, writeWorkingTree } from "../core/git.js";
import { detectProject } from "../core/devserver.js";
import { readBaseline, recordBaseline, runProof, writeBaseline, ensureExcluded } from "../core/proof.js";
import type { RunRecord } from "../core/report.js";
import { VERDICT_EMOJI } from "../core/verdict.js";
import { log, runCmd, sleep } from "../core/util.js";
import { isHerdrAvailable, listAgents, notify, readAgent, type HerdrAgent } from "./client.js";
import { TurnTracker } from "./tracker.js";
import type { Generator } from "../core/scenario.js";

export interface WatchOptions {
  generator?: Generator | "auto";
  open?: boolean;
  /** Seconds an agent must stay settled before we record (avoids mid-task blips). */
  settleSeconds?: number;
  /** Standalone mode: only this directory. */
  cwd?: string;
}

const SETTLED = new Set(["idle", "done"]);

function line(msg: string) {
  const t = new Date().toLocaleTimeString();
  process.stdout.write(`\x1b[2m${t}\x1b[0m ${msg}\n`);
}

function summarize(rec: RunRecord): string {
  return `${VERDICT_EMOJI[rec.verdict.kind]} ${rec.verdict.headline}`;
}

async function finish(rec: RunRecord, opts: WatchOptions) {
  line(`${summarize(rec)}\n   report: ${rec.files.html}`);
  if (isHerdrAvailable()) await notify("patchreplay", `${summarize(rec)} — ${path.basename(rec.repo)}`, "done");
  if (opts.open) await runCmd(process.platform === "darwin" ? "open" : "xdg-open", [rec.files.html]).catch(() => {});
}

/** Only watch repos patchreplay can actually run (a JS app with a dev script). */
async function eligibleRoot(cwd: string | null | undefined): Promise<string | null> {
  if (!cwd) return null;
  const root = await repoRoot(cwd);
  if (!root) return null;
  return detectProject(cwd) || detectProject(root) ? root : null;
}

/**
 * herdr mode: each time an agent finishes a turn (worked, then settled), replay before/after for its repo.
 * The baseline is the working tree when the agent started working (or when the watcher started).
 */
export async function watchHerdr(opts: WatchOptions): Promise<never> {
  const tracker = new TurnTracker((opts.settleSeconds ?? 4) * 1000);
  const busy = new Set<string>(); // repo roots with a run in progress
  const queue: { agent: HerdrAgent; root: string }[] = [];
  const cwdOf = (a: HerdrAgent) => a.foreground_cwd ?? a.cwd ?? null;

  const ensureBaseline = async (a: HerdrAgent, why: string) => {
    const cwd = cwdOf(a);
    const root = await eligibleRoot(cwd);
    if (!root || busy.has(root) || readBaseline(root)) return;
    try {
      await recordBaseline(cwd!, `herdr:${a.pane_id}`, a.terminal_title_stripped);
      line(`● ${a.agent} in ${path.basename(root)} — baseline saved (${why})`);
    } catch (e) {
      line(`  could not record baseline: ${String(e).slice(0, 120)}`);
    }
  };

  line("watching herdr agents — patchreplay records each finished turn in a JS app repo. Ctrl-C to stop.");
  const initial = await listAgents();
  tracker.seed(initial);
  for (const a of initial) if (SETTLED.has(a.agent_status)) await ensureBaseline(a, "watch started");

  const worker = async () => {
    for (;;) {
      const job = queue.shift();
      if (!job) {
        await sleep(500);
        continue;
      }
      busy.add(job.root);
      try {
        // Agents sometimes flush a last write right after going idle: wait for a quiet tree.
        let prev = "";
        for (let i = 0; i < 10; i++) {
          const t = await writeWorkingTree(job.root);
          if (t === prev) break;
          prev = t;
          await sleep(1500);
        }
        const title = job.agent.terminal_title_stripped ?? "";
        const recent = await readAgent(job.agent.pane_id, 40);
        const base = readBaseline(job.root);
        // Agents retitle their pane to summarize the current turn; the title at finish describes it best.
        const generic = /^(claude code|codex|opencode|pi|gemini)?$/i;
        const task = !generic.test(title.trim()) ? title : base?.task && !generic.test(base.task.trim()) ? base.task : "";
        const context = recent ? `Recent agent terminal output (may include unrelated UI):\n${recent.slice(-3000)}` : undefined;
        line(`▶ ${job.agent.agent} in ${path.basename(job.root)} finished — recording replay…`);
        const rec = await runProof({
          cwd: cwdOf(job.agent) ?? job.root,
          task,
          context,
          generator: opts.generator,
          // The state we just verified becomes the next "before", so edits that land
          // while we record are compared in the next run instead of being absorbed.
          advanceBaseline: true,
          onProgress: (m) => line(`  ${m}`),
        });
        await finish(rec, opts);
      } catch (err) {
        // The baseline is left as it was: nothing unverified gets folded into it.
        const msg = String((err as Error).message ?? err);
        if (msg.startsWith("nothing changed")) line(`  (no file changes in ${path.basename(job.root)} — skipped)`);
        else line(`  ✗ ${msg.split("\n")[0]} (changes stay pending for the next run)`);
      } finally {
        busy.delete(job.root);
      }
    }
  };
  void worker();

  for (;;) {
    let agents: HerdrAgent[] = [];
    try {
      agents = await listAgents();
    } catch (err) {
      line(`herdr unreachable: ${String(err).slice(0, 120)}`);
      await sleep(3000);
      continue;
    }
    const { starts, finishes } = tracker.update(agents, Date.now());
    for (const a of starts) await ensureBaseline(a, "agent started");
    for (const a of finishes) {
      const root = await eligibleRoot(cwdOf(a));
      if (!root) continue;
      // Queue even while this repo is being recorded; the next run picks up from the last verified state.
      if (queue.some((q) => q.root === root)) line(`  (${a.agent} in ${path.basename(root)} finished again — will be included in the queued run)`);
      else {
        if (busy.has(root)) line(`  (${a.agent} in ${path.basename(root)} finished while recording — queued)`);
        queue.push({ agent: a, root });
      }
    }
    await sleep(1000);
  }
}

/**
 * Standalone mode (no herdr): poll the working tree; when it changes and then stays quiet,
 * replay the state before the burst of edits against the state after it.
 */
export async function watchDirectory(opts: WatchOptions & { quietSeconds?: number }): Promise<never> {
  const cwd = opts.cwd ?? process.cwd();
  const root = await repoRoot(cwd);
  if (!root) throw new Error(`not a git repository: ${cwd}`);
  await ensureExcluded(root);
  const quietMs = (opts.quietSeconds ?? 10) * 1000;
  let stableTree = await writeWorkingTree(root);
  let lastTree = stableTree;
  let lastChange = 0;
  let failedTree: string | null = null; // a tree whose replay failed; wait for further edits
  line(`watching ${root} — edits followed by ${quietMs / 1000}s of quiet trigger a replay. Ctrl-C to stop.`);
  for (;;) {
    await sleep(2000);
    const tree = await writeWorkingTree(root).catch(() => lastTree);
    if (tree !== lastTree) {
      if (lastTree === stableTree) line("● change detected — waiting for edits to settle…");
      lastTree = tree;
      lastChange = Date.now();
      continue;
    }
    if (tree !== stableTree && tree !== failedTree && Date.now() - lastChange >= quietMs) {
      const baseCommit = await commitTree(root, stableTree, "baseline");
      writeBaseline(root, baseCommit, "watch");
      try {
        const rec = await runProof({ cwd, generator: opts.generator, onProgress: (m) => line(`  ${m}`) });
        await finish(rec, opts);
        // Advance only to the state that was actually replayed. Edits made while recording
        // differ from it and trigger the next replay instead of being absorbed.
        stableTree = await treeOf(root, rec.afterCommit);
        failedTree = null;
      } catch (err) {
        // Keep the old baseline: the next replay still covers these unverified edits.
        line(`  ✗ ${String((err as Error).message ?? err).split("\n")[0]} (changes stay pending; edit again to retry)`);
        failedTree = tree;
      }
      lastTree = tree;
    }
  }
}

export { log };
