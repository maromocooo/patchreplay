import fs from "node:fs";
import path from "node:path";
import type { Scenario, Step } from "./scenario.js";
import type { SideResult } from "./runner.js";
import type { Verdict } from "./verdict.js";
import { VERDICT_EMOJI } from "./verdict.js";
import { escapeHtml } from "./util.js";
import { shortSha } from "./git.js";

export interface RunRecord {
  id: string;
  createdAt: string;
  repo: string;
  appDir: string;
  task: string;
  baseCommit: string | null;
  afterCommit: string;
  changedFiles: string[];
  scenario: Scenario;
  generator: string;
  before: SideResult | null;
  after: SideResult;
  verdict: Verdict;
  files: { gif?: string; html: string; markdown: string; json: string };
}

function describe(step: Step): string {
  const s = step as Record<string, unknown>;
  const loc = s.role ? `${s.role}${s.name ? ` "${s.name}"` : ""}` : s.selector ? String(s.selector) : s.text ? `"${s.text}"` : "";
  switch (step.action) {
    case "goto":
      return `open ${step.path ?? "/"}`;
    case "fill":
      return `fill ${loc} with "${step.value}"`;
    case "press":
      return `press ${step.key}`;
    case "wait":
      return `wait ${step.ms}ms`;
    case "scroll":
      return `scroll ${step.y}px`;
    case "setViewport":
      return `viewport ${step.width}×${step.height}`;
    case "expectText":
      return `expect text "${step.text}"${step.selector ? ` in ${step.selector}` : ""}`;
    case "expectCount":
      return `expect ${step.count} × ${step.selector}`;
    default:
      return `${step.action} ${loc}`.trim();
  }
}

const mark = (r: SideResult | null, i: number) => {
  if (!r) return "—";
  const s = r.steps[i];
  if (!s) return "·";
  return s.ok ? "✓" : "✗";
};

export function renderMarkdown(rec: RunRecord, gifRelPath?: string): string {
  const lines: string[] = [];
  lines.push(`### ${VERDICT_EMOJI[rec.verdict.kind]} patchreplay: ${rec.verdict.headline}`);
  lines.push("");
  for (const c of rec.verdict.caveats ?? []) lines.push(`> ⚠️ ${c}`, "");
  if (gifRelPath) lines.push(`![patchreplay before/after](${gifRelPath})`, "");
  if (rec.scenario.expectation) lines.push(`**Expected:** ${rec.scenario.expectation}`, "");
  lines.push(`| # | Step | Before | After |`, `|---|---|:---:|:---:|`);
  rec.scenario.steps.forEach((st, i) => {
    lines.push(`| ${i + 1} | ${describe(st).replace(/\|/g, "\\|")} | ${mark(rec.before, i)} | ${mark(rec.after, i)} |`);
  });
  lines.push("");
  lines.push(`${rec.verdict.detail}`);
  if (rec.scenario.revision) {
    lines.push("", `_The first generated check failed on AFTER at step ${rec.scenario.revision.failedStep} and was rewritten once; both versions ran the rewritten check._`);
  }
  lines.push("");
  const base = rec.baseCommit ? `\`${shortSha(rec.baseCommit)}\`` : "none";
  lines.push(
    `<sub>Scenario: ${rec.scenario.source}${rec.scenario.source === "generated" ? ` by ${rec.generator}` : ""} · ` +
      `before ${base} → after \`${shortSha(rec.afterCommit)}\` · ${rec.changedFiles.length} file(s) changed · ` +
      `recorded with [patchreplay](https://github.com/maromocooo/patchreplay)</sub>`,
  );
  return lines.join("\n") + "\n";
}

