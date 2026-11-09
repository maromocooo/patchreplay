import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { Browser } from "playwright-core";
import {
  addWorktree, changedFiles, diffBetween, headCommit, removeWorktree, repoRoot, resolveRef,
  snapshotWorkingTree, treeOf,
} from "./git.js";
import { detectProject, linkNodeModules, startDevServer, type DevServer } from "./devserver.js";
import {
  buildGeneratorPrompt, defaultScenario, detectGenerator, generateScenario, loadScenarioFile,
  type Generator, type Scenario,
} from "./scenario.js";
import { launchBrowser, pageSnapshot, runScenario, type SideResult } from "./runner.js";
import { decideVerdict } from "./verdict.js";
import { renderGif } from "./gif.js";
import { renderHtml, renderMarkdown, type RunRecord } from "./report.js";
import { log, onExit, runId } from "./util.js";

export interface ProofOptions {
  cwd: string;
  /** Git ref/commit for "before". Default: recorded baseline, else HEAD when the tree is dirty. */
  base?: string;
  task?: string;
  /** Extra context for scenario generation only (e.g. recent agent output). Never written to reports. */
  context?: string;
  scenarioFile?: string;
  generator?: Generator | "auto";
  devCmd?: string[];
  gif?: boolean;
  /** After the run, make AFTER the new baseline (watch mode) instead of discarding the baseline. */
  advanceBaseline?: boolean;
  onProgress?: (msg: string) => void;
}

export interface Baseline {
  commit: string;
  createdAt: string;
  task?: string;
  source: string;
}

export function stateDir(root: string): string {
  return path.join(root, ".patchreplay");
}

/** Keep .patchreplay/ out of git status and out of our own snapshots. */
export async function ensureExcluded(root: string): Promise<void> {
  const { runCmd } = await import("./util.js");
  const r = await runCmd("git", ["rev-parse", "--git-path", "info/exclude"], { cwd: root });
  if (r.code !== 0) return;
  const file = path.resolve(root, r.stdout.trim());
  const cur = fs.existsSync(file) ? fs.readFileSync(file, "utf8") : "";
  if (!cur.split("\n").includes(".patchreplay/")) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.appendFileSync(file, `${cur.endsWith("\n") || cur === "" ? "" : "\n"}.patchreplay/\n`);
  }
}

export async function recordBaseline(cwd: string, source: string, task?: string): Promise<Baseline> {
  const root = await repoRoot(cwd);
  if (!root) throw new Error(`not a git repository: ${cwd}`);
  await ensureExcluded(root);
  const commit = await snapshotWorkingTree(root, "baseline");
  return writeBaseline(root, commit, source, task);
}

export function writeBaseline(root: string, commit: string, source: string, task?: string): Baseline {
  const b: Baseline = { commit, createdAt: new Date().toISOString(), task, source };
  fs.mkdirSync(stateDir(root), { recursive: true });
  fs.writeFileSync(path.join(stateDir(root), "baseline.json"), JSON.stringify(b, null, 2));
  return b;
}

export function readBaseline(root: string): Baseline | null {
  const f = path.join(stateDir(root), "baseline.json");
  return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, "utf8")) as Baseline) : null;
}

/** Locate the npm project: cwd if it has package.json, otherwise the git root. */
function appRelative(root: string, cwd: string): string {
  let dir = path.resolve(cwd);
  while (dir.startsWith(root)) {
    if (fs.existsSync(path.join(dir, "package.json"))) return path.relative(root, dir);
    if (dir === root) break;
    dir = path.dirname(dir);
  }
  return "";
}

