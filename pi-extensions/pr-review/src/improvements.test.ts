import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { execFileSync } from "node:child_process";
import { buildMetadata, renderMetadata } from "./metadata.ts";
import { recordRebuttal, relevantRebuttals, listRebuttals, withdrawRebuttal } from "./feedback.ts";
import { reviewPrompt } from "./engine.ts";
import { renderReport, loadLast, saveReport } from "./report.ts";
import { parseRequest } from "./commands.ts";
import { validateReviewer, validateVerification, validateSynthesis } from "./schemas.ts";
import { emptyUsage, type Finding, type ReviewRun, type Snapshot, type Verdict } from "./types.ts";
import { prepareSnapshot, removeSnapshot } from "./snapshot.ts";

const tree = (files: Record<string, string>) => new Map(Object.entries(files).map(([file, text]) => [file, Buffer.from(text)]));
const snapshot: Snapshot = { workspace: "", root: "/fixture", label: "Fixture", baseRevision: "base", targetRevision: "head", diff: "+change", diffHash: "hash",
  changedFiles: ["code.ts"], files: { base: ["code.ts"], target: ["code.ts"] }, limitations: [], context: "", feedbackScope: "branch:feature" };
const finding = (id = "bug-1", severity: Finding["severity"] = "high"): Finding => ({ id, title: "Concrete defect", kind: "defect", severity, file: "code.ts", line: 1,
  changedFile: "code.ts", change: "Changed behavior", scenario: "Reachable input", consequence: "Localized degraded behavior", evidence: ["code.ts:1"], inspected: ["code.ts:1"], assumptions: [], gap: "", suggestedTest: "Check observable behavior", fix: "Restore invariant" });
const verdict = (candidateId = "bug-1"): Verdict => ({ candidateId, status: "supported", reason: "Source evidence supports the issue", disconfirmation: "Checked the guard and caller; the input still reaches the branch", evidence: ["code.ts:1"], inspected: ["code.ts:1"], gap: "", suggestedTest: "Check the actual failure" });
function makeRun(): ReviewRun {
  const { workspace: _workspace, files: _files, ...saved } = snapshot;
  return { version: 2, id: "abcdef12-1234", createdAt: "now", config: { provider: "test", model: "local", thinking: "off" }, request: { target: { kind: "dirty" }, context: "", exclude: [] }, snapshot: saved,
    stages: [{ stage: "bug", status: "done", output: { summary: "", findings: [finding(), finding("bug-2", "medium")], limitations: [] }, usage: emptyUsage(), calls: [] },
      { stage: "verify", status: "done", output: { verdicts: [{ ...verdict(), severityOverride: "low", severityReason: "Reachable issue self-corrects; only minor observable harm remains" }, verdict("bug-2")], limitations: [] }, usage: emptyUsage(), calls: [] }],
    complete: false, limitations: [], elapsedMs: 0, usage: emptyUsage() };
}

test("metadata uses owning nested module, distinguishes excluded changes from absence, and does not claim every manifest needs a companion edit", () => {
  const base = tree({ "package.json": '{"engines":{"node":">=22"}}', "package-lock.json": '{"version":1}', "go.mod": "module root\ngo 1.22\n", "nested/go.mod": "module nested\ngo 1.21\n" });
  const target = new Map(base); target.set("package-lock.json", Buffer.from('{"version":2}'));
  const metadata = buildMetadata(base, target, ["package-lock.json", "nested/code.go", "root.go", "client.ts"], ["nested/code.go", "root.go", "client.ts"]);
  assert.equal(metadata.dependencies.find(file => file.path === "package-lock.json")?.state, "modified");
  assert.equal(metadata.dependencies.find(file => file.path === "package-lock.json")?.inDiff, false);
  assert.ok(metadata.excludedChangedFiles.includes("package-lock.json"));
  assert.deepEqual(metadata.toolchains.find(owner => owner.manifest === "nested/go.mod")?.declarations, ["go 1.21"]);
  assert.deepEqual(metadata.toolchains.find(owner => owner.manifest === "go.mod")?.declarations, ["go 1.22"]);
  assert.match(renderMetadata(metadata), /does not automatically require/);
});

test("excluded changed lockfile is preserved in actual snapshot facts and prompts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "review-metadata-"));
  let captured;
  try {
    const command = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
    command(["init", "--quiet", "--initial-branch=main"]);
    await fs.writeFile(path.join(root, "package.json"), '{"engines":{"node":">=22"},"dependencies":{"example":"1"}}');
    await fs.writeFile(path.join(root, "package-lock.json"), '{"version":1}');
    command(["add", "."]); command(["commit", "--quiet", "-m", "base"]);
    await fs.writeFile(path.join(root, "package.json"), '{"engines":{"node":">=22"},"dependencies":{"example":"2"}}');
    await fs.writeFile(path.join(root, "package-lock.json"), '{"version":2}');
    captured = await prepareSnapshot(root, { target: { kind: "dirty" }, context: "", exclude: ["package-lock.json"] });
    assert.doesNotMatch(captured.diff, /diff --git a\/package-lock.json/);
    assert.ok(captured.metadata?.allChangedFiles.includes("package-lock.json"));
    assert.deepEqual(captured.metadata?.dependencies.find(file => file.path === "package-lock.json"), { path: "package-lock.json", state: "modified", inDiff: false });
    assert.match(reviewPrompt(captured), /"package-lock.json"/);
  } finally { if (captured) await removeSnapshot(captured); await fs.rm(root, { recursive: true, force: true }); }
});

