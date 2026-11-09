import { spawn, type SpawnOptions } from "node:child_process";
import net from "node:net";

export interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Run a command (argv, no shell) and collect output. Never throws on non-zero exit. */
export function runCmd(
  cmd: string,
  args: string[],
  opts: SpawnOptions & { input?: string; timeoutMs?: number } = {},
): Promise<ExecResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { ...opts, stdio: ["pipe", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let timer: NodeJS.Timeout | undefined;
    if (opts.timeoutMs) {
      timer = setTimeout(() => child.kill("SIGTERM"), opts.timeoutMs);
    }
    child.stdout!.on("data", (d) => (stdout += d));
    child.stderr!.on("data", (d) => (stderr += d));
    child.on("error", (err) => {
      if (timer) clearTimeout(timer);
      reject(err);
    });
    child.on("close", (code) => {
      if (timer) clearTimeout(timer);
      resolve({ code: code ?? -1, stdout, stderr });
    });
    if (opts.input !== undefined) child.stdin!.end(opts.input);
    else child.stdin!.end();
  });
}

const ANSI_RE = /\x1b\[[0-9;?]*[ -/]*[@-~]|\x1b\][^\x07]*(\x07|\x1b\\)/g;
export function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, "");
}

export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = net.createServer();
    srv.unref();
    srv.on("error", reject);
    srv.listen(0, "127.0.0.1", () => {
      const addr = srv.address();
      if (addr && typeof addr === "object") {
        const { port } = addr;
        srv.close(() => resolve(port));
      } else reject(new Error("could not allocate port"));
    });
  });
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

export function runId(date = new Date()): string {
  const p = (n: number) => String(n).padStart(2, "0");
  return (
    `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-` +
    `${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
  );
}

export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export const log = {
  info: (msg: string) => process.stderr.write(`patchreplay: ${msg}\n`),
  warn: (msg: string) => process.stderr.write(`patchreplay: warning: ${msg}\n`),
};

const exitHandlers = new Set<() => Promise<void>>();
let signalsHooked = false;

/** Register async cleanup to run on SIGINT/SIGTERM/SIGHUP. Returns an unregister function. */
export function onExit(fn: () => Promise<void>): () => void {
  exitHandlers.add(fn);
  if (!signalsHooked) {
    signalsHooked = true;
    for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const) {
      process.once(sig, async () => {
        process.stderr.write(`\npatchreplay: ${sig} — cleaning up…\n`);
        await Promise.allSettled([...exitHandlers].map((h) => h()));
        process.exit(sig === "SIGINT" ? 130 : 143);
      });
    }
  }
  return () => exitHandlers.delete(fn);
}
