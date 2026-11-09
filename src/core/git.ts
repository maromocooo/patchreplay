import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { runCmd } from "./util.js";

async function git(cwd: string, args: string[], env?: NodeJS.ProcessEnv): Promise<string> {
  const r = await runCmd("git", args, { cwd, env: env ? { ...process.env, ...env } : process.env });
  if (r.code !== 0) {
    throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  }
  return r.stdout.trim();
}

export async function repoRoot(cwd: string): Promise<string | null> {
  const r = await runCmd("git", ["rev-parse", "--show-toplevel"], { cwd });
  return r.code === 0 ? r.stdout.trim() : null;
}

export async function headCommit(root: string): Promise<string | null> {
  const r = await runCmd("git", ["rev-parse", "--verify", "-q", "HEAD"], { cwd: root });
  return r.code === 0 ? r.stdout.trim() : null;
}

/**
 * Snapshot the whole working tree (tracked + untracked, respecting .gitignore)
 * into a dangling commit, without touching the user's index, HEAD or files.
 * The commit is pinned under refs/patchreplay/<name> so `git gc` keeps it.
 */
export async function snapshotWorkingTree(root: string, name: string): Promise<string> {
  return commitTree(root, await writeWorkingTree(root), name);
}

/** Write the working tree (tracked + untracked, minus ignored) as a git tree object; returns its hash. */
export async function writeWorkingTree(root: string): Promise<string> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "patchreplay-idx-"));
  const tmpIndex = path.join(tmpDir, "index");
  try {
    const gitDir = await git(root, ["rev-parse", "--absolute-git-dir"]);
    const realIndex = path.join(gitDir, "index");
    if (fs.existsSync(realIndex)) fs.copyFileSync(realIndex, tmpIndex);
    const env = { GIT_INDEX_FILE: tmpIndex };
    await git(root, ["add", "-A", "--", "."], env);
    return await git(root, ["write-tree"], env);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}

/** Wrap a tree in a commit (parent: HEAD) pinned at refs/patchreplay/<name>. */
export async function commitTree(root: string, tree: string, name: string): Promise<string> {
  const head = await headCommit(root);
  const args = ["commit-tree", tree, "-m", `patchreplay snapshot ${name}`];
  if (head) args.splice(2, 0, "-p", head);
  const commit = await git(root, args, {
    GIT_AUTHOR_NAME: "patchreplay",
    GIT_AUTHOR_EMAIL: "patchreplay@localhost",
    GIT_COMMITTER_NAME: "patchreplay",
    GIT_COMMITTER_EMAIL: "patchreplay@localhost",
  });
  await git(root, ["update-ref", `refs/patchreplay/${name}`, commit]);
  return commit;
}

export async function resolveRef(root: string, ref: string): Promise<string> {
  return git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
}

export async function treeOf(root: string, commit: string): Promise<string> {
  return git(root, ["rev-parse", `${commit}^{tree}`]);
}

export async function diffBetween(root: string, a: string, b: string, maxChars = 24000): Promise<string> {
  const d = await git(root, ["diff", "--no-color", "-U3", a, b, "--", ".", ":(exclude)*.lock", ":(exclude)package-lock.json"]);
  return d.length > maxChars ? d.slice(0, maxChars) + "\n… (diff truncated)" : d;
}

export async function changedFiles(root: string, a: string, b: string): Promise<string[]> {
  const out = await git(root, ["diff", "--name-only", a, b]);
  return out ? out.split("\n") : [];
}

export async function addWorktree(root: string, commit: string, dir: string): Promise<void> {
  await git(root, ["worktree", "add", "--detach", "--force", dir, commit]);
}

export async function removeWorktree(root: string, dir: string): Promise<void> {
  await runCmd("git", ["worktree", "remove", "--force", dir], { cwd: root });
  fs.rmSync(dir, { recursive: true, force: true });
  await runCmd("git", ["worktree", "prune"], { cwd: root });
}

export function shortSha(sha: string): string {
  return sha.slice(0, 8);
}
