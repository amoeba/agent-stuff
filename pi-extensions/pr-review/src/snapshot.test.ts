import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { prepareSnapshot, removeSnapshot } from "./snapshot.ts";
import { readSafe } from "./files.ts";
import { git, mapConcurrent, revision } from "./git.ts";
import type { ReviewRequest } from "./types.ts";

async function repo() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-fixture-"));
  function command(args: string[]) {
    return execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, encoding: "utf8", env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_NOSYSTEM: "1" } }).trim();
  }
  command(["init", "--quiet", "--initial-branch=main"]);
  await fs.writeFile(path.join(root, "code.ts"), "export const value = 1;\n");
  await fs.writeFile(path.join(root, "empty.txt"), "");
  await fs.writeFile(path.join(root, ".gitignore"), "ignored.txt\n");
  command(["add", "."]); command(["commit", "--quiet", "-m", "initial"]);
  return { root, command, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}
const request = (target: ReviewRequest["target"], exclude: string[] = []): ReviewRequest => ({ target, exclude, context: "" });

test("dirty captures staged + unstaged + untracked, deletions, empty files and mode changes without changing original index", async () => {
  const fixture = await repo();
  let snapshot;
  try {
    await fs.writeFile(path.join(fixture.root, "code.ts"), "export const value = 2;\n");
    fixture.command(["add", "code.ts"]);
    await fs.writeFile(path.join(fixture.root, "code.ts"), "export const value = 3;\n");
    await fs.writeFile(path.join(fixture.root, "new file.txt"), "new\n");
    await fs.writeFile(path.join(fixture.root, "new-empty.txt"), "");
    await fs.writeFile(path.join(fixture.root, "ignored.txt"), "ignore me\n");
    await fs.rm(path.join(fixture.root, "empty.txt"));
    await fs.chmod(path.join(fixture.root, ".gitignore"), 0o755);
    const before = fixture.command(["status", "--porcelain=v1"]);
    const index = fixture.command(["show", ":code.ts"]);
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "dirty" }));
    assert.match(snapshot.diff, /value = 3/);
    assert.match(snapshot.diff, /deleted file mode/);
    assert.match(snapshot.diff, /new-empty.txt/);
    assert.match(snapshot.diff, /old mode 100644\nnew mode 100755/);
    assert.ok(snapshot.changedFiles.includes("new file.txt"));
    assert.ok(!snapshot.files.target.includes("ignored.txt"));
    assert.equal(fixture.command(["status", "--porcelain=v1"]), before);
    assert.equal(fixture.command(["show", ":code.ts"]), index);
  } finally { if (snapshot) await removeSnapshot(snapshot); await fixture.cleanup(); }
});

test("staged reads index content rather than newer worktree content", async () => {
  const fixture = await repo();
  let snapshot;
  try {
    await fs.writeFile(path.join(fixture.root, "code.ts"), "staged\n"); fixture.command(["add", "code.ts"]);
    await fs.writeFile(path.join(fixture.root, "code.ts"), "unstaged\n");
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "staged" }));
    assert.match(snapshot.diff, /\+staged/); assert.doesNotMatch(snapshot.diff, /unstaged/);
    assert.equal(await fs.readFile(path.join(snapshot.workspace, "target", "code.ts"), "utf8"), "staged\n");
  } finally { if (snapshot) await removeSnapshot(snapshot); await fixture.cleanup(); }
});

test("whole branch uses merge base and excludes dirty changes, even when the base advanced", async () => {
  const fixture = await repo();
  let snapshot;
  try {
    const initial = fixture.command(["rev-parse", "HEAD"]);
    fixture.command(["checkout", "--quiet", "-b", "feature"]);
    await fs.writeFile(path.join(fixture.root, "code.ts"), "branch\n"); fixture.command(["add", "."]); fixture.command(["commit", "--quiet", "-m", "feature"]);
    const feature = fixture.command(["rev-parse", "HEAD"]);
    fixture.command(["checkout", "--quiet", "main"]);
    await fs.writeFile(path.join(fixture.root, "base-only.txt"), "base advanced\n"); fixture.command(["add", "."]); fixture.command(["commit", "--quiet", "-m", "base"]);
    fixture.command(["checkout", "--quiet", "feature"]);
    fixture.command(["update-ref", "refs/remotes/origin/main", fixture.command(["rev-parse", "main"])]);
    fixture.command(["symbolic-ref", "refs/remotes/origin/HEAD", "refs/remotes/origin/main"]);
    await fs.writeFile(path.join(fixture.root, "code.ts"), "dirty\n");
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "branch" }));
    assert.equal(snapshot.baseRevision, initial); assert.equal(snapshot.targetRevision, feature);
    assert.match(snapshot.diff, /\+branch/); assert.doesNotMatch(snapshot.diff, /dirty|base-only/);
    assert.equal(await fs.readFile(path.join(snapshot.workspace, "target", "code.ts"), "utf8"), "branch\n");
  } finally { if (snapshot) await removeSnapshot(snapshot); await fixture.cleanup(); }
});

