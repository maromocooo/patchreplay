import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { chromium, type Browser, type Locator, type Page } from "playwright-core";
import type { Scenario, Step } from "./scenario.js";
import { isAssertion } from "./scenario.js";
import { log, runCmd } from "./util.js";

export interface StepResult {
  index: number;
  step: Step;
  ok: boolean;
  error?: string;
  ms: number;
  screenshot: string; // path to PNG
}

export interface SideResult {
  label: "before" | "after";
  url: string;
  steps: StepResult[];
  video?: string;
  consoleErrors: string[];
  /** Index of first failing step, or -1. Steps after a failure still run (best effort). */
  firstFailure: number;
}

export const VIEWPORT = { width: 1024, height: 640 };

export async function launchBrowser(): Promise<Browser> {
  try {
    return await chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  } catch (err) {
    if (!String(err).includes("Executable doesn't exist")) throw err;
    log.info("installing Chromium for Playwright (first run only)…");
    const require = createRequire(import.meta.url);
    const cli = path.join(path.dirname(require.resolve("playwright-core/package.json")), "cli.js");
    const r = await runCmd(process.execPath, [cli, "install", "chromium-headless-shell"], { timeoutMs: 600000 });
    if (r.code !== 0) throw new Error(`could not install Chromium: ${r.stderr.slice(-800)}`);
    return chromium.launch({ headless: true, handleSIGINT: false, handleSIGTERM: false, handleSIGHUP: false });
  }
}

function locate(page: Page, s: { selector?: string; text?: string; role?: string; name?: string }): Locator {
  if (s.role) return page.getByRole(s.role as Parameters<Page["getByRole"]>[0], s.name ? { name: s.name } : {}).first();
  if (s.selector) return page.locator(s.selector).first();
  return page.getByText(s.text!, { exact: false }).first();
}

const STEP_TIMEOUT = 5000;

async function runStep(page: Page, base: string, step: Step): Promise<void> {
  switch (step.action) {
    case "goto": {
      const target = new URL(step.path ?? "/", base);
      if (target.origin !== new URL(base).origin) throw new Error(`refusing to leave the app: ${target.origin}`);
      const res = await page.goto(target.toString(), { waitUntil: "load", timeout: 20000 });
      // A 404/500 page is a failed navigation, not app behavior to assert on.
      if (res && res.status() >= 400) throw new Error(`HTTP ${res.status()} for ${target.pathname}`);
      await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
      return;
    }
    case "click":
      return locate(page, step).click({ timeout: STEP_TIMEOUT });
    case "dblclick":
      return locate(page, step).dblclick({ timeout: STEP_TIMEOUT });
    case "hover":
      return locate(page, step).hover({ timeout: STEP_TIMEOUT });
    case "fill":
      return locate(page, step).fill(step.value, { timeout: STEP_TIMEOUT });
    case "press":
      if (step.selector) return page.locator(step.selector).first().press(step.key, { timeout: STEP_TIMEOUT });
      return page.keyboard.press(step.key);
    case "wait":
      return page.waitForTimeout(Math.min(step.ms, 5000));
    case "waitFor":
      return locate(page, step).waitFor({ state: "visible", timeout: STEP_TIMEOUT });
    case "scroll":
      await page.mouse.wheel(0, step.y);
      return page.waitForTimeout(250);
    case "setViewport":
      return page.setViewportSize({ width: step.width, height: step.height });
    case "expectVisible":
      return locate(page, step)
        .waitFor({ state: "visible", timeout: STEP_TIMEOUT })
        .catch(() => {
          throw new Error("not visible after 5s");
        });
    case "expectHidden":
      return locate(page, step)
        .waitFor({ state: "hidden", timeout: STEP_TIMEOUT })
        .catch(() => {
          throw new Error("still visible after 5s");
        });
    case "expectText": {
      const scope = step.selector ? page.locator(step.selector).first() : page.locator("body");
      const deadline = Date.now() + STEP_TIMEOUT;
      while (Date.now() < deadline) {
        const t = await scope.innerText({ timeout: STEP_TIMEOUT }).catch(() => "");
        if (t.includes(step.text)) return;
        await page.waitForTimeout(150);
      }
      throw new Error(`text not found: ${JSON.stringify(step.text)}`);
    }
    case "expectCount": {
      const deadline = Date.now() + STEP_TIMEOUT;
      let n = -1;
      while (Date.now() < deadline) {
        n = await page.locator(step.selector).count();
        if (n === step.count) return;
        await page.waitForTimeout(150);
      }
      throw new Error(`expected ${step.count} × ${step.selector}, found ${n}`);
    }
  }
}

