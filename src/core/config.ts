import fs from "node:fs";
import path from "node:path";

/**
 * Optional per-app config: `patchreplay.config.json` next to package.json (commit it).
 *
 * {
 *   "devCmd": ["npx", "concurrently", "-k", "tsx server/index.ts", "vite --port {port} --strictPort"],
 *   "env": { "API_PORT": "{port2}", "APP_DATA_DIR": "{tmp}/data" },
 *   "url": "http://127.0.0.1:{port}/",
 *   "ready": ["http://127.0.0.1:{port}/api/health"]
 * }
 *
 * Placeholders, filled separately for BEFORE and AFTER:
 *   {port}  free port for the app URL     {port2} a second free port (e.g. an API server)
 *   {tmp}   an empty throwaway directory  — point data dirs here so replays never touch real data
 */
export interface AppConfig {
  devCmd?: string[];
  env?: Record<string, string>;
  url?: string;
  /** Extra local URLs that must answer (status < 400) before replaying, e.g. an API health check. */
  ready?: string[];
  /** Seconds to wait for the URL to respond (default 60). */
  startupTimeout?: number;
}

export const CONFIG_FILE = "patchreplay.config.json";

export function loadConfig(appDir: string): AppConfig | null {
  const file = path.join(appDir, CONFIG_FILE);
  if (!fs.existsSync(file)) return null;
  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(file, "utf8"));
  } catch (err) {
    throw new Error(`${CONFIG_FILE}: invalid JSON (${(err as Error).message})`);
  }
  const c = raw as Record<string, unknown>;
  const out: AppConfig = {};
  if (c.devCmd !== undefined) {
    if (!Array.isArray(c.devCmd) || c.devCmd.length === 0 || !c.devCmd.every((a) => typeof a === "string")) {
      throw new Error(`${CONFIG_FILE}: devCmd must be a non-empty array of strings (argv, no shell)`);
    }
    out.devCmd = c.devCmd as string[];
  }
  if (c.env !== undefined) {
    if (!c.env || typeof c.env !== "object" || !Object.values(c.env).every((v) => typeof v === "string")) {
      throw new Error(`${CONFIG_FILE}: env must be an object of strings`);
    }
    out.env = c.env as Record<string, string>;
  }
  if (c.url !== undefined) {
    if (typeof c.url !== "string" || !/^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(c.url)) {
      throw new Error(`${CONFIG_FILE}: url must be a local http(s) URL`);
    }
    out.url = c.url;
  }
  if (c.ready !== undefined) {
    const local = (u: unknown) => typeof u === "string" && /^https?:\/\/(127\.0\.0\.1|localhost|\[::1\])[:/]/.test(u);
    if (!Array.isArray(c.ready) || !c.ready.every(local)) throw new Error(`${CONFIG_FILE}: ready must be an array of local URLs`);
    out.ready = c.ready as string[];
  }
  if (c.startupTimeout !== undefined) {
    if (typeof c.startupTimeout !== "number" || c.startupTimeout <= 0) throw new Error(`${CONFIG_FILE}: startupTimeout must be > 0`);
    out.startupTimeout = c.startupTimeout;
  }
  return out;
}

export interface Placeholders {
  port: number;
  port2: number;
  tmp: string;
}

export function fill(s: string, p: Placeholders): string {
  return s.replace(/\{port\}/g, String(p.port)).replace(/\{port2\}/g, String(p.port2)).replace(/\{tmp\}/g, p.tmp);
}