export function renderHtml(rec: RunRecord, runDir: string): string {
  const rel = (p?: string) => (p ? escapeHtml(path.relative(runDir, p)) : "");
  const video = (r: SideResult | null, label: string) =>
    r?.video
      ? `<figure><figcaption>${label}</figcaption><video src="${rel(r.video)}" controls muted autoplay loop playsinline></video></figure>`
      : `<figure><figcaption>${label}</figcaption><div class="none">${r ? "no video" : "no baseline"}</div></figure>`;
  const rows = rec.scenario.steps
    .map((st, i) => {
      const b = rec.before?.steps[i];
      const a = rec.after.steps[i];
      const cell = (s: typeof a | undefined, r: SideResult | null) =>
        !r ? `<td class="na">—</td>` : !s ? `<td class="na">not reached</td>` :
          `<td class="${s.ok ? "ok" : "bad"}"><a href="${rel(s.screenshot)}">${s.ok ? "✓ pass" : "✗ " + escapeHtml(s.error ?? "fail")}</a></td>`;
      return `<tr><td>${i + 1}</td><td>${escapeHtml(describe(st))}${st.note ? `<div class="note">${escapeHtml(st.note)}</div>` : ""}</td>${cell(b, rec.before)}${cell(a, rec.after)}</tr>`;
    })
    .join("\n");
  const errs = (r: SideResult | null, label: string) =>
    r && r.consoleErrors.length
      ? `<details><summary>${label}: ${r.consoleErrors.length} console error(s)</summary><pre>${escapeHtml(r.consoleErrors.join("\n"))}</pre></details>`
      : "";
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1">
<title>patchreplay ${escapeHtml(rec.id)}</title><style>
:root{--bg:#fff;--fg:#1f2328;--muted:#656d76;--line:#d0d7de;--ok:#1a7f37;--bad:#cf222e;--card:#f6f8fa}
@media (prefers-color-scheme:dark){:root{--bg:#0d1117;--fg:#e6edf3;--muted:#8b949e;--line:#30363d;--ok:#3fb950;--bad:#f85149;--card:#161b22}}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:15px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif}
main{max-width:1200px;margin:0 auto;padding:24px 16px 64px}h1{font-size:22px;margin:0 0 4px}.muted{color:var(--muted)}
.verdict{margin:16px 0;padding:14px 16px;border:1px solid var(--line);border-radius:10px;background:var(--card);font-size:17px;font-weight:600}
.verdict div{font-weight:400;font-size:14px;color:var(--muted);margin-top:4px}.verdict .caveat{color:#bf8700}
.videos{display:grid;grid-template-columns:repeat(auto-fit,minmax(320px,1fr));gap:12px}
figure{margin:0;border:1px solid var(--line);border-radius:10px;overflow:hidden;background:var(--card)}
figcaption{padding:6px 10px;font-weight:600;border-bottom:1px solid var(--line)}video{display:block;width:100%}
.none{padding:60px 0;text-align:center;color:var(--muted)}
table{width:100%;border-collapse:collapse;margin-top:16px}td,th{border-bottom:1px solid var(--line);padding:8px;text-align:left;vertical-align:top}
td.ok a{color:var(--ok)}td.bad a{color:var(--bad)}td.na{color:var(--muted)}.note{color:var(--muted);font-size:13px}
pre{white-space:pre-wrap;background:var(--card);padding:10px;border-radius:8px;overflow:auto}
img.gif{max-width:100%;border-radius:10px;border:1px solid var(--line);margin-top:16px}
textarea{width:100%;height:160px;font:13px ui-monospace,monospace;background:var(--card);color:var(--fg);border:1px solid var(--line);border-radius:8px;padding:8px}
</style></head><body><main>
<h1>patchreplay</h1>
<div class="muted">${escapeHtml(rec.task || "(no task recorded)")} · ${escapeHtml(new Date(rec.createdAt).toLocaleString())}</div>
<div class="verdict">${VERDICT_EMOJI[rec.verdict.kind]} ${escapeHtml(rec.verdict.headline)}<div>${escapeHtml(rec.verdict.detail)}</div>${(rec.verdict.caveats ?? []).map((c) => `<div class="caveat">⚠️ ${escapeHtml(c)}</div>`).join("")}</div>
${rec.scenario.expectation ? `<p><b>Expected:</b> ${escapeHtml(rec.scenario.expectation)}</p>` : ""}
${rec.scenario.revision ? `<p class="muted">The first generated check failed on AFTER at step ${rec.scenario.revision.failedStep} (${escapeHtml(rec.scenario.revision.error)}) and was rewritten once. Both versions ran the rewritten check.</p>` : ""}
<div class="videos">${video(rec.before, "Before")}${video(rec.after, "After")}</div>
<table><thead><tr><th>#</th><th>Step</th><th>Before</th><th>After</th></tr></thead><tbody>${rows}</tbody></table>
${errs(rec.before, "Before")}${errs(rec.after, "After")}
${rec.files.gif ? `<h2>Share</h2><img class="gif" src="${rel(rec.files.gif)}" alt="before/after GIF">` : ""}
<p class="muted">Paste into your PR (drag <code>replay.gif</code> into the comment box first):</p>
<textarea readonly>${escapeHtml(fs.existsSync(rec.files.markdown) ? fs.readFileSync(rec.files.markdown, "utf8") : "")}</textarea>
<p class="muted">Scenario source: ${rec.scenario.source}${rec.scenario.source === "generated" ? ` (${escapeHtml(rec.generator)})` : ""} ·
before <code>${rec.baseCommit ? shortSha(rec.baseCommit) : "none"}</code> → after <code>${shortSha(rec.afterCommit)}</code> ·
changed: ${escapeHtml(rec.changedFiles.slice(0, 12).join(", "))}${rec.changedFiles.length > 12 ? " …" : ""}</p>
<details><summary>Scenario JSON (save as .patchreplay/scenario.json to reuse)</summary><pre>${escapeHtml(JSON.stringify({ title: rec.scenario.title, expectation: rec.scenario.expectation, steps: rec.scenario.steps }, null, 2))}</pre></details>
</main></body></html>`;
}
