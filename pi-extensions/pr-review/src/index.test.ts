import { test } from "node:test";
import assert from "node:assert/strict";
import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { execFileSync } from "node:child_process";
import { fauxProvider, fauxAssistantMessage, fauxToolCall, InMemoryCredentialStore, type FauxResponseFactory } from "@earendil-works/pi-ai";
import { ModelRegistry, ModelRuntime, type ExtensionAPI, type ExtensionCommandContext, type RegisteredCommand } from "@earendil-works/pi-coding-agent";
import { listRebuttals } from "./feedback.ts";
import extension from "./index.ts";

test("full command config → dirty review → saved report works with real SDK and a local fake provider", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(workspace, "agent");
  try {
    const root = path.join(workspace, "repo"); await fs.mkdir(root);
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
    git(["init", "--quiet", "--initial-branch=main"]);
    await fs.writeFile(path.join(root, "code.ts"), "old\n"); git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
    await fs.writeFile(path.join(root, "code.ts"), "new\n");
    const faux = fauxProvider({ provider: "review-command", models: [{ id: "local", contextWindow: 100000 }], tokensPerSecond: 100000 });
    const response: FauxResponseFactory = context => fauxAssistantMessage(fauxToolCall("submit_review",
      context.systemPrompt?.includes("# Synthesizer") ? { summary: "Old changed to new", groups: [], limitations: [] }
        : context.systemPrompt?.includes("# Skeptical Verifier") ? { verdicts: [], limitations: [] }
        : { summary: "No concrete findings", findings: [], limitations: [] }), { stopReason: "toolUse" });
    faux.setResponses(Array.from({ length: 20 }, () => response));
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null,
      modelsStorePath: path.join(workspace, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    await runtime.setRuntimeApiKey("review-command", "local-test-key-not-a-real-secret");
    const commands = new Map<string, RegisteredCommand>();
    const messages: string[] = [], errors: string[] = [];
    extension({
      on: () => {}, registerMessageRenderer: () => {}, registerTool: () => {}, appendEntry: () => {},
      registerCommand: (name: string, definition: RegisteredCommand) => commands.set(name, definition),
      sendMessage: (message: { content: string }) => messages.push(message.content),
    } as unknown as ExtensionAPI);
    const ctx = {
      cwd: root, mode: "rpc", hasUI: true, modelRegistry: new ModelRegistry(runtime),
      ui: { notify: (message: string, level: string) => { if (level === "error") errors.push(message); },
        confirm: async () => true, setStatus: () => {} },
    } as unknown as ExtensionCommandContext;
    const command = commands.get("pr-review")!;
    await command.handler("config review-command/local off", ctx);
    assert.deepEqual(errors, []);
    const config = JSON.parse(await fs.readFile(path.join(process.env.PI_CODING_AGENT_DIR!, "pr-review", "config.json"), "utf8"));
    assert.equal(config.model, "local");
    await command.handler("dirty", ctx);
    assert.deepEqual(errors, []);
    assert.ok(messages.some(message => message.includes("Inspection complete")), messages.join("\n"));
    assert.ok(messages.some(message => message.includes("No merge recommendation")));
    assert.equal(faux.state.callCount, 6);
    await command.handler("details", ctx);
    assert.ok(messages.at(-1)?.includes("Individual stage reports"));
    assert.equal(await fs.readFile(path.join(root, "code.ts"), "utf8"), "new\n");
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});

test("command rebuttals reach the next scoped review, remain references rather than suppression, and can be omitted/withdrawn", async () => {
  const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "review-feedback-command-"));
  const previous = process.env.PI_CODING_AGENT_DIR;
  process.env.PI_CODING_AGENT_DIR = path.join(workspace, "agent");
  try {
    const root = path.join(workspace, "repo"); await fs.mkdir(root);
    const git = (args: string[]) => execFileSync("git", ["-c", "core.hooksPath=/dev/null", "-c", "user.name=Test", "-c", "user.email=test@example.invalid", ...args], { cwd: root });
    git(["init", "--quiet", "--initial-branch=main"]);
    await fs.writeFile(path.join(root, "code.ts"), "export const value=1;\n");
    await fs.writeFile(path.join(root, "caller.ts"), 'import {value} from "./code.js"; export function check(){if(value!==1)throw Error("unexpected")}\n');
    git(["add", "."]); git(["commit", "--quiet", "-m", "base"]);
    const scope = git(["rev-parse", "--show-toplevel"]).toString().trim();
    await fs.writeFile(path.join(root, "code.ts"), "export const value=2;\n");
    const faux = fauxProvider({ provider: "feedback-command", models: [{ id: "local", contextWindow: 100000 }], tokensPerSecond: 100000 });
    const prompts: string[] = [];
    const response: FauxResponseFactory = context => {
      prompts.push(JSON.stringify(context.messages));
      const isVerifier = context.systemPrompt?.includes("# Skeptical Verifier");
      if (isVerifier && !context.messages.some(message => message.role === "toolResult" && message.toolName === "review_read"))
        return fauxAssistantMessage(fauxToolCall("review_read", { path: "code.ts" }), { stopReason: "toolUse" });
      const output = context.systemPrompt?.includes("# Synthesizer") ? { summary: "Changed constant affects caller", groups: [{ title: "Caller rejects value", candidateIds: ["bug-1"] }], limitations: [] }
        : isVerifier ? { verdicts: [{ candidateId: "bug-1", status: "supported", reason: "The caller still requires 1", disconfirmation: "No translating guard exists in this snapshot; prior explanation is reference data", evidence: ["caller.ts:1", "code.ts:1"], inspected: ["code.ts:1"], gap: "", suggestedTest: "Call check" }], limitations: [] }
        : { summary: "", findings: context.systemPrompt?.includes("# Bug Hunter") ? [{ id: "1", title: "Caller rejects value", severity: "medium", kind: "defect", file: "code.ts", line: 1, changedFile: "code.ts", change: "Value changed from 1 to 2", scenario: "check is called", consequence: "Caller throws", evidence: ["caller.ts:1"], assumptions: [], inspected: ["code.ts:1"], gap: "", suggestedTest: "Call check", fix: "Coordinate the caller" }] : [], limitations: [] };
      return fauxAssistantMessage(fauxToolCall("submit_review", output), { stopReason: "toolUse" });
    };
    faux.setResponses(Array.from({ length: 100 }, () => response));
    const runtime = await ModelRuntime.create({ credentials: new InMemoryCredentialStore(), modelsPath: null, modelsStorePath: path.join(workspace, "models.json"), refreshOnCreate: false, allowModelNetwork: false });
    runtime.registerNativeProvider(faux.provider);
    const commands = new Map<string, RegisteredCommand>();
    const messages: string[] = [], errors: string[] = [];
    extension({ on: () => {}, registerMessageRenderer: () => {}, registerTool: () => {}, appendEntry: () => {},
      registerCommand: (name: string, definition: RegisteredCommand) => commands.set(name, definition),
      sendMessage: (message: { content: string }) => messages.push(message.content),
    } as unknown as ExtensionAPI);
    const ctx = { cwd: root, mode: "rpc", hasUI: true, modelRegistry: new ModelRegistry(runtime),
      ui: { notify: (message: string, level: string) => { if (level === "error") errors.push(message); }, confirm: async () => true, setStatus: () => {} },
    } as unknown as ExtensionCommandContext;
    const command = commands.get("pr-review")!;
    await command.handler("config feedback-command/local off", ctx);
    await command.handler("dirty", ctx);
    await command.handler('rebut bug-1 "An upstream guard handles the precondition."', ctx);
    const [record] = await listRebuttals(process.env.PI_CODING_AGENT_DIR!, scope);
    assert.ok(record, errors.join("\n"));
    prompts.length = 0;
    await command.handler("dirty", ctx);
    assert.ok(prompts.some(prompt => prompt.includes("An upstream guard handles the precondition.")));
    assert.match(messages.at(-1) ?? "", /bug-1 · medium · defect · Supported by inspection/); // No automatic suppression.
    prompts.length = 0;
    await command.handler("dirty --no-feedback", ctx);
    assert.ok(prompts.every(prompt => !prompt.includes("An upstream guard handles the precondition.")));
    await command.handler(`forget ${record.id}`, ctx);
    assert.ok((await listRebuttals(process.env.PI_CODING_AGENT_DIR!, scope))[0].withdrawnAt);
    assert.deepEqual(errors, []);
  } finally {
    if (previous === undefined) delete process.env.PI_CODING_AGENT_DIR; else process.env.PI_CODING_AGENT_DIR = previous;
    await fs.rm(workspace, { recursive: true, force: true });
  }
});