export async function runProof(opts: ProofOptions): Promise<RunRecord> {
  const progress = opts.onProgress ?? ((m: string) => log.info(m));
  const root = await repoRoot(opts.cwd);
  if (!root) throw new Error(`not a git repository: ${opts.cwd}`);
  await ensureExcluded(root);
  const rel = appRelative(root, opts.cwd);
  const srcApp = path.join(root, rel);
  const project = detectProject(srcApp);
  if (!project && !opts.devCmd) throw new Error(`no package.json with a "dev" or "start" script in ${srcApp}`);
  if (project && !project.isVite && !opts.devCmd) {
    log.warn("this does not look like a Vite app; pass --dev-cmd '<cmd with {port}>' if the URL is not detected");
  }

  const id = runId();
  const runDir = path.join(stateDir(root), "runs", id);

  progress("snapshotting working tree…");
  const afterCommit = await snapshotWorkingTree(root, `after-${id}`);
  let baseCommit: string | null = null;
  let baseline: Baseline | null = null;
  if (opts.base) baseCommit = await resolveRef(root, opts.base);
  else {
    baseline = readBaseline(root);
    if (baseline) baseCommit = baseline.commit;
    else {
      // No baseline: compare uncommitted changes against HEAD.
      const head = await headCommit(root);
      if (head) baseCommit = head;
    }
  }
  if (baseCommit && (await treeOf(root, baseCommit)) === (await treeOf(root, afterCommit))) {
    throw new Error("nothing changed since the baseline — make a change (or pass --base <ref>) first");
  }
  fs.mkdirSync(runDir, { recursive: true });
  const task = opts.task ?? baseline?.task ?? "";
  const files = baseCommit ? await changedFiles(root, baseCommit, afterCommit) : [];
  const depFiles = ["package.json", "package-lock.json", "pnpm-lock.yaml", "yarn.lock", "bun.lock", "bun.lockb"].map((f) =>
    path.posix.join(rel.split(path.sep).join("/"), f),
  );
  const depsChanged = files.some((f) => depFiles.includes(f));

  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), `patchreplay-${id}-`));
  const wtAfter = path.join(tmp, "after");
  const wtBefore = path.join(tmp, "before");
  let browser: Browser | null = null;
  let server: DevServer | null = null;
  const worktrees: string[] = [];
  // Ctrl-C / SIGTERM mid-run must not leave dev servers or worktrees behind.
  const unregister = onExit(async () => {
    await server?.stop();
    await browser?.close().catch(() => {});
    for (const wt of worktrees) await removeWorktree(root, wt).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  });
  try {
    await addWorktree(root, afterCommit, wtAfter);
    worktrees.push(wtAfter);
    linkNodeModules(srcApp, path.join(wtAfter, rel));
    browser = await launchBrowser();

    progress("starting AFTER dev server…");
    server = await startDevServer(project!, path.join(wtAfter, rel), { devCmd: opts.devCmd });
    progress(`AFTER is up at ${server.url}`);

    let scenario: Scenario;
    let generator: string = "none";
    const scenarioFile = opts.scenarioFile ?? path.join(srcApp, ".patchreplay", "scenario.json");
    if (opts.scenarioFile || fs.existsSync(scenarioFile)) {
      scenario = loadScenarioFile(scenarioFile);
      progress(`using scenario ${path.relative(root, scenarioFile)}`);
    } else {
      const gen = opts.generator && opts.generator !== "auto" ? opts.generator : await detectGenerator();
      generator = gen;
      if (gen === "none") {
        scenario = defaultScenario();
      } else {
        progress(`asking ${gen} to write a check for this change…`);
        try {
          const prompt = buildGeneratorPrompt({
            task: [task, opts.context].filter(Boolean).join("\n\n"),
            diff: baseCommit ? await diffBetween(root, baseCommit, afterCommit) : "(no baseline — diff unavailable)",
            pageSnapshot: await pageSnapshot(browser, server.url),
            url: server.url,
          });
          // The prompt can contain terminal excerpts; keep it only when debugging.
          if (process.env.PATCHREPLAY_DEBUG) fs.writeFileSync(path.join(runDir, "generator-prompt.txt"), prompt);
          scenario = await generateScenario(gen, prompt);
        } catch (err) {
          log.warn(`scenario generation failed (${String(err).slice(0, 200)}); falling back to capture only`);
          scenario = defaultScenario();
        }
      }
    }
    fs.writeFileSync(path.join(runDir, "scenario.json"), JSON.stringify(scenario, null, 2));

    progress("recording AFTER…");
    const after = await runScenario(browser, scenario, server.url, "after", runDir);
    await server.stop();
    server = null;

    let before: SideResult | null = null;
    let beforeError: string | undefined;
    if (baseCommit) {
      await addWorktree(root, baseCommit, wtBefore);
      worktrees.push(wtBefore);
      linkNodeModules(srcApp, path.join(wtBefore, rel));
      progress("starting BEFORE dev server…");
      try {
        server = await startDevServer(project!, path.join(wtBefore, rel), { devCmd: opts.devCmd });
        progress("recording BEFORE…");
        before = await runScenario(browser, scenario, server.url, "before", runDir);
      } catch (err) {
        beforeError = String((err as Error).message ?? err).split("\n")[0].slice(0, 200);
        log.warn(`could not run BEFORE: ${String(err).slice(0, 300)}`);
      } finally {
        await server?.stop();
        server = null;
      }
    }

    const verdict = decideVerdict(scenario, before, after, { beforeError, depsChanged });
    const gifPath = path.join(runDir, "replay.gif");
    if (opts.gif !== false) {
      progress("rendering GIF…");
      await renderGif(browser, { before, after, title: scenario.title, verdict, out: gifPath });
    }
    const rec: RunRecord = {
      id,
      createdAt: new Date().toISOString(),
      repo: root,
      appDir: rel,
      task,
      baseCommit,
      afterCommit,
      changedFiles: files,
      scenario,
      generator,
      before,
      after,
      verdict,
      files: {
        gif: opts.gif !== false ? gifPath : undefined,
        html: path.join(runDir, "report.html"),
        markdown: path.join(runDir, "replay.md"),
        json: path.join(runDir, "result.json"),
      },
    };
    fs.writeFileSync(rec.files.markdown, renderMarkdown(rec, opts.gif !== false ? "replay.gif" : undefined));
    fs.writeFileSync(rec.files.html, renderHtml(rec, runDir));
    fs.writeFileSync(rec.files.json, JSON.stringify(rec, null, 2));
    const latest = path.join(stateDir(root), "latest");
    try {
      fs.unlinkSync(latest);
    } catch {
      /* not there yet */
    }
    fs.symlinkSync(path.join("runs", id), latest);
    if (opts.advanceBaseline) {
      // Watch mode: what we just verified is the "before" of whatever comes next,
      // including edits that landed while we were recording.
      writeBaseline(root, afterCommit, "previous run");
    } else if (baseline && !opts.base) {
      // The baseline has been consumed; the next `run` compares against HEAD again.
      fs.rmSync(path.join(stateDir(root), "baseline.json"), { force: true });
    }
    return rec;
  } finally {
    unregister();
    await server?.stop();
    await browser?.close().catch(() => {});
    for (const wt of worktrees) await removeWorktree(root, wt).catch(() => {});
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
