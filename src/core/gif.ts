import fs from "node:fs";
import type { Browser } from "playwright-core";
import { PNG } from "pngjs";
// gifenc ships without types; see src/types.d.ts
import gifenc from "gifenc";
import type { SideResult } from "./runner.js";
import type { Verdict } from "./verdict.js";
import { VERDICT_EMOJI } from "./verdict.js";
import { escapeHtml } from "./util.js";

const { GIFEncoder, quantize, applyPalette } = gifenc;

const FRAME_W = 1200;
const FRAME_H = 500;

function stepLabel(r: SideResult, i: number): { text: string; ok: boolean | null } {
  const s = r.steps[i];
  if (!s) return { text: "(not reached)", ok: null };
  const desc = s.step.note ?? s.step.action;
  return { text: `${s.ok ? "✓" : "✗"} ${desc}`, ok: s.ok };
}

const PANE_W = 580; // rendered width of one screenshot in the frame
const PANE_H = 362;

/** Outline the step's target and, if it is small, add a magnified inset so the change is readable. */
type Box = { x: number; y: number; width: number; height: number };

function highlight(st: SideResult["steps"][number], src: string, cls: string, pair?: Box): string {
  if (!st.viewport || !src) return "";
  const vw0 = st.viewport.width;
  const small = (b?: Box) => !!b && (b.width / vw0) * PANE_W < 220;
  // Outline our own target; magnify our target if small, else the other side's (same spot, for comparison).
  const zoomBox = small(st.box) ? st.box : small(pair) ? pair : undefined;
  if (!st.box && !zoomBox) return "";
  const { x, y, width: w, height: h } = st.box ?? zoomBox!;
  const vw = st.viewport.width;
  const vh = st.viewport.height;
  const color = cls === "bad" ? "#ff7b72" : "#3fb950";
  const pct = (v: number, total: number) => `${((v / total) * 100).toFixed(2)}%`;
  let out = st.box
    ? `<div class="hl" style="left:${pct(x, vw)};top:${pct(y, vh)};width:${pct(w, vw)};height:${pct(h, vh)};border-color:${color}"></div>`
    : "";
  if (zoomBox) {
    const { x, y, width: w, height: h } = zoomBox;
    // Magnify so the target is ~3x more legible than in the frame, capped to fit the inset.
    const pad = 6;
    const zoom = Math.min(3.2 * (PANE_W / vw), 360 / (w + pad * 2), 110 / (h + pad * 2));
    if (zoom / (PANE_W / vw) < 1.5) return out; // would not be more legible
    const iw = Math.round((w + pad * 2) * zoom);
    const ih = Math.round((h + pad * 2) * zoom);
    const bx = -Math.round((x - pad) * zoom);
    const by = -Math.round((y - pad) * zoom);
    const top = y / vh > 0.5 ? "top:10px" : "bottom:10px";
    out += `<div class="zoom" style="${top};width:${iw}px;height:${ih}px;border-color:${color};background-image:url(${src});background-size:${Math.round(vw * zoom)}px ${Math.round(vh * zoom)}px;background-position:${bx}px ${by}px"></div>`;
  }
  return out;
}

