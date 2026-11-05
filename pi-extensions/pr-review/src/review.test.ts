import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { parsePR, parseRequest, tokenize } from "./commands.ts";
import { isolatedLoader, candidatesFrom, runPipeline, type StageRunner } from "./engine.ts";
import { blockedPath, truncate } from "./files.ts";
import { renderReport, saveReport, loadLast } from "./report.ts";
import { validateReviewer, validateSynthesis, validateVerification } from "./schemas.ts";
import { createInspectionTools } from "./tools.ts";
import { emptyUsage, REVIEWERS, type Finding, type ReviewRun, type Snapshot, type StageResult, type VerificationReport } from "./types.ts";

const snapshot: Snapshot = { workspace: "", root: "/fixture", label: "Fixture branch", baseRevision: "base", targetRevision: "head", diff: "+bug", diffHash: "hash", changedFiles: ["code.ts"], files: { base: ["code.ts", "caller.ts"], target: ["code.ts", "caller.ts"] }, limitations: ["Inspection only; no tests executed."], context: "" };
const finding = (id = "original"): Finding => ({ id, title: "Caller breaks", severity: "high", kind: "defect", file: "caller.ts", line: 1,
  changedFile: "code.ts", change: "Changed public signature", scenario: "Caller passes old arguments", consequence: "Exception",
  evidence: ["caller.ts:1 passes old argument"], assumptions: [], inspected: ["caller.ts:1"], gap: "", suggestedTest: "Call with the old arguments", fix: "Update callers" });
const done = (stage: StageResult["stage"], output: StageResult["output"]): StageResult => ({ stage, status: "done", output, usage: emptyUsage(), calls: [] });
const verification = (): VerificationReport => ({ verdicts: [{ candidateId: "bug-1", status: "supported", reason: "Inspected real caller", disconfirmation: "Checked caller validation; it does not adapt the changed argument shape", evidence: ["code.ts:2 rejects input"], inspected: ["code.ts:2", "caller.ts:1"], gap: "", suggestedTest: "Add caller regression test" }], limitations: [] });
function run(stages: StageResult[]): ReviewRun {
  const { workspace: _workspace, files: _files, ...saved } = snapshot;
  return { version: 1, id: "12345678-abcd", createdAt: "now", config: { provider: "test", model: "test", thinking: "medium" }, request: { target: { kind: "branch" }, context: "", exclude: [] }, snapshot: saved, stages,
    complete: stages.length === 6 && stages.every(s => s.status === "done"), limitations: [], elapsedMs: 100, usage: emptyUsage() };
}

test("arguments retain quoted context/globs and reject ambiguous/unknown inputs", () => {
  assert.deepEqual(tokenize('dirty --context "intended behavior" --exclude \'**/*.lock\''), ["dirty", "--context", "intended behavior", "--exclude", "**/*.lock"]);
  assert.deepEqual(parseRequest('branch --base origin/main --include-dirty --context "intent" --exclude "*.lock"'), { target: { kind: "branch", base: "origin/main", includeDirty: true }, context: "intent", exclude: ["*.lock"] });
  assert.equal(parseRequest(""), undefined);
  assert.deepEqual(parseRequest("range main...HEAD")?.target, { kind: "range", base: "main...", head: "HEAD" });
  assert.throws(() => parseRequest("dirty --execute"), /Unknown option/);
  assert.throws(() => parseRequest("dirty --base main"), /only to branch/);
  assert.throws(() => parseRequest("dirty --context"), /Missing value/);
  assert.throws(() => tokenize('dirty "unfinished'), /Unclosed quote/);
  assert.deepEqual(parsePR("https://github.com/owner/repo/pull/123/files"), { repo: "owner/repo", number: "123" });
  assert.throws(() => parsePR("https://github.com/owner/repo/pull/123evil"));
  assert.throws(() => parsePR("--config=evil"));
});

test("isolated resource loader never discovers or loads code/resources", async () => {
  const loader = isolatedLoader("review only");
  await loader.reload(); loader.extendResources({});
  assert.deepEqual(loader.getExtensions().extensions, []);
  assert.deepEqual(loader.getSkills().skills, []); assert.deepEqual(loader.getAgentsFiles().agentsFiles, []);
  assert.equal(loader.getSystemPrompt(), "review only");
});

