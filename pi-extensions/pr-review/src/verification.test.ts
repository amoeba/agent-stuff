import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createInspectionTools } from "./tools.ts";
import { createStageRunner } from "./engine.ts";
import type { Finding, Snapshot } from "./types.ts";

async function setup(contextWindow = 100000, tokensPerSecond = 100000) {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-verifier-"));
  await fs.mkdir(path.join(workspace, "target")); await fs.mkdir(path.join(workspace, "base"));
  await fs.writeFile(path.join(workspace, "target", "code.ts"), "const value = 2;\n");
  const snapshot: Snapshot = { workspace, root: workspace, label: "Test", baseRevision: "base", targetRevision: "head", diff: "+value=2", diffHash: "hash", changedFiles: ["code.ts"], files: { base: [], target: ["code.ts"] }, limitations: [], context: "" };
  const faux = fauxProvider({ provider: "verification-test", models: [{ id: "local", contextWindow }], tokensPerSecond, tokenSize: { min: 1, max: 1 } });
  const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
    modelsStorePath: path.join(workspace, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
  runtime.registerNativeProvider(faux.provider);
  const controller = new AbortController();
  const runner = createStageRunner({ snapshot, config: { provider: "verification-test", model: "local", thinking: "off" },
    model: faux.getModel(), modelRuntime: runtime, signal: controller.signal });
  return { workspace, faux, runner, controller, cleanup: () => fs.rm(workspace, { recursive: true, force: true }) };
}

test("verifier cannot mark source-supported findings without independently reading the finding location", async () => {
  const fixture = await setup();
  try {
    const candidate: Finding = { id: "bug-1", title: "Concrete issue", severity: "medium", kind: "defect", file: "code.ts", line: 1,
      changedFile: "code.ts", change: "Changed value", scenario: "Consumer expects previous value", consequence: "Wrong result",
      evidence: ["code.ts:1 changed constant"], assumptions: [], inspected: ["code.ts:1"], gap: "", suggestedTest: "Check result", fix: "Update consumer" };
    const output = { verdicts: [{ candidateId: "bug-1", status: "supported", reason: "Source supports it", disconfirmation: "Checked the consuming path and guards for the stated input", evidence: ["code.ts:1"], inspected: ["code.ts:1"], gap: "", suggestedTest: "Check consumer result" }], limitations: [] };
    const respond: FauxResponseFactory = (_context, _options, state) => {
      if (state.callCount === 2) return fauxAssistantMessage(fauxToolCall("review_read", { path: "code.ts" }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall("submit_review", output), { stopReason: "toolUse" });
    };
    fixture.faux.setResponses([respond, respond, respond]);
    const result = await fixture.runner("verify", "Verify candidate", [candidate]);
    assert.equal(result.status, "done", JSON.stringify(result));
    assert.match(result.calls[0].error ?? "", /Independently read code.ts/);
    assert.equal(result.calls[1].tool, "review_read"); assert.equal(result.calls[1].completed, true);
    assert.equal(fixture.faux.state.callCount, 3);
  } finally { await fixture.cleanup(); }
});

test("oversized review input fails explicitly before any model call", async () => {
  const fixture = await setup(100);
  try {
    const result = await fixture.runner("bug", "x".repeat(5000));
    assert.equal(result.status, "failed"); assert.match(result.error ?? "", /nothing was silently truncated/);
    assert.equal(fixture.faux.state.callCount, 0);
  } finally { await fixture.cleanup(); }
});

test("cancellation propagates into a real SDK stream", { timeout: 5000 }, async () => {
  const fixture = await setup(100000, 1);
  try {
    fixture.faux.setResponses([fauxAssistantMessage("A deliberately slow local scripted response for cancellation testing.")]);
    const pending = fixture.runner("bug", "Inspect the diff");
    const timer = setTimeout(() => fixture.controller.abort(), 50);
    try { await assert.rejects(pending); }
    finally { clearTimeout(timer); }
  } finally { await fixture.cleanup(); }
});

test("verifier support requires the cited line rather than an unrelated successful read", async () => {
  const fixture = await setup();
  try {
    await fs.writeFile(path.join(fixture.workspace, "target", "code.ts"), "const value=2;\nconst extra=3;\n");
    const candidate: Finding = { id: "bug-1", title: "Concrete issue", severity: "high", kind: "defect", file: "code.ts", line: 2,
      changedFile: "code.ts", change: "Changed extra", scenario: "Caller reads extra", consequence: "Minor localized delay", evidence: ["code.ts:2"], assumptions: [], inspected: [], gap: "", suggestedTest: "Observe the caller", fix: "Coordinate caller" };
    const report = { verdicts: [{ candidateId: "bug-1", status: "supported", reason: "Source supports localized issue", disconfirmation: "Checked reachable caller/guard conditions", severityOverride: "low", severityReason: "Only localized minor harm is established", evidence: ["code.ts:2"], inspected: ["code.ts:2"], gap: "", suggestedTest: "Observe the caller" }], limitations: [] };
    const respond: FauxResponseFactory = (_context, _options, state) => {
      if (state.callCount === 1) return fauxAssistantMessage(fauxToolCall("review_read", { path: "code.ts", offset: 1, limit: 1 }), { stopReason: "toolUse" });
      if (state.callCount === 3) return fauxAssistantMessage(fauxToolCall("review_read", { path: "code.ts", offset: 2, limit: 1 }), { stopReason: "toolUse" });
      return fauxAssistantMessage(fauxToolCall("submit_review", report), { stopReason: "toolUse" });
    };
    fixture.faux.setResponses([respond, respond, respond, respond]);
    const result = await fixture.runner("verify", "Verify the cited line", [candidate]);
    assert.equal(result.status, "done", JSON.stringify(result));
    assert.match(result.calls[1].error ?? "", /not an unrelated\/truncated range/);
    assert.equal(result.calls[0].inspection?.lastLine, 1);
    assert.equal(result.calls[2].inspection?.firstLine, 2);
    assert.equal((result.output as { verdicts: { severityOverride?: string }[] }).verdicts[0].severityOverride, "low");
  } finally { await fixture.cleanup(); }
});

test("truncated reads do not record an unseen or partial line as complete inspection", async () => {
  const fixture = await setup();
  try {
    await fs.writeFile(path.join(fixture.workspace, "target", "code.ts"), "x".repeat(60000) + "\nsmall\n");
    const reader = createInspectionTools({ workspace: fixture.workspace, root: fixture.workspace, label: "", baseRevision: "", targetRevision: "", diff: "", diffHash: "", changedFiles: [], files: { base: [], target: ["code.ts"] }, context: "", limitations: [] })[0];
    const result = await reader.execute("read", { path: "code.ts", offset: 1, limit: 2 }, undefined, undefined, {} as never);
    assert.ok(result.content.some(content => content.type === "text" && content.text.includes("truncated")));
    assert.equal(result.details.inspection.lastLine, 0);
    const next = await reader.execute("read", { path: "code.ts", offset: 2, limit: 1 }, undefined, undefined, {} as never);
    assert.equal(next.details.inspection.firstLine, 2); assert.equal(next.details.inspection.lastLine, 2);
  } finally { await fixture.cleanup(); }
});