export async function runScenario(
  browser: Browser,
  scenario: Scenario,
  url: string,
  label: SideResult["label"],
  outDir: string,
): Promise<SideResult> {
  const dir = path.join(outDir, label);
  fs.mkdirSync(dir, { recursive: true });
  const context = await browser.newContext({
    viewport: VIEWPORT,
    deviceScaleFactor: 1,
    recordVideo: { dir, size: VIEWPORT },
  });
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text().slice(0, 300));
  });
  page.on("pageerror", (e) => consoleErrors.push(String(e).slice(0, 300)));

  const steps: StepResult[] = [];
  let firstFailure = -1;
  const appOrigin = new URL(url).origin;
  const offApp = () => {
    try {
      const o = new URL(page.url()).origin;
      return o !== "null" && o !== appOrigin ? o : null;
    } catch {
      return null;
    }
  };
  for (const [index, step] of scenario.steps.entries()) {
    const t0 = Date.now();
    let ok = true;
    let error: string | undefined;
    try {
      // Never run a step against a page outside the app (e.g. after a late redirect).
      const away = step.action === "goto" ? null : offApp();
      if (away) throw new Error(`navigated away from the app to ${away}`);
      await runStep(page, url, step);
    } catch (err) {
      ok = false;
      error = String((err as Error).message ?? err).split("\n")[0].slice(0, 300);
      if (firstFailure < 0) firstFailure = index;
    }
    // A step that navigated off the app (e.g. an external link) ends the run.
    const away = offApp();
    const leftApp = away !== null;
    if (ok && leftApp) {
      ok = false;
      error = `navigated away from the app to ${away}`;
      if (firstFailure < 0) firstFailure = index;
    }
    // Let the UI settle so the screenshot shows the effect of the step.
    if (!isAssertion(step)) await page.waitForTimeout(150);
    const screenshot = path.join(dir, `step-${String(index + 1).padStart(2, "0")}.png`);
    await page.screenshot({ path: screenshot }).catch(() => {});
    steps.push({ index, step, ok, error, ms: Date.now() - t0, screenshot });
    // A failed navigation makes later steps meaningless.
    if (!ok && (step.action === "goto" || leftApp)) break;
  }
  const video = page.video();
  await context.close();
  let videoPath: string | undefined;
  if (video) {
    const raw = await video.path().catch(() => undefined);
    if (raw && fs.existsSync(raw)) {
      videoPath = path.join(dir, `${label}.webm`);
      fs.renameSync(raw, videoPath);
    }
  }
  return { label, url, steps, video: videoPath, consoleErrors, firstFailure };
}

/** A11y snapshot of the page, used as grounding for scenario generation. */
export async function pageSnapshot(browser: Browser, url: string): Promise<string> {
  const context = await browser.newContext({ viewport: VIEWPORT });
  const page = await context.newPage();
  try {
    await page.goto(url, { waitUntil: "load", timeout: 20000 });
    await page.waitForLoadState("networkidle", { timeout: 5000 }).catch(() => {});
    return await page.locator("body").ariaSnapshot({ timeout: 5000 });
  } catch (err) {
    return `(snapshot failed: ${String(err).slice(0, 200)})`;
  } finally {
    await context.close();
  }
}