function frameHtml(opts: {
  before: SideResult | null;
  after: SideResult;
  i: number;
  total: number;
  title: string;
  verdict?: Verdict;
}): string {
  const img = (p?: string) => (p && fs.existsSync(p) ? `data:image/png;base64,${fs.readFileSync(p).toString("base64")}` : "");
  const pane = (label: string, r: SideResult | null) => {
    if (!r) return `<div class="pane empty"><div class="tag">${label}</div><div class="none">no baseline</div></div>`;
    const s = stepLabel(r, opts.i);
    const cls = s.ok === null ? "" : s.ok ? "ok" : "bad";
    const st = r.steps[opts.i] ?? r.steps[r.steps.length - 1];
    const src = img(st?.screenshot);
    const other = r === opts.after ? opts.before : opts.after;
    const pair = other?.steps[opts.i]?.box;
    return `<div class="pane"><div class="tag">${label}</div>
      <div class="shot"><img src="${src}">${st ? highlight(st, src, cls, pair) : ""}</div>
      <div class="step ${cls}">${escapeHtml(s.text)}</div></div>`;
  };
  const footer = opts.verdict
    ? `<div class="verdict">${VERDICT_EMOJI[opts.verdict.kind]} ${escapeHtml(opts.verdict.headline)}${opts.verdict.caveats.length ? `<div class="cav">⚠️ ${escapeHtml(opts.verdict.caveats[0])}</div>` : ""}</div>`
    : `<div class="progress">step ${opts.i + 1} / ${opts.total}</div>`;
  return `<!doctype html><html><head><meta charset="utf-8"><style>
    *{box-sizing:border-box;margin:0}
    body{width:${FRAME_W}px;height:${FRAME_H}px;background:#0d1117;color:#e6edf3;font:15px -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;padding:12px 14px}
    .head{display:flex;justify-content:space-between;align-items:center;height:26px}
    .brand{font-weight:700;letter-spacing:.3px}.brand b{color:#7ee787}
    .title{color:#8b949e;max-width:760px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
    .row{display:flex;gap:12px;margin-top:8px}
    .pane{flex:1;position:relative;border:1px solid #30363d;border-radius:8px;overflow:hidden;background:#161b22}
    .shot{position:relative;height:362px;overflow:hidden}
    .pane img{display:block;width:100%;height:362px;object-fit:fill}
    .hl{position:absolute;border:2px solid;border-radius:4px;box-shadow:0 0 0 2000px #0000;pointer-events:none}
    .zoom{position:absolute;right:10px;border:2px solid;border-radius:6px;background-repeat:no-repeat;box-shadow:0 6px 24px #000a;background-color:#fff}
    .tag{position:absolute;top:8px;left:8px;background:#000c;padding:2px 9px;border-radius:999px;font-weight:600;font-size:13px}
    .step{padding:8px 10px;font-size:14px;white-space:nowrap;overflow:hidden;text-overflow:ellipsis;border-top:1px solid #30363d}
    .step.ok{color:#7ee787}.step.bad{color:#ff7b72;background:#ff7b7214}
    .empty .none{height:398px;display:flex;align-items:center;justify-content:center;color:#8b949e}
    .progress,.verdict{margin-top:10px;text-align:center;font-weight:600;color:#8b949e}
    .verdict{color:#e6edf3;font-size:17px}.cav{font-size:13px;color:#d29922;font-weight:500;margin-top:2px}
  </style></head><body>
    <div class="head"><div class="brand"><b>patch</b>replay</div><div class="title">${escapeHtml(opts.title)}</div></div>
    <div class="row">${pane("BEFORE", opts.before)}${pane("AFTER", opts.after)}</div>
    ${footer}
  </body></html>`;
}

/** Render side-by-side before/after frames (one per step + a verdict card) into an animated GIF. */
export async function renderGif(
  browser: Browser,
  opts: { before: SideResult | null; after: SideResult; title: string; verdict: Verdict; out: string },
): Promise<void> {
  const context = await browser.newContext({ viewport: { width: FRAME_W, height: FRAME_H }, deviceScaleFactor: 1 });
  const page = await context.newPage();
  const total = Math.max(opts.after.steps.length, opts.before?.steps.length ?? 0);
  const gif = GIFEncoder();
  const frames: { html: string; delay: number }[] = [];
  const { verdict, ...rest } = opts;
  for (let i = 0; i < total; i++) {
    const failedHere = [opts.before, opts.after].some((r) => r?.steps[i] && !r.steps[i].ok);
    frames.push({ html: frameHtml({ ...rest, i, total }), delay: failedHere ? 2200 : 1100 });
  }
  frames.push({ html: frameHtml({ ...rest, i: total - 1, total, verdict }), delay: 3500 });
  const debugDir = process.env.PATCHREPLAY_DEBUG_FRAMES;
  for (const [n, f] of frames.entries()) {
    await page.setContent(f.html, { waitUntil: "load" });
    const buf = await page.screenshot({ type: "png" });
    if (debugDir) fs.writeFileSync(`${debugDir}/frame-${n}.png`, buf);
    const png = PNG.sync.read(buf);
    const rgba = new Uint8Array(png.data.buffer, png.data.byteOffset, png.data.length);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, png.width, png.height, { palette, delay: f.delay });
  }
  gif.finish();
  fs.writeFileSync(opts.out, Buffer.from(gif.bytes()));
  await context.close();
}
