import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { detectUrl } from "../dist/core/devserver.js";
import { stripAnsi } from "../dist/core/util.js";
import { extractJson, validateScenario } from "../dist/core/scenario.js";
import { decideVerdict } from "../dist/core/verdict.js";
import { TurnTracker } from "../dist/herdr/tracker.js";
import { writeWorkingTree, snapshotWorkingTree, headCommit, treeOf } from "../dist/core/git.js";

test("detectUrl finds Vite's local URL through ANSI colors", () => {
  const out = "\x1b[32m  VITE v7.1.0\x1b[39m  ready in 210 ms\n\n  ➜  \x1b[1mLocal\x1b[22m:   \x1b[36mhttp://127.0.0.1:\x1b[1m5173\x1b[22m/\x1b[39m\n";
  assert.equal(detectUrl(out), "http://127.0.0.1:5173/");
  assert.equal(detectUrl("Server listening on http://0.0.0.0:3000"), "http://127.0.0.1:3000");
  assert.equal(detectUrl("no url here"), null);
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red");
});

test("extractJson pulls the first object out of chatty or fenced output", () => {
  assert.deepEqual(extractJson('Sure!\n```json\n{"a": {"b": "}"}}\n```'), { a: { b: "}" } });
  assert.deepEqual(extractJson('prefix {"steps": []} suffix {"x":1}'), { steps: [] });
  assert.throws(() => extractJson("nothing"));
});

test("validateScenario rejects bad steps and prepends goto", () => {
  const s = validateScenario({ steps: [{ action: "click", text: "Add" }] }, "generated");
  assert.equal(s.steps[0].action, "goto");
  assert.throws(() => validateScenario({ steps: [{ action: "click" }] }, "file"), /needs selector/);
  assert.throws(() => validateScenario({ steps: [{ action: "rm -rf" }] }, "file"), /unknown action/);
  assert.throws(() => validateScenario({ steps: [] }, "file"));
});

const side = (label, oks) => ({
  label,
  url: "",
  consoleErrors: [],
  steps: oks.map((ok, index) => ({ index, ok, step: { action: index === 0 ? "goto" : "expectText", text: "x" }, ms: 1, screenshot: "" })),
  firstFailure: oks.indexOf(false),
});
const scenario = (assertions) => ({
  title: "t",
  source: "file",
  steps: [{ action: "goto" }, ...Array.from({ length: assertions }, () => ({ action: "expectText", text: "x" }))],
});

test("verdict never claims more than was checked", () => {
  assert.equal(decideVerdict(scenario(1), side("before", [true, false]), side("after", [true, true])).kind, "fixed");
  assert.equal(decideVerdict(scenario(1), side("before", [true, true]), side("after", [true, true])).kind, "no-difference");
  assert.equal(decideVerdict(scenario(1), side("before", [true, true]), side("after", [true, false])).kind, "after-fails");
  assert.equal(decideVerdict(scenario(1), null, side("after", [true, true])).kind, "after-only");
  const noAsserts = { title: "t", source: "default", steps: [{ action: "goto" }, { action: "wait", ms: 1 }] };
  assert.equal(decideVerdict(noAsserts, side("before", [true, true]), side("after", [true, true])).kind, "capture-only");
});

test("TurnTracker: a trust prompt clearing is not a finished turn", () => {
  const t = new TurnTracker(4000);
  t.seed([{ pane_id: "p", agent_status: "blocked" }]);
  assert.deepEqual(t.update([{ pane_id: "p", agent_status: "idle" }], 0).finishes, []);
  assert.deepEqual(t.update([{ pane_id: "p", agent_status: "idle" }], 10000).finishes, []);
});

test("TurnTracker: working → settled for settleMs finishes once", () => {
  const t = new TurnTracker(4000);
  t.seed([{ pane_id: "p", agent_status: "idle" }]);
  const a = (s) => [{ pane_id: "p", agent_status: s }];
  assert.equal(t.update(a("working"), 0).starts.length, 1);
  assert.equal(t.update(a("working"), 500).starts.length, 0, "start fires once per turn");
  assert.equal(t.update(a("idle"), 1000).finishes.length, 0);
  assert.equal(t.update(a("working"), 2000).finishes.length, 0, "flicker back to working resets the timer");
  assert.equal(t.update(a("done"), 3000).finishes.length, 0);
  assert.equal(t.update(a("blocked"), 5000).finishes.length, 0, "blocked keeps the turn open");
  assert.equal(t.update(a("idle"), 6000).finishes.length, 0);
  assert.equal(t.update(a("idle"), 10000).finishes.length, 1);
  assert.equal(t.update(a("idle"), 20000).finishes.length, 0, "no duplicate finish");
});

