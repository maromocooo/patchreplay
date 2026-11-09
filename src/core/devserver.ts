import { spawn, type ChildProcess } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fill, type AppConfig } from "./config.js";
import { freePort, onExit, sleep, stripAnsi } from "./util.js";

export interface ProjectInfo {
  /** Directory holding package.json (may be a subdirectory of the git root). */
  appDir: string;
  packageManager: "npm" | "pnpm" | "yarn" | "bun";
  devScript: string;
  isVite: boolean;
}

export function detectProject(appDir: string): ProjectInfo | null {
  const pkgPath = path.join(appDir, "package.json");
  if (!fs.existsSync(pkgPath)) return null;
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const scripts: Record<string, string> = pkg.scripts ?? {};
  const devScript = scripts.dev ?? scripts.start;
  if (!devScript) return null;
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  const isVite = /\bvite\b/.test(devScript) || "vite" in deps;
  let packageManager: ProjectInfo["packageManager"] = "npm";
  if (fs.existsSync(path.join(appDir, "pnpm-lock.yaml"))) packageManager = "pnpm";
  else if (fs.existsSync(path.join(appDir, "yarn.lock"))) packageManager = "yarn";
  else if (fs.existsSync(path.join(appDir, "bun.lockb")) || fs.existsSync(path.join(appDir, "bun.lock")))
    packageManager = "bun";
  return { appDir, packageManager, devScript: scripts.dev ? "dev" : "start", isVite };
}

const URL_RE = /https?:\/\/(?:localhost|127\.0\.0\.1|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:\/[^\s'"]*)?/;

/** Find the first local dev-server URL in (possibly ANSI-colored) log output. */
export function detectUrl(output: string): string | null {
  const m = stripAnsi(output).match(URL_RE);
  if (!m) return null;
  return m[0].replace("0.0.0.0", "127.0.0.1").replace(/[),.;]+$/, "");
}

export interface DevServer {
  url: string;
  proc: ChildProcess;
  output: () => string;
  stop: () => Promise<void>;
}

/**
 * Start the project's dev server on a free port in `dir`.
 * Vite servers get `--port <n> --strictPort --host 127.0.0.1` so before/after never collide.
 */
export async function startDevServer(
  info: ProjectInfo | null,
  dir: string,
  opts: { devCmd?: string[]; config?: AppConfig | null; timeoutMs?: number } = {},
): Promise<DevServer> {
  const port = await freePort();
  let port2 = await freePort();
  while (port2 === port) port2 = await freePort();
  // A fresh scratch dir per server: config can point app data here via {tmp}.
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "patchreplay-app-"));
  const ph = { port, port2, tmp };
  const cfg = opts.config ?? {};
  const devCmd = opts.devCmd?.length ? opts.devCmd : cfg.devCmd;
  // When we choose the port, wait for that exact URL instead of trusting the first URL in the logs
  // (multi-server dev scripts often print an API URL first).
  const expectedUrl = cfg.url ? fill(cfg.url, ph) : devCmd?.some((a) => a.includes("{port}")) ? `http://127.0.0.1:${port}/` : null;
  let cmd: string;
  let args: string[];
  if (devCmd && devCmd.length) {
    [cmd, ...args] = devCmd.map((a) => fill(a, ph));
  } else {
    if (!info) throw new Error("no dev command: add a dev script or devCmd in patchreplay.config.json");
    cmd = info.packageManager;
    const extra = info.isVite ? ["--port", String(port), "--strictPort", "--host", "127.0.0.1"] : [];
    args = info.packageManager === "npm" ? ["run", info.devScript, "--", ...extra] : ["run", info.devScript, ...extra];
  }
  const proc = spawn(cmd, args, {
    cwd: dir,
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
    env: {
      ...process.env,
      PORT: String(port),
      BROWSER: "none",
      FORCE_COLOR: "0",
      CI: "1",
      ...Object.fromEntries(Object.entries(cfg.env ?? {}).map(([k, v]) => [k, fill(v, ph)])),
    },
  });
  let out = "";
  proc.stdout!.on("data", (d) => (out += d));
  proc.stderr!.on("data", (d) => (out += d));

  // Registered at spawn time so Ctrl-C while we wait for the URL still kills the server.
  let unregister = () => {};
  const stop = async () => {
    unregister();
    const cleanTmp = () => fs.rmSync(tmp, { recursive: true, force: true });
    if (proc.exitCode !== null || proc.pid === undefined) return cleanTmp();
    try {
      process.kill(-proc.pid, "SIGTERM");
    } catch {
      /* already gone */
    }
    for (let i = 0; i < 20 && proc.exitCode === null; i++) await sleep(100);
    if (proc.exitCode === null) {
      try {
        process.kill(-proc.pid, "SIGKILL");
      } catch {
        /* ignore */
      }
    }
    cleanTmp();
  };

  unregister = onExit(stop);
  const deadline = Date.now() + (opts.timeoutMs ?? (cfg.startupTimeout ?? 60) * 1000);
  while (Date.now() < deadline) {
    if (proc.exitCode !== null) {
      throw new Error(`dev server exited early (code ${proc.exitCode}):\n${stripAnsi(out).slice(-2000)}`);
    }
    const url = expectedUrl ?? detectUrl(out);
    const readyUrls = (cfg.ready ?? []).map((u) => fill(u, ph));
    if (url && (await reachable(url)) && (await Promise.all(readyUrls.map((u) => reachable(u, 400)))).every(Boolean)) {
      return { url, proc, output: () => out, stop };
    }
    await sleep(250);
  }
  await stop();
  throw new Error(`dev server did not report a reachable URL in time:\n${stripAnsi(out).slice(-2000)}`);
}

async function reachable(url: string, below = 500): Promise<boolean> {
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(2000) });
    return res.status < below;
  } catch {
    return false;
  }
}

/**
 * Make dependencies available in a fresh worktree by symlinking node_modules
 * from the source checkout (fast; fine when the lockfile is unchanged).
 */
export function linkNodeModules(srcAppDir: string, dstAppDir: string): "linked" | "missing" | "present" {
  const src = path.join(srcAppDir, "node_modules");
  const dst = path.join(dstAppDir, "node_modules");
  if (fs.existsSync(dst)) return "present";
  if (!fs.existsSync(src)) return "missing";
  fs.symlinkSync(src, dst, "dir");
  return "linked";
}
