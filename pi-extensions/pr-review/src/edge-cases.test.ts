import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { prepareSnapshot, removeSnapshot } from "./snapshot.ts";

async function fixture() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-edge-"));
  const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root, encoding: "utf8" }).trim();
  git(["init", "--quiet", "--initial-branch=main"]);
  return { root, git, cleanup: () => fs.rm(root, { recursive: true, force: true }) };
}

test("dirty and staged reviews support an unborn branch and additions-only comparisons", async () => {
  const repo = await fixture();
  let snapshot;
  try {
    await fs.writeFile(path.join(repo.root, "code.ts"), "first version\n");
    snapshot = await prepareSnapshot(repo.root, { target: { kind: "dirty" }, context: "", exclude: [] });
    assert.equal(snapshot.baseRevision, "unborn"); assert.match(snapshot.diff, /new file mode/);
    await removeSnapshot(snapshot);
    repo.git(["add", "."]);
    await fs.writeFile(path.join(repo.root, "code.ts"), "not staged\n");
    snapshot = await prepareSnapshot(repo.root, { target: { kind: "staged" }, context: "", exclude: [] });
    assert.match(snapshot.diff, /\+first version/); assert.doesNotMatch(snapshot.diff, /not staged/);
  } finally { if (snapshot) await removeSnapshot(snapshot); await repo.cleanup(); }
});

test("omitted oversized files and symlink transitions never become false additions/deletions", async () => {
  const repo = await fixture();
  let snapshot;
  try {
    await fs.writeFile(path.join(repo.root, "code.ts"), "old\n");
    await fs.writeFile(path.join(repo.root, "grows.txt"), "small\n");
    await fs.mkdir(path.join(repo.root, "directory"));
    await fs.writeFile(path.join(repo.root, "directory", "child.txt"), "old child\n");
    repo.git(["add", "."]); repo.git(["commit", "--quiet", "-m", "base"]);
    await fs.writeFile(path.join(repo.root, "grows.txt"), "x".repeat(2 * 1024 * 1024 + 1));
    await fs.rm(path.join(repo.root, "directory"), { recursive: true });
    await fs.symlink("/etc", path.join(repo.root, "directory"));
    await fs.writeFile(path.join(repo.root, "code.ts"), "new\n");
    snapshot = await prepareSnapshot(repo.root, { target: { kind: "dirty" }, context: "", exclude: [] });
    assert.deepEqual(snapshot.changedFiles, ["code.ts"]);
    assert.doesNotMatch(snapshot.diff, /grows.txt|directory/);
    assert.ok(!snapshot.files.base.includes("grows.txt"));
    assert.ok(!snapshot.files.base.includes("directory/child.txt"));
    assert.ok(snapshot.limitations.some(l => l.includes("omitted")));
  } finally { if (snapshot) await removeSnapshot(snapshot); await repo.cleanup(); }
});

test("ordinary file-to-directory transitions produce matching snapshots and diff", async () => {
  const repo = await fixture();
  let snapshot;
  try {
    await fs.writeFile(path.join(repo.root, "item"), "old file\n"); repo.git(["add", "."]); repo.git(["commit", "--quiet", "-m", "base"]);
    await fs.rm(path.join(repo.root, "item")); await fs.mkdir(path.join(repo.root, "item"));
    await fs.writeFile(path.join(repo.root, "item", "child.txt"), "new child\n");
    snapshot = await prepareSnapshot(repo.root, { target: { kind: "dirty" }, context: "", exclude: [] });
    assert.match(snapshot.diff, /deleted file mode/); assert.match(snapshot.diff, /new child/);
    assert.equal(await fs.readFile(path.join(snapshot.workspace, "target", "item", "child.txt"), "utf8"), "new child\n");
  } finally { if (snapshot) await removeSnapshot(snapshot); await repo.cleanup(); }
});