test("inspection tools are manifest-bounded and include no execution/edit/network capability", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-tools-"));
  try {
    await fs.mkdir(path.join(workspace, "target")); await fs.mkdir(path.join(workspace, "base"));
    await fs.writeFile(path.join(workspace, "target", "code.ts"), "first\nneedle\nthird\n");
    await fs.writeFile(path.join(workspace, "base", "code.ts"), "old\n");
    const tools = createInspectionTools({ ...snapshot, workspace, files: { base: ["code.ts"], target: ["code.ts"] } });
    assert.deepEqual(tools.map(t => t.name), ["review_read", "review_list", "review_search"]);
    const reader = tools[0];
    const content = await reader.execute("id", { path: "code.ts", offset: 2, limit: 1 }, undefined, undefined, {} as never);
    assert.match(content.content[0].type === "text" ? content.content[0].text : "", /2: needle/);
    const base = await reader.execute("id", { path: "code.ts", revision: "base" }, undefined, undefined, {} as never);
    assert.match(base.content[0].type === "text" ? base.content[0].text : "", /old/);
    await assert.rejects(reader.execute("id", { path: "/etc/passwd" }, undefined, undefined, {} as never), /denied/);
    await assert.rejects(reader.execute("id", { path: ".env" }, undefined, undefined, {} as never), /denied/);
    const search = await tools[2].execute("id", { text: "needle" }, undefined, undefined, {} as never);
    assert.match(search.content[0].type === "text" ? search.content[0].text : "", /code.ts:2: needle/);
    assert.ok(blockedPath("nested/.env.production"));
    assert.ok(truncate("é".repeat(100), 11).includes("truncated"));
    assert.ok(!truncate("é".repeat(100), 11).includes("�"));
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});

test("findings in untouched callers survive when anchored to the reviewed change", () => {
  validateReviewer({ summary: "", findings: [finding()], limitations: [] }, snapshot);
  assert.throws(() => validateReviewer({ summary: "", findings: [{ ...finding(), changedFile: "caller.ts" }], limitations: [] }, snapshot), /changedFile/);
  assert.throws(() => validateVerification({ verdicts: [], limitations: [] }, [finding("bug-1")]), /omitted/);
  const report = verification();
  validateVerification(report, [finding("bug-1")]);
  assert.throws(() => validateVerification({ ...report, verdicts: [{ ...report.verdicts[0], status: "needs-testing", gap: "" }] }, [finding("bug-1")]), /evidence gap/);
  assert.throws(() => validateVerification({ ...report, verdicts: [report.verdicts[0], report.verdicts[0]] }, [finding("bug-1")]), /duplicate/);
  assert.throws(() => validateSynthesis({ summary: "", groups: [], limitations: [] }, report), /omitted/);
});

test("pipeline preserves a single-reviewer finding and verifies before synthesis", async () => {
  const calls: string[] = [];
  const runner: StageRunner = async (stage, _prompt, candidates) => {
    calls.push(stage);
    if (stage === "verify") { assert.equal(candidates?.[0].id, "bug-1"); return done(stage, verification()); }
    if (stage === "synthesize") return done(stage, { summary: "Changed public signature", groups: [{ title: "Caller breaks", candidateIds: ["bug-1"] }], limitations: [] });
    return done(stage, { summary: "", findings: stage === "bug" ? [finding()] : [], limitations: [] });
  };
  const stages = await runPipeline(snapshot, runner);
  assert.deepEqual(calls, [...REVIEWERS, "verify", "synthesize"]);
  assert.equal(candidatesFrom(stages).length, 1);
  const report = renderReport(run(stages));
  assert.match(report, /Supported by inspection — not executed/);
  assert.match(report, /caller.ts:1/); assert.match(report, /code.ts/);
  assert.doesNotMatch(report, /approved|merge recommended/i);
});

test("verifier failure exposes unverified candidates and never claims support or a clean review", async () => {
  const stages = await runPipeline(snapshot, async stage => {
    if (stage === "verify") return { stage, status: "failed", error: "context overflow", usage: emptyUsage(), calls: [] };
    return done(stage, { summary: "", findings: stage === "bug" ? [finding()] : [], limitations: [] });
  });
  assert.equal(stages.length, 5);
  const report = renderReport(run(stages));
  assert.match(report, /INCOMPLETE REVIEW/); assert.match(report, /Unverified candidate/);
  assert.doesNotMatch(report, /Supported by inspection — not executed/);
  assert.match(report, /context overflow/);
});

test("rejected candidates are hidden by default and available in details; saved scopes round-trip", async () => {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "review-reports-"));
  try {
    const reviewed = run([done("bug", { summary: "", findings: [finding()], limitations: [] }),
      done("verify", { verdicts: [{ ...verification().verdicts[0], status: "rejected", reason: "Caller already updated" }], limitations: [] }),
      done("synthesize", { summary: "Change summary", groups: [], limitations: [] })]);
    assert.doesNotMatch(renderReport(reviewed), /Caller already updated/);
    assert.match(renderReport(reviewed, true), /Caller already updated/);
    const output = await saveReport(directory, reviewed);
    assert.equal((await fs.stat(path.join(output, "review.json"))).mode & 0o777, 0o600);
    assert.deepEqual(await loadLast(directory, snapshot.root), reviewed);
    await assert.rejects(loadLast(directory, "/different-repo"), { code: "ENOENT" });
  } finally { await fs.rm(directory, { recursive: true, force: true }); }
});