test("snapshots include untracked files, skip ignored ones, and leave the index alone", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-test-"));
  const git = (...args) => execFileSync("git", args, { cwd: dir, encoding: "utf8" });
  git("init", "-q");
  fs.writeFileSync(path.join(dir, ".gitignore"), "ignored.txt\n");
  fs.writeFileSync(path.join(dir, "a.txt"), "1");
  git("add", "-A");
  git("-c", "user.name=t", "-c", "user.email=t@t", "commit", "-qm", "init");
  const head = await headCommit(dir);
  assert.equal(await writeWorkingTree(dir), await treeOf(dir, head), "clean tree equals HEAD");

  fs.writeFileSync(path.join(dir, "a.txt"), "2");
  fs.writeFileSync(path.join(dir, "new.txt"), "untracked");
  fs.writeFileSync(path.join(dir, "ignored.txt"), "secret");
  const statusBefore = git("status", "--porcelain");
  const commit = await snapshotWorkingTree(dir, "t");
  assert.equal(git("status", "--porcelain"), statusBefore, "user's index/status untouched");
  const files = git("ls-tree", "--name-only", commit).trim().split("\n");
  assert.ok(files.includes("new.txt"));
  assert.ok(!files.includes("ignored.txt"));
  assert.equal(git("show", `${commit}:a.txt`), "2");
  assert.equal(git("rev-parse", "refs/patchreplay/t").trim(), commit, "snapshot is pinned");
  fs.rmSync(dir, { recursive: true, force: true });
});

// ---- regressions for publish blockers ----

const sideWith = (label, steps) => ({
  label,
  url: "",
  consoleErrors: [],
  steps: steps.map(([action, ok], index) => ({ index, ok, step: { action, text: "x" }, ms: 1, screenshot: "", error: ok ? undefined : "boom" })),
  firstFailure: steps.findIndex(([, ok]) => !ok),
});
const scen = (...actions) => ({ title: "t", source: "file", steps: actions.map((action) => ({ action, text: "x" })) });

test("BEFORE page failing to load is inconclusive, not fixed", () => {
  const s = scen("goto", "click", "expectText");
  const v = decideVerdict(s, sideWith("before", [["goto", false]]), sideWith("after", [["goto", true], ["click", true], ["expectText", true]]));
  assert.equal(v.kind, "inconclusive");
  assert.match(v.headline, /did not load/);
});

test("BEFORE failing a click is inconclusive, not fixed", () => {
  const s = scen("goto", "click", "expectText");
  const v = decideVerdict(
    s,
    sideWith("before", [["goto", true], ["click", false], ["expectText", false]]),
    sideWith("after", [["goto", true], ["click", true], ["expectText", true]]),
  );
  assert.equal(v.kind, "inconclusive");
});

test("BEFORE dev server failing to start is inconclusive", () => {
  const s = scen("goto", "expectText");
  const v = decideVerdict(s, null, sideWith("after", [["goto", true], ["expectText", true]]), { beforeError: "dev server exited early" });
  assert.equal(v.kind, "inconclusive");
  assert.match(v.detail, /dev server exited early/);
});

test("dependency changes weaken a fixed verdict with a visible caveat", () => {
  const s = scen("goto", "expectText");
  const v = decideVerdict(s, sideWith("before", [["goto", true], ["expectText", false]]), sideWith("after", [["goto", true], ["expectText", true]]), { depsChanged: true });
  assert.equal(v.kind, "fixed");
  assert.match(v.headline, /caveats/);
  assert.equal(v.caveats.length, 1);
});

