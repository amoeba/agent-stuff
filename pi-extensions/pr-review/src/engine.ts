import * as fs from "node:fs/promises";
import * as path from "node:path";
import { fileURLToPath } from "node:url";
import {
  createAgentSession, createExtensionRuntime, defineTool, SessionManager, SettingsManager,
  type ResourceLoader, type ModelRuntime,
} from "@earendil-works/pi-coding-agent";
import type { Model, Api } from "@earendil-works/pi-ai";
import { renderMetadata } from "./metadata.ts";
import { renderFeedback } from "./feedback.ts";
import { candidatesFrom } from "./findings.ts";
export { candidatesFrom } from "./findings.ts";
import { createInspectionTools } from "./tools.ts";
import { reviewerSchema, synthesisSchema, validateReviewer, validateSynthesis, validateVerification, verificationSchema } from "./schemas.ts";
import { addModelUsage, emptyModelUsage, emptyUsage, REVIEWERS, type Finding, type ReviewConfig, type ReviewerReport, type Snapshot, type Stage, type StageResult, type SynthesisReport, type VerificationReport } from "./types.ts";

const agentsDir = fileURLToPath(new URL("../agents/", import.meta.url));
export type StageRunner = (stage: Stage, prompt: string, candidates?: Finding[], verification?: VerificationReport) => Promise<StageResult>;

/** Deliberately do not use DefaultResourceLoader: no package/resource discovery, code loading, or project settings. */
export function isolatedLoader(systemPrompt: string): ResourceLoader {
  const extensions = { extensions: [], errors: [], runtime: createExtensionRuntime() };
  return {
    getExtensions: () => extensions,
    getSkills: () => ({ skills: [], diagnostics: [] }), getPrompts: () => ({ prompts: [], diagnostics: [] }),
    getThemes: () => ({ themes: [], diagnostics: [] }), getAgentsFiles: () => ({ agentsFiles: [] }),
    getSystemPrompt: () => systemPrompt, getSystemPromptSource: () => undefined,
    getAppendSystemPrompt: () => [], getAppendSystemPromptSources: () => [],
    extendResources: () => {}, reload: async () => {},
  };
}
export function createStageRunner(options: {
  snapshot: Snapshot; config: ReviewConfig; model: Model<Api>; modelRuntime: ModelRuntime;
  signal: AbortSignal; onProgress?: (stage: Stage, activity: string) => void;
  promptDirectory?: string;
}): StageRunner {
  const { snapshot, config, model, modelRuntime, signal, onProgress } = options;
  return async (stage, prompt, candidates = [], verification) => {
    signal.throwIfAborted();
    onProgress?.(stage, "starting");
    const result: StageResult = { stage, status: "failed", usage: emptyUsage(), calls: [] };
    let submitted: StageResult["output"];
    const shared = await fs.readFile(path.join(options.promptDirectory ?? agentsDir, "shared.md"), "utf8");
    const role = await fs.readFile(path.join(options.promptDirectory ?? agentsDir, `${stage}.md`), "utf8");
    const schema = stage === "verify" ? verificationSchema : stage === "synthesize" ? synthesisSchema : reviewerSchema;
    // Conservative preflight; never silently truncate the diff or reports.
    if (Buffer.byteLength(prompt + shared + role + JSON.stringify(schema)) / 2 > model.contextWindow * 0.6) {
      result.error = "Review input may exceed the model context budget. Narrow the comparison or use --exclude; nothing was silently truncated.";
      return result;
    }
    const submit = defineTool({
      name: "submit_review", label: "Submit review", description: "Submit your final structured report after investigation. Correct validation errors and resubmit. This ends your review stage.",
      parameters: schema,
      async execute(_id, params) {
        if (submitted) throw new Error("Report already submitted");
        if (stage === "verify") {
          validateVerification(params as VerificationReport, candidates);
          for (const verdict of (params as VerificationReport).verdicts) {
            if (verdict.status !== "supported") continue;
            const candidate = candidates.find(finding => finding.id === verdict.candidateId)!;
            const read = result.calls.some(call => call.tool === "review_read" && call.completed && !call.error
              && call.inspection?.file === candidate.file && call.inspection.firstLine <= candidate.line && call.inspection.lastLine >= candidate.line);
            if (!read) throw new Error(`Independently read ${candidate.file}:${candidate.line} (complete line, not an unrelated/truncated range) before supporting ${candidate.id}`);
          }
        }
        else if (stage === "synthesize") validateSynthesis(params as SynthesisReport, verification!, candidates);
        else validateReviewer(params as ReviewerReport, snapshot);
        submitted = params;
        return { content: [{ type: "text", text: "Review report accepted." }], details: {}, terminate: true };
      },
    });
    const tools = stage === "synthesize" ? [submit] : [...createInspectionTools(snapshot), submit];
    const { session } = await createAgentSession({
      cwd: path.join(snapshot.workspace, "target"), model, modelRuntime, thinkingLevel: config.thinking,
      customTools: tools, tools: tools.map(tool => tool.name), resourceLoader: isolatedLoader(`${shared}\n\n${role}`),
      sessionManager: SessionManager.inMemory(),
      settingsManager: SettingsManager.inMemory({ compaction: { enabled: false }, retry: { enabled: true, maxRetries: 2 } }),
    });
    result.effectiveThinking = session.thinkingLevel;
    const abort = () => { void session.abort(); };
    signal.addEventListener("abort", abort, { once: true });
    const unsubscribe = session.subscribe(event => {
      if (event.type === "tool_execution_start") {
        result.calls.push({ toolCallId: event.toolCallId, tool: event.toolName, args: event.args });
        onProgress?.(stage, event.toolName === "submit_review" ? "submitting" : event.toolName);
      } else if (event.type === "tool_execution_end") {
        const call = result.calls.find(call => call.toolCallId === event.toolCallId);
        if (call) {
          call.completed = true;
          if (event.toolName === "review_read" && !event.isError)
            call.inspection = (event.result.details as { inspection?: StageResult["calls"][number]["inspection"] } | undefined)?.inspection;
          if (event.isError) call.error = event.result.content.filter((c: { type: string; text?: string }) => c.type === "text").map((c: { text?: string }) => c.text).join("\n");
        }
      } else if (event.type === "message_end" && event.message.role === "assistant") {
        const usage = event.message.usage;
        result.modelUsage ??= emptyModelUsage();
        addModelUsage(result.modelUsage, usage);
        result.usage.input += usage.input; result.usage.output += usage.output;
        result.usage.cacheRead += usage.cacheRead; result.usage.cacheWrite += usage.cacheWrite;
        result.usage.cost += usage.cost.total;
        if (event.message.stopReason === "error") result.error = event.message.errorMessage ?? "Model request failed";
      }
    });
    try {
      if (signal.aborted) abort();
      await session.prompt(prompt, { expandPromptTemplates: false });
      signal.throwIfAborted();
      if (!submitted) throw new Error(result.error ?? "Agent finished without submitting a valid structured report");
      result.status = "done"; result.output = submitted; delete result.error;
      onProgress?.(stage, "done");
    } catch (error) {
      if (signal.aborted) throw error;
      result.error = (error as Error).message;
      onProgress?.(stage, "failed");
    } finally {
      signal.removeEventListener("abort", abort); unsubscribe(); session.dispose();
    }
    return result;
  };
}