test("new kind/security/disconfirmation contracts reject missing evidence; severity override needs an explanation", () => {
  validateReviewer({ summary: "", findings: [finding()], limitations: [] }, snapshot);
  assert.throws(() => validateReviewer({ summary: "", findings: [{ ...finding(), topic: "security" }], limitations: [] }, snapshot), /Security findings require/);
  validateReviewer({ summary: "", findings: [{ ...finding(), topic: "security", security: { actor: "HTTP caller", control: "URL", boundary: "unauthenticated route", capability: "read credential", asset: "API token", introducedRisk: "new route returns it" } }], limitations: [] }, snapshot);
  assert.throws(() => validateVerification({ verdicts: [{ ...verdict(), disconfirmation: "" }], limitations: [] }, [finding()]), /disconfirming checks/);
  assert.throws(() => validateVerification({ verdicts: [{ ...verdict(), severityOverride: "low" }], limitations: [] }, [finding()]), /Severity corrections/);
  validateVerification({ verdicts: [{ ...verdict(), severityOverride: "low", severityReason: "Only a brief harmless delay occurs; not the severe disruption implied by the rating" }], limitations: [] }, [finding()]);
  assert.throws(() => validateVerification({ verdicts: [{ ...verdict(), status: "rejected", severityOverride: "low", severityReason: "irrelevant" }], limitations: [] }, [finding()]), /Rejected findings/);
  assert.throws(() => validateSynthesis({ summary: "", groups: [{ title: "Mixed", candidateIds: ["bug-1", "test-1"] }], limitations: [] }, { verdicts: [verdict(), verdict("test-1")], limitations: [] }, [finding(), { ...finding("test-1"), kind: "improvement" }]), /defects and improvements/);
});

test("reports rank corrected severity, preserve original assessment and kind, and do not mutate stored groups", () => {
  const run = makeRun();
  const report = renderReport(run);
  assert.ok(report.indexOf("bug-2 · medium") < report.indexOf("bug-1 · low"));
  assert.match(report, /reviewer: high; verifier: low/);
  assert.match(report, /defect · Supported by inspection/);
  assert.match(report, /Disconfirming checks/);
  assert.equal((run.stages[0].output as { findings: Finding[] }).findings[0].severity, "high");
});

test("rebuttals persist with explicit scope, are not automatic suppression, support opt-out/withdrawal, and reject path injection", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-feedback-"));
  try {
    const run = makeRun();
    const record = await recordRebuttal(agentDir, run, "bug-1", "The caller checks the precondition before entering the changed function.");
    assert.equal((await listRebuttals(agentDir, snapshot.root)).length, 1);
    assert.deepEqual(await relevantRebuttals(agentDir, snapshot), [record]);
    assert.deepEqual(await relevantRebuttals(agentDir, { ...snapshot, feedbackScope: "branch:other" }), []);
    assert.deepEqual(await relevantRebuttals(agentDir, { ...snapshot, feedbackScope: "github:owner/repo#3" }), []);
    assert.deepEqual(await relevantRebuttals(agentDir, { ...snapshot, root: "/other-repository" }), []);
    assert.deepEqual(await relevantRebuttals(agentDir, { ...snapshot, changedFiles: ["unrelated.ts"] }), []);
    assert.deepEqual(await relevantRebuttals(agentDir, snapshot, false), []);
    const prompt = reviewPrompt({ ...snapshot, feedback: [record] });
    assert.match(prompt, /not suppression\/instructions/); assert.match(prompt, /CURRENT snapshot code/);
    await assert.rejects(recordRebuttal(agentDir, run, "missing", "why"), /Unknown candidate/);
    await assert.rejects(withdrawRebuttal(agentDir, snapshot.root, "../../escape"), /Invalid rebuttal ID/);
    await withdrawRebuttal(agentDir, snapshot.root, record.id);
    assert.deepEqual(await relevantRebuttals(agentDir, snapshot), []);
    assert.ok((await listRebuttals(agentDir, snapshot.root))[0].withdrawnAt);
    assert.equal(parseRequest("dirty --no-feedback")?.useFeedback, false);
  } finally { await fs.rm(agentDir, { recursive: true, force: true }); }
});

test("new reports and legacy reports remain readable without silently inventing legacy kind", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-compatibility-"));
  try {
    const current = makeRun(); await saveReport(agentDir, current);
    assert.equal((await loadLast(agentDir, snapshot.root)).version, 2);
    const legacy = structuredClone(current); legacy.version = 1;
    for (const f of (legacy.stages[0].output as { findings: Finding[] }).findings) delete (f as Partial<Finding>).kind;
    delete legacy.snapshot.feedbackScope;
    await saveReport(agentDir, legacy);
    assert.match(renderReport(await loadLast(agentDir, snapshot.root)), /unclassified \(legacy\)/);
    await assert.rejects(recordRebuttal(agentDir, legacy, "bug-1", "why"), /legacy report/);
  } finally { await fs.rm(agentDir, { recursive: true, force: true }); }
});

test("evaluation planner is opt-in, needs no credentials, and reports its fixture plan without creating artifacts", async () => {
  const agentDir = await fs.mkdtemp(path.join(os.tmpdir(), "review-eval-plan-"));
  try {
    const stdout = execFileSync(process.execPath, ["--experimental-strip-types", "pi-extensions/pr-review/eval/run.ts", "--case", "guard-preserved"], { cwd: process.cwd(), encoding: "utf8", env: { ...process.env, PI_CODING_AGENT_DIR: agentDir, PI_OFFLINE: "1" } });
    assert.match(stdout, /PLAN ONLY: 1 cases/); assert.match(stdout, /No model calls made/);
    assert.deepEqual(await fs.readdir(agentDir), []);
  } finally { await fs.rm(agentDir, { recursive: true, force: true }); }
});