test("generated scenarios cannot leave the app or smuggle bad values", () => {
  assert.throws(() => validateScenario({ steps: [{ action: "goto", path: "https://evil.example" }] }, "generated"), /starting with a single/);
  assert.throws(() => validateScenario({ steps: [{ action: "goto", path: "//evil.example/x" }] }, "generated"), /starting with a single/);
  assert.throws(() => validateScenario({ steps: [{ action: "expectText", text: "" }] }, "generated"), /non-empty/);
  assert.throws(() => validateScenario({ steps: [{ action: "wait", ms: 999999 }] }, "generated"), /0–5000/);
  assert.throws(() => validateScenario({ steps: [{ action: "expectCount", selector: "li", count: -1 }] }, "generated"), /non-negative/);
  assert.throws(() => validateScenario({ steps: [{ action: "click", selector: 42 }] }, "generated"), /must be a string/);
  assert.equal(validateScenario({ steps: [{ action: "goto", path: "/settings?tab=1" }] }, "generated").steps.length, 1);
});

// ---- runner regressions (needs Playwright's Chromium; skipped if unavailable) ----
import http from "node:http";
import { launchBrowser, runScenario } from "../dist/core/runner.js";

async function withServer(handler, fn) {
  const srv = http.createServer(handler);
  await new Promise((r) => srv.listen(0, "127.0.0.1", r));
  try {
    return await fn(`http://127.0.0.1:${srv.address().port}/`);
  } finally {
    srv.close();
  }
}

test("HTTP 500 on BEFORE is a failed navigation → inconclusive, not fixed", async (t) => {
  let browser;
  try {
    browser = await launchBrowser();
  } catch {
    t.skip("chromium unavailable");
    return;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pp-run-"));
  const s = validateScenario({ steps: [{ action: "goto", path: "/" }, { action: "expectText", text: "hello" }] }, "file");
  try {
    const before = await withServer((_q, res) => { res.statusCode = 500; res.end("<h1>Internal error</h1>"); }, (u) => runScenario(browser, s, u, "before", out));
    const after = await withServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<p>hello</p>"); }, (u) => runScenario(browser, s, u, "after", out));
    assert.equal(before.firstFailure, 0);
    assert.match(before.steps[0].error, /HTTP 500/);
    assert.equal(after.firstFailure, -1);
    assert.equal(decideVerdict(s, before, after).kind, "inconclusive");
  } finally {
    await browser.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

test("a redirect off the app stops the run before the next step executes", async (t) => {
  let browser;
  try {
    browser = await launchBrowser();
  } catch {
    t.skip("chromium unavailable");
    return;
  }
  const out = fs.mkdtempSync(path.join(os.tmpdir(), "pp-run-"));
  try {
    await withServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end("<p>elsewhere</p>"); }, async (other) => {
      const page = `<a id="go" href="${other}">go</a><button id="b">b</button>`;
      await withServer((_q, res) => { res.setHeader("content-type", "text/html"); res.end(page); }, async (u) => {
        const s = validateScenario({ steps: [{ action: "goto", path: "/" }, { action: "click", selector: "#go" }, { action: "click", selector: "#b" }] }, "file");
        const r = await runScenario(browser, s, u, "after", out);
        assert.equal(r.firstFailure, 1);
        assert.match(r.steps[1].error, /navigated away/);
        assert.equal(r.steps.length, 2, "step 3 never ran on the foreign page");
      });
    });
  } finally {
    await browser.close();
    fs.rmSync(out, { recursive: true, force: true });
  }
});

// ---- per-app config ----
import { loadConfig, fill } from "../dist/core/config.js";

test("patchreplay.config.json: placeholders and validation", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "pp-cfg-"));
  const write = (o) => fs.writeFileSync(path.join(dir, "patchreplay.config.json"), JSON.stringify(o));
  assert.equal(loadConfig(dir), null, "no file → null");
  write({ devCmd: ["vite", "--port", "{port}"], env: { DATA: "{tmp}/data", API: "{port2}" }, url: "http://127.0.0.1:{port}/", ready: ["http://127.0.0.1:{port}/api/health"] });
  const c = loadConfig(dir);
  const p = { port: 4001, port2: 4002, tmp: "/t" };
  assert.deepEqual(c.devCmd.map((a) => fill(a, p)), ["vite", "--port", "4001"]);
  assert.equal(fill(c.env.DATA, p), "/t/data");
  assert.equal(fill(c.env.API, p), "4002");
  write({ devCmd: "npm run dev" });
  assert.throws(() => loadConfig(dir), /argv/);
  write({ url: "https://example.com/" });
  assert.throws(() => loadConfig(dir), /local/);
  write({ ready: ["http://evil.example/"] });
  assert.throws(() => loadConfig(dir), /local/);
  fs.rmSync(dir, { recursive: true, force: true });
});