test("branch + dirty and exact ranges resolve correct source snapshots", async () => {
  const fixture = await repo();
  let snapshot;
  try {
    const base = fixture.command(["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(fixture.root, "code.ts"), "committed\n"); fixture.command(["add", "."]); fixture.command(["commit", "--quiet", "-m", "change"]);
    await fs.writeFile(path.join(fixture.root, "code.ts"), "dirty\n");
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "range", base, head: "HEAD" }));
    assert.match(snapshot.diff, /\+committed/); assert.doesNotMatch(snapshot.diff, /\+dirty/);
    await removeSnapshot(snapshot);
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "branch", base, includeDirty: true }));
    assert.match(snapshot.diff, /\+dirty/);
  } finally { if (snapshot) await removeSnapshot(snapshot); await fixture.cleanup(); }
});

test("secrets and symlinks are omitted from snapshots AND diff; exclusions retain safe context", async () => {
  const fixture = await repo();
  let snapshot;
  try {
    await fs.writeFile(path.join(fixture.root, ".env"), "TOKEN=do-not-report\n");
    await fs.symlink("/etc/passwd", path.join(fixture.root, "outside"));
    await fs.writeFile(path.join(fixture.root, "code.ts"), "changed\n");
    await fs.writeFile(path.join(fixture.root, "excluded.txt"), "context only\n");
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "dirty" }, ["excluded.txt"]));
    assert.doesNotMatch(snapshot.diff, /TOKEN|outside|context only/);
    assert.ok(!snapshot.files.target.includes(".env")); assert.ok(!snapshot.files.target.includes("outside"));
    assert.ok(snapshot.files.target.includes("excluded.txt"));
    assert.ok(snapshot.limitations.some(l => l.includes("omitted")));
    await assert.rejects(readSafe(path.join(snapshot.workspace, "target"), "../base/code.ts", new Set(["../base/code.ts"])), /denied/);
    await fs.symlink("/etc/passwd", path.join(snapshot.workspace, "target", "escape"));
    await assert.rejects(readSafe(path.join(snapshot.workspace, "target"), "escape", new Set(["escape"])), /Symlink/);
  } finally { if (snapshot) await removeSnapshot(snapshot); await fixture.cleanup(); }
});

test("source git diff/textconv/clean filters and fsmonitor are never executed", async () => {
  const fixture = await repo();
  let snapshot;
  try {
    const marker = path.join(fixture.root, "executed");
    fixture.command(["config", "diff.external", `touch ${marker}`]);
    fixture.command(["config", "core.fsmonitor", `touch ${marker}`]);
    fixture.command(["config", "diff.evil.textconv", `touch ${marker}`]);
    fixture.command(["config", "filter.evil.clean", `touch ${marker}; cat`]);
    fixture.command(["config", "filter.evil.process", `touch ${marker}`]);
    await fs.writeFile(path.join(fixture.root, ".gitattributes"), "*.ts diff=evil filter=evil\n");
    await fs.writeFile(path.join(fixture.root, "code.ts"), "changed\n");
    snapshot = await prepareSnapshot(fixture.root, request({ kind: "dirty" }));
    assert.match(snapshot.diff, /\+changed/);
    await assert.rejects(fs.stat(marker), { code: "ENOENT" });
  } finally { if (snapshot) await removeSnapshot(snapshot); await fixture.cleanup(); }
});

test("default branch is never guessed and option-like revisions are rejected", async () => {
  const fixture = await repo();
  try {
    await assert.rejects(prepareSnapshot(fixture.root, request({ kind: "branch" })), /--base/);
    await assert.rejects(revision(fixture.root, "--help"), /Invalid revision/);
    const controller = new AbortController(); controller.abort();
    await assert.rejects(git(fixture.root, ["status"], controller.signal));
  } finally { await fixture.cleanup(); }
});

test("concurrency waits for in-flight operations before propagating failure", async () => {
  let finished = false;
  await assert.rejects(mapConcurrent([0, 1, 2], 2, async item => {
    if (item === 0) throw new Error("failure");
    await new Promise(resolve => setTimeout(resolve, 20)); finished = true;
  }), /failure/);
  assert.equal(finished, true);
});