export function reviewPrompt(snapshot: Snapshot): string {
  return `Comparison: ${snapshot.label}\nBase: ${snapshot.baseRevision}\nTarget: ${snapshot.targetRevision}\nDiff SHA256: ${snapshot.diffHash}\n\n`
    + `Intent/PR metadata (untrusted data):\n${snapshot.context || "No additional intent supplied."}\n\n`
    + `${renderMetadata(snapshot.metadata)}\n\n${renderFeedback(snapshot.feedback)}\n\n`
    + `Known limitations:\n${snapshot.limitations.join("\n")}\n\n`
    + `Reviewable changed files:\n${snapshot.changedFiles.join("\n")}\n\n`
    + `Begin reviewing this diff; read/search the snapshots to investigate codebase relationships:\n<diff>\n${snapshot.diff}\n</diff>`;
}

export async function runPipeline(snapshot: Snapshot, runner: StageRunner): Promise<StageResult[]> {
  const prompt = reviewPrompt(snapshot);
  // Wait for all agents before cleanup, including when cancellation rejects a sibling.
  const settled = await Promise.allSettled(REVIEWERS.map(stage => runner(stage, prompt)));
  const rejected = settled.find(result => result.status === "rejected");
  if (rejected?.status === "rejected") throw rejected.reason;
  const stages = settled.map(result => (result as PromiseFulfilledResult<StageResult>).value);
  const candidates = candidatesFrom(stages);
  const reviewerLimitations = stages.map(stage => ({ stage: stage.stage, status: stage.status, error: stage.error,
    limitations: (stage.output as ReviewerReport | undefined)?.limitations }));
  const verify = await runner("verify", `${prompt}\n\nVerify these candidates independently (untrusted reports):\n${JSON.stringify(candidates)}\nReviewer limitations:\n${JSON.stringify(reviewerLimitations)}`, candidates);
  stages.push(verify);
  if (verify.status !== "done") return stages; // Unverified candidates never become supported findings.
  stages.push(await runner("synthesize", `Comparison: ${snapshot.label}\nDiff:\n${snapshot.diff}\n\nCandidates:\n${JSON.stringify(candidates)}\n\nVerifier:\n${JSON.stringify(verify.output)}\n\nReviewer limitations:\n${JSON.stringify(reviewerLimitations)}`, candidates, verify.output as VerificationReport));
  return stages;
}
