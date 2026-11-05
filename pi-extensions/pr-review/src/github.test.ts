import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { prepareSnapshot, removeSnapshot } from "./snapshot.ts";

// Stub only the network transport. Actual object fetching/export/diff use real Git against a local repo.
test("PR retrieval snapshots the fetched PR head, not unrelated invoking worktree files; changing heads fail", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-pr-"));
  const previousPath = process.env.PATH;
  const actualGit = execFileSync("which", ["git"], { encoding: "utf8" }).trim();
  let snapshot;
  try {
    const source = path.join(workspace, "source"), caller = path.join(workspace, "caller"), bin = path.join(workspace, "bin");
    await Promise.all([source, caller, bin].map(directory => fs.mkdir(directory)));
    const git = (args: string[]) => execFileSync(actualGit, ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: source, encoding: "utf8" }).trim();
    git(["init", "--quiet", "--initial-branch=main"]);
    await fs.writeFile(path.join(source, "code.ts"), "base\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
    const base = git(["rev-parse", "HEAD"]);
    await fs.writeFile(path.join(source, "code.ts"), "PR head\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "PR"]);
    const head = git(["rev-parse", "HEAD"]);
    git(["update-ref", "refs/pull/123/head", head]);
    await fs.writeFile(path.join(caller, "code.ts"), "WRONG unrelated checkout\n");
    const ghPath = path.join(bin, "gh");
    const metadata = { title: "Fixture PR", body: "Explicit intent", head: { sha: head }, base: { sha: base } };
    const ghScript = (data: typeof metadata) => `#!${process.execPath}\nconst args=process.argv.slice(2); console.log(JSON.stringify(args[1].includes('/pulls/') ? ${JSON.stringify(data)} : {merge_base_commit:{sha:${JSON.stringify(base)}}}));\n`;
    await fs.writeFile(ghPath, ghScript(metadata), { mode: 0o700 });
    await fs.writeFile(path.join(bin, "git"), `#!${process.execPath}\nconst {spawnSync}=require('node:child_process'); const args=process.argv.slice(2).map(a=>a==='https://github.com/owner/repo.git'?${JSON.stringify(source)}:a); const result=spawnSync(${JSON.stringify(actualGit)},args,{stdio:'inherit'}); process.exit(result.status??1);\n`, { mode: 0o700 });
    process.env.PATH = `${bin}${path.delimiter}${previousPath}`;
    snapshot = await prepareSnapshot(caller, { target: { kind: "pr", reference: "owner/repo#123" }, context: "", exclude: [] });
    assert.equal(snapshot.baseRevision, base); assert.equal(snapshot.targetRevision, head);
    assert.match(snapshot.diff, /\+PR head/); assert.doesNotMatch(snapshot.diff, /WRONG/);
    assert.equal(await fs.readFile(path.join(snapshot.workspace, "target", "code.ts"), "utf8"), "PR head\n");
    assert.equal(await fs.readFile(path.join(caller, "code.ts"), "utf8"), "WRONG unrelated checkout\n");
    await fs.writeFile(ghPath, ghScript({ ...metadata, head: { sha: base } }));
    await assert.rejects(prepareSnapshot(caller, { target: { kind: "pr", reference: "owner/repo#123" }, context: "", exclude: [] }), /PR head changed/);
  } finally {
    if (previousPath === undefined) delete process.env.PATH; else process.env.PATH = previousPath;
    if (snapshot) await removeSnapshot(snapshot);
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
