import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { ModelRuntime } from "@earendil-works/pi-coding-agent";
import { createStageRunner, runPipeline } from "./engine.ts";
import type { Snapshot } from "./types.ts";

// This exercises real AgentSession/tool execution with a scripted LOCAL provider, not a paid model.
test("real SDK sessions expose only inspection/submission tools and terminate on validated structured reports", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-sdk-"));
  try {
    await fs.mkdir(path.join(workspace, "target")); await fs.mkdir(path.join(workspace, "base"));
    await fs.writeFile(path.join(workspace, "target", "code.ts"), "export const value = 2;\n");
    await fs.writeFile(path.join(workspace, "base", "code.ts"), "export const value = 1;\n");
    // A repo extension that would fail if discovery accidentally ran.
    await fs.mkdir(path.join(workspace, "target", ".pi", "extensions"), { recursive: true });
    await fs.writeFile(path.join(workspace, "target", ".pi", "extensions", "evil.ts"), "throw new Error('REPO EXTENSION LOADED');");
    const snapshot: Snapshot = { workspace, root: workspace, label: "Test", baseRevision: "base", targetRevision: "head", diff: "+value=2", diffHash: "hash", changedFiles: ["code.ts"], files: { base: ["code.ts"], target: ["code.ts"] }, limitations: [], context: "" };
    const faux = fauxProvider({ provider: "review-test", models: [{ id: "local", contextWindow: 100000, maxTokens: 4096 }], tokensPerSecond: 100000 });
    const respond: FauxResponseFactory = context => {
      const synthesize = context.systemPrompt?.includes("# Synthesizer");
      assert.deepEqual(context.tools?.map(tool => tool.name).sort(), synthesize ? ["submit_review"] : ["review_list", "review_read", "review_search", "submit_review"]);
      if (!synthesize && !context.messages.some(m => m.role === "toolResult" && m.toolName === "review_read"))
        return fauxAssistantMessage(fauxToolCall("review_read", { path: "code.ts" }), { stopReason: "toolUse" });
      const output = synthesize ? { summary: "Value changed", groups: [], limitations: [] }
        : context.systemPrompt?.includes("# Skeptical Verifier") ? { verdicts: [], limitations: [] }
        : { summary: "Inspected code.ts", findings: [], limitations: [] };
      return fauxAssistantMessage(fauxToolCall("submit_review", output), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 20 }, () => respond));
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: path.join(workspace, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const runner = createStageRunner({ snapshot, config: { provider: "review-test", model: "local", thinking: "off" },
      model: faux.getModel(), modelRuntime: runtime, signal: new AbortController().signal });
    const stages = await runPipeline(snapshot, runner);
    assert.equal(stages.length, 6);
    assert.ok(stages.every(stage => stage.status === "done"), JSON.stringify(stages, null, 2));
    assert.equal(faux.state.callCount, 11); // 5 inspection reads + 6 submissions, no extra synthesis turns.
    assert.ok(stages.slice(0, 5).every(stage => stage.calls.some(call => call.tool === "review_read")));
    assert.ok(stages.at(-1)!.calls.every(call => call.tool === "submit_review"));
  } finally { await fs.rm(workspace, { recursive: true, force: true }); }
});
