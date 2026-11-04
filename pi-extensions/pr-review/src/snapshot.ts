import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash } from "node:crypto";
import { parsePR } from "./commands.ts";
import { blockedPath, excluded, MAX_FILE_BYTES, MAX_SNAPSHOT_BYTES, readSafe, safeRelative } from "./files.ts";
import { capture, defaultBase, git, mapConcurrent, revision } from "./git.ts";
import { buildMetadata } from "./metadata.ts";
import type { ReviewRequest, Snapshot } from "./types.ts";

type Tree = Map<string, Buffer>;
const treeModes = new WeakMap<Tree, Map<string, string>>();
function modes(tree: Tree): Map<string, string> {
  let result = treeModes.get(tree);
  if (!result) { result = new Map(); treeModes.set(tree, result); }
  return result;
}
type Entry = { file: string; mode: string; oid: string };
const hash = (data: string | Buffer) => createHash("sha256").update(data).digest("hex");

function parseEntries(raw: Buffer, index = false): Entry[] {
  return raw.toString().split("\0").filter(Boolean).map(record => {
    const tab = record.indexOf("\t");
    const [mode, typeOrOid, oidOrStage] = record.slice(0, tab).split(" ");
    if (index && oidOrStage !== "0") throw new Error("Resolve index conflicts before reviewing");
    return { mode, oid: index ? typeOrOid : oidOrStage, file: record.slice(tab + 1) };
  });
}
async function objectTree(root: string, ref: string | undefined, limitations: string[], signal?: AbortSignal, omitted = new Set<string>()): Promise<Tree> {
  const entries = parseEntries(await git(root, ref ? ["ls-tree", "-rz", ref] : ["ls-files", "--stage", "-z"], signal), !ref);
  const tree: Tree = new Map();
  let total = 0, blocked = 0, special = 0, oversized = 0;
  await mapConcurrent(entries, 8, async entry => {
    signal?.throwIfAborted();
    if (!safeRelative(entry.file) || blockedPath(entry.file)) { blocked++; omitted.add(entry.file); return; }
    if (!["100644", "100755"].includes(entry.mode)) { special++; omitted.add(entry.file); return; }
    const size = Number((await git(root, ["cat-file", "-s", entry.oid], signal)).toString());
    if (!Number.isSafeInteger(size) || size > MAX_FILE_BYTES) { oversized++; omitted.add(entry.file); return; }
    total += size;
    if (total > MAX_SNAPSHOT_BYTES) throw new Error("Repository snapshot is too large; source snapshot limit is 128 MiB");
    tree.set(entry.file, await git(root, ["cat-file", "blob", entry.oid], signal, MAX_FILE_BYTES));
    modes(tree).set(entry.file, entry.mode);
  });
  if (blocked) limitations.push(`${blocked} sensitive/dependency paths omitted from a source tree and its diff.`);
  if (special) limitations.push(`${special} symlinks/submodules/non-regular entries omitted from a source tree and its diff.`);
  if (oversized) limitations.push(`${oversized} files larger than 2 MiB omitted from a source tree and its diff.`);
  return tree;
}
async function currentHead(root: string, signal?: AbortSignal): Promise<string> {
  try { return await revision(root, "HEAD", signal); }
  catch (error) {
    signal?.throwIfAborted();
    const branch = (await git(root, ["symbolic-ref", "HEAD"], signal)).toString().trim();
    try { await git(root, ["show-ref", "--verify", branch], signal); }
    catch { signal?.throwIfAborted(); return "unborn"; }
    throw error;
  }
}
async function dirtyState(root: string, signal?: AbortSignal): Promise<string> {
  const parts = await Promise.all([
    currentHead(root, signal).then(head => Buffer.from(head)), git(root, ["ls-files", "--stage", "-z"], signal),
    git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal),
  ]);
  return hash(Buffer.concat(parts));
}
async function dirtyTree(root: string, limitations: string[], signal?: AbortSignal, omitted = new Set<string>()): Promise<Tree> {
  const state = await dirtyState(root, signal);
  const files = (await git(root, ["ls-files", "--cached", "--others", "--exclude-standard", "-z"], signal)).toString().split("\0").filter(Boolean);
  const allowed = new Set(files), tree: Tree = new Map();
  const stamps = new Map<string, string>();
  let total = 0, skipped = 0;
  const stamp = (s: import("node:fs").Stats) => `${s.dev}:${s.ino}:${s.size}:${s.mtimeMs}:${s.ctimeMs}:${s.mode}`;
  await mapConcurrent([...allowed], 8, async file => {
    if (!safeRelative(file) || blockedPath(file)) { skipped++; omitted.add(file); return; }
    signal?.throwIfAborted();
    try {
      const stat = await fs.lstat(path.join(root, file));
      stamps.set(file, stamp(stat));
      if (stat.isDirectory()) return; // a tracked file may legitimately have become a directory
      if (!stat.isFile() || stat.size > MAX_FILE_BYTES) { skipped++; omitted.add(file); return; }
      const data = await readSafe(root, file, allowed);
      if (stamp(stat) !== stamp(await fs.lstat(path.join(root, file)))) throw new Error(`File changed during capture: ${file}`);
      total += data.length;
      if (total > MAX_SNAPSHOT_BYTES) throw new Error("Dirty snapshot exceeds 128 MiB");
      stamps.set(file, stamp(stat));
      tree.set(file, data);
      modes(tree).set(file, stat.mode & 0o111 ? "100755" : "100644");
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") { stamps.set(file, "missing"); return; } // tracked deletion
      if ((error as Error).message.startsWith("Symlink")) { skipped++; omitted.add(file); return; }
      throw error;
    }
  });
  if (state !== await dirtyState(root, signal)) throw new Error("HEAD/index/worktree changed during capture; retry when edits have stopped");
  for (const [file, before] of stamps) {
    let after: string;
    try { after = stamp(await fs.lstat(path.join(root, file))); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") after = "missing"; else throw error; }
    if (after !== before) throw new Error(`File changed during capture: ${file}`);
  }
  if (skipped) limitations.push(`${skipped} unsafe, sensitive, dependency, or oversized working-tree paths omitted.`);
  return tree;
}
async function writeTree(root: string, tree: Tree, permissions = modes(tree)): Promise<void> {
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  for (const [file, data] of tree) {
    await fs.mkdir(path.dirname(path.join(root, file)), { recursive: true, mode: 0o700 });
    const destination = path.join(root, file);
    const mode = permissions.get(file) === "100755" ? 0o700 : 0o600;
    await fs.writeFile(destination, data, { mode, flag: "wx" });
    await fs.chmod(destination, mode);
  }
}

async function changeInventory(root: string, base: string, head: string, dirty: boolean, staged: boolean, signal?: AbortSignal): Promise<string[]> {
  const args = ["diff", "--name-only", "-z", "--no-ext-diff", "--no-textconv", "--no-renames", "--ignore-submodules=none"];
  let paths: string[];
  if (dirty) {
    // A worktree git diff may execute repository clean/process filters, even with --no-textconv.
    // Net changes in readable files are compared from our raw snapshots below instead.
    paths = base === "unborn" ? (await git(root, ["ls-files", "--cached", "-z"], signal)).toString().split("\0") : [];
  } else {
    if (staged) args.push("--cached");
    if (base !== "unborn") args.push(base);
    if (!dirty && !staged) args.push(head);
    paths = (await git(root, args, signal)).toString().split("\0");
  }
  if (dirty) paths.push(...(await git(root, ["ls-files", "--others", "--exclude-standard", "-z"], signal)).toString().split("\0"));
  return [...new Set(paths.filter(file => safeRelative(file) && !blockedPath(file)))].sort();
}

/** Fetch objects into a disposable bare repo; never checkout or execute repository code. */
async function prTrees(workspace: string, reference: string, limitations: string[], omitted: Set<string>, signal?: AbortSignal) {
  const { repo, number } = parsePR(reference);
  const metadata = JSON.parse((await capture("gh", ["api", `repos/${repo}/pulls/${number}`], workspace, signal)).toString());
  const head = metadata.head?.sha, baseTip = metadata.base?.sha;
  if (!/^[a-f0-9]{40,64}$/.test(head) || !/^[a-f0-9]{40,64}$/.test(baseTip)) throw new Error("Invalid PR revision metadata");
  const comparison = JSON.parse((await capture("gh", ["api", `repos/${repo}/compare/${baseTip}...${head}`], workspace, signal)).toString());
  const base = comparison.merge_base_commit?.sha;
  if (!/^[a-f0-9]{40,64}$/.test(base)) throw new Error("Could not resolve PR merge base");
  const source = path.join(workspace, "pr-objects");
  await fs.mkdir(source);
  await git(source, ["init", "--bare", "--quiet"], signal);
  await git(source, ["-c", "credential.helper=", "-c", "credential.helper=!gh auth git-credential",
    "fetch", "--quiet", "--depth=1", "--no-tags", `https://github.com/${repo}.git`, base, `refs/pull/${number}/head:refs/heads/review`], signal);
  if (await revision(source, "refs/heads/review", signal) !== head) throw new Error("PR head changed during capture; retry");
  return {
    base, head, baseTree: await objectTree(source, base, limitations, signal, omitted),
    targetTree: await objectTree(source, head, limitations, signal, omitted),
    allChangedFiles: await changeInventory(source, base, head, false, false, signal),
    feedbackScope: `github:${repo.toLowerCase()}#${number}`,
    context: `PR ${repo}#${number}: ${metadata.title}\n\n${metadata.body ?? ""}`,
    label: `PR ${repo}#${number}: ${base.slice(0, 12)} → ${head.slice(0, 12)}`,
  };
}

export async function prepareSnapshot(cwd: string, request: ReviewRequest, signal?: AbortSignal): Promise<Snapshot> {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pi-pr-review-"));
  const limitations: string[] = [];
  const omitted = new Set<string>();
  try {
    const target = request.target;
    let root = cwd, base: string, head: string, label: string, context = request.context;
    let baseTree: Tree, targetTree: Tree;
    let allChangedFiles: string[], feedbackScope: string;
    if (target.kind === "pr") {
      const pr = await prTrees(workspace, target.reference, limitations, omitted, signal);
      ({ base, head, label, baseTree, targetTree, allChangedFiles, feedbackScope } = pr);
      context = `${pr.context}\n\nReviewer intent:\n${request.context}`;
    } else {
      root = (await git(cwd, ["rev-parse", "--show-toplevel"], signal)).toString().trim();
      const originalHead = await currentHead(root, signal);
      let branch: string;
      try { branch = (await git(root, ["symbolic-ref", "--short", "HEAD"], signal)).toString().trim(); }
      catch { signal?.throwIfAborted(); branch = `detached:${originalHead}`; }
      feedbackScope = target.kind === "range" ? `range:${branch}:${target.base}:${target.head}` : `branch:${branch}`;
      if (originalHead === "unborn" && target.kind === "branch")
        throw new Error("Branch/range reviews need an existing commit. Use dirty or staged for an unborn branch.");
      head = originalHead;
      if (target.kind === "range") {
        head = await revision(root, target.head, signal);
        const mergeBase = target.base.endsWith("...");
        base = await revision(root, mergeBase ? target.base.slice(0, -3) : target.base, signal);
        if (mergeBase) base = (await git(root, ["merge-base", base, head], signal)).toString().trim();
        label = `Range: ${base.slice(0, 12)} → ${head.slice(0, 12)}`;
      } else if (target.kind === "branch") {
        const baseRef = target.base ?? await defaultBase(root, signal);
        const baseTip = await revision(root, baseRef, signal);
        base = (await git(root, ["merge-base", baseTip, head], signal)).toString().trim();
        label = `Branch: merge-base(${baseRef}, HEAD) ${base.slice(0, 12)} → ${head.slice(0, 12)}${target.includeDirty ? " + dirty changes" : ""}`;
      } else { base = originalHead; label = `${target.kind === "staged" ? "Staged" : "Dirty (staged + unstaged + untracked)"}: ${base.slice(0, 12)} → ${target.kind}`; }
      const dirty = target.kind === "dirty" || (target.kind === "branch" && target.includeDirty);
      const before = dirty || target.kind === "staged" ? await dirtyState(root, signal) : undefined;
      baseTree = base === "unborn" ? new Map() : await objectTree(root, base, limitations, signal, omitted);
      targetTree = dirty ? await dirtyTree(root, limitations, signal, omitted)
        : await objectTree(root, target.kind === "staged" ? undefined : head, limitations, signal, omitted);
      allChangedFiles = await changeInventory(root, base, head, !!dirty, target.kind === "staged", signal);
      if (before && (before !== await dirtyState(root, signal) || originalHead !== await currentHead(root, signal))) throw new Error("Repository changed while snapshotting; retry");
      if (dirty) head = `${originalHead}+worktree`;
      else if (target.kind === "staged") head = `${originalHead}+index`;
    }
    // An omission on either side must not masquerade as an addition/deletion on the other.
    for (const tree of [baseTree, targetTree]) for (const file of tree.keys()) {
      const parts = file.split("/");
      if (parts.some((_part, i) => omitted.has(parts.slice(0, i + 1).join("/")))) { tree.delete(file); omitted.add(file); }
    }
    const allAvailableChanges = [...new Set([...baseTree.keys(), ...targetTree.keys()])].filter(file => (
      !baseTree.has(file) || !targetTree.has(file) || !baseTree.get(file)!.equals(targetTree.get(file)!)
      || modes(baseTree).get(file) !== modes(targetTree).get(file)
    ));
    allChangedFiles = [...new Set([...allChangedFiles, ...allAvailableChanges])].sort();
    const changedFiles = allAvailableChanges.filter(file => !excluded(file, request.exclude)).sort();
    if (!changedFiles.length) throw new Error("No reviewable changes (the target may be empty or all changes excluded/omitted)");
    await writeTree(path.join(workspace, "base"), baseTree);
    await writeTree(path.join(workspace, "target"), targetTree);
    // Use an isolated synthetic index, with no checkout, filters, hooks, or original index mutation.
    const diffRoot = path.join(workspace, "diff");
    const selectedBase = new Map([...baseTree].filter(([file]) => changedFiles.includes(file)));
    const selectedTarget = new Map([...targetTree].filter(([file]) => changedFiles.includes(file)));
    await writeTree(diffRoot, selectedBase, modes(baseTree));
    await git(diffRoot, ["init", "--quiet"], signal);
    await git(diffRoot, ["add", "--all", "--force"], signal);
    const baseObject = (await git(diffRoot, ["write-tree"], signal)).toString().trim();
    for (const file of selectedBase.keys()) await fs.rm(path.join(diffRoot, file));
    // File → directory transitions require removing empty directories too.
    for (const name of await fs.readdir(diffRoot)) if (name !== ".git") await fs.rm(path.join(diffRoot, name), { recursive: true, force: true });
    await writeTree(diffRoot, selectedTarget, modes(targetTree));
    await git(diffRoot, ["add", "--all", "--force"], signal);
    const diff = (await git(diffRoot, ["-c", "core.quotePath=false", "diff", "--cached", "--no-ext-diff", "--no-textconv", "--no-renames", "--unified=5", baseObject], signal)).toString();
    limitations.push("Inspection only: no tests, builds, or reproductions were executed.");
    if (request.exclude.length) limitations.push(`Diff exclusions: ${request.exclude.join(", ")}. Excluded files may still be read for context.`);
    limitations.push("Snapshot omits symlinks, submodules, dependencies, common secret paths, and files over 2 MiB. Secret-path filtering is not a complete secret detector.");
    return { workspace, root, label, baseRevision: base, targetRevision: head, diff, diffHash: hash(diff), changedFiles: changedFiles.sort(),
      files: { base: [...baseTree.keys()].sort(), target: [...targetTree.keys()].sort() }, limitations: [...new Set(limitations)], context,
      metadata: buildMetadata(baseTree, targetTree, allChangedFiles, changedFiles, [...omitted].filter(file => safeRelative(file) && !blockedPath(file))), feedbackScope };
  } catch (error) { await fs.rm(workspace, { recursive: true, force: true }); throw error; }
}
export async function removeSnapshot(snapshot: Snapshot): Promise<void> {
  await fs.rm(snapshot.workspace, { recursive: true, force: true });
}
