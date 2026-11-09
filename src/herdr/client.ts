import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { runCmd } from "../core/util.js";

export interface HerdrAgent {
  pane_id: string;
  workspace_id: string;
  agent: string;
  agent_status: "idle" | "working" | "blocked" | "done" | "unknown" | string;
  cwd?: string | null;
  foreground_cwd?: string | null;
  focused?: boolean;
  terminal_title_stripped?: string;
}

export function socketPath(): string | null {
  const candidates = [
    process.env.HERDR_SOCKET_PATH,
    path.join(os.homedir(), ".config", "herdr", "herdr.sock"),
  ].filter(Boolean) as string[];
  return candidates.find((p) => fs.existsSync(p)) ?? null;
}

let seq = 0;

/** One newline-delimited JSON request over the herdr socket. */
export function request<T = unknown>(method: string, params: object = {}, timeoutMs = 5000): Promise<T> {
  const sock = socketPath();
  if (!sock) return Promise.reject(new Error("herdr socket not found (is herdr running?)"));
  return new Promise((resolve, reject) => {
    const id = `patchreplay_${process.pid}_${++seq}`;
    const s = net.connect(sock);
    let buf = "";
    const timer = setTimeout(() => {
      s.destroy();
      reject(new Error(`herdr ${method} timed out`));
    }, timeoutMs);
    s.on("error", (e) => {
      clearTimeout(timer);
      reject(e);
    });
    s.on("data", (d) => {
      buf += d;
      let nl: number;
      while ((nl = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        let msg: { id?: string; result?: T; error?: { code: string; message: string } };
        try {
          msg = JSON.parse(line);
        } catch {
          continue;
        }
        if (msg.id !== id) continue;
        clearTimeout(timer);
        s.end();
        if (msg.error) reject(new Error(`herdr ${method}: ${msg.error.code}: ${msg.error.message}`));
        else resolve(msg.result as T);
        return;
      }
    });
    s.write(JSON.stringify({ id, method, params }) + "\n");
  });
}

export async function listAgents(): Promise<HerdrAgent[]> {
  const r = await request<{ agents: HerdrAgent[] }>("agent.list");
  return r.agents ?? [];
}

export function herdrBin(): string {
  return process.env.HERDR_BIN_PATH || "herdr";
}

export async function notify(title: string, body: string, sound: "done" | "request" | "none" = "done"): Promise<void> {
  await runCmd(herdrBin(), ["notification", "show", title, "--body", body, "--sound", sound]).catch(() => {});
}

/** Recent terminal text of an agent pane — used as extra task context. */
export async function readAgent(pane: string, lines = 60): Promise<string> {
  const r = await runCmd(herdrBin(), ["agent", "read", pane, "--source", "recent-unwrapped", "--lines", String(lines)]).catch(
    () => null,
  );
  return r && r.code === 0 ? r.stdout : "";
}

export function isHerdrAvailable(): boolean {
  return socketPath() !== null;
}
