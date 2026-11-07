import * as fs from "node:fs/promises";
import * as path from "node:path";
import { randomUUID } from "node:crypto";
import { getAgentDir, getMarkdownTheme, ModelRuntime, type ExtensionAPI, type ExtensionContext, type ExtensionCommandContext } from "@earendil-works/pi-coding-agent";
import { Markdown } from "@earendil-works/pi-tui";
import { Type } from "typebox";
import { HELP, parseRequest, tokenize } from "./commands.ts";
import { listRebuttals, recordRebuttal, relevantRebuttals, withdrawRebuttal } from "./feedback.ts";
import { createStageRunner, runPipeline } from "./engine.ts";
import { git } from "./git.ts";
import { clean, loadLast, renderReport, saveReport } from "./report.ts";
import { truncate } from "./files.ts";
import { prepareSnapshot, removeSnapshot } from "./snapshot.ts";
import { ReviewProgressPanel, STAGES } from "./progress.ts";
import { addModelUsage, addUsage, emptyModelUsage, emptyUsage, type ReviewConfig, type ReviewRequest, type ReviewRun, type Stage, type Thinking } from "./types.ts";

const thinkingLevels: Thinking[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];
const configPath = () => path.join(getAgentDir(), "pr-review", "config.json");
async function loadConfig(): Promise<ReviewConfig | undefined> {
  try {
    const config = JSON.parse(await fs.readFile(configPath(), "utf8")) as ReviewConfig;
    if (!config.provider || !config.model || !thinkingLevels.includes(config.thinking)) throw new Error("Invalid pr-review config; run /pr-review config");
    return config;
  } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw error; }
}
async function saveConfig(config: ReviewConfig): Promise<void> {
  await fs.mkdir(path.dirname(configPath()), { recursive: true, mode: 0o700 });
  const temp = `${configPath()}.${randomUUID()}`;
  await fs.writeFile(temp, JSON.stringify(config, null, 2), { mode: 0o600 });
  await fs.rename(temp, configPath());
}
async function scopeRoot(cwd: string): Promise<string> {
  try { return (await git(cwd, ["rev-parse", "--show-toplevel"])).toString().trim(); }
  catch { return await fs.realpath(cwd); }
}
async function configure(ctx: ExtensionContext, args = ""): Promise<ReviewConfig | undefined> {
  const tokens = tokenize(args);
  let provider: string, model: string, thinking: Thinking;
  if (tokens.length) {
    if (tokens.length > 2) throw new Error("Expected PROVIDER/MODEL [THINKING]");
    const slash = tokens[0].indexOf("/");
    if (slash <= 0) throw new Error("Specify provider/model (not a bare model ID)");
    provider = tokens[0].slice(0, slash); model = tokens[0].slice(slash + 1);
    thinking = (tokens[1] ?? "medium") as Thinking;
    if (!thinkingLevels.includes(thinking)) throw new Error(`Thinking must be one of: ${thinkingLevels.join(", ")}`);
  } else {
    if (!ctx.hasUI) throw new Error("Configure a fixed review model using /pr-review config PROVIDER/MODEL [THINKING]");
    const models = ctx.modelRegistry.getAvailable();
    const activeId = ctx.model && `${ctx.model.provider}/${ctx.model.id}`;
    const ids = models.map(m => `${m.provider}/${m.id}`).sort();
    if (activeId) { const i = ids.indexOf(activeId); if (i >= 0) ids.splice(i, 1); ids.unshift(activeId); }
    if (!ids.length) throw new Error("No models available; configure authentication in pi first");
    const selected = await ctx.ui.select("Pin one model for all review stages (first entry is active model)", ids);
    if (!selected) return;
    const selectedThinking = await ctx.ui.select("Pinned review thinking level", thinkingLevels);
    if (!selectedThinking) return;
    const slash = selected.indexOf("/");
    provider = selected.slice(0, slash); model = selected.slice(slash + 1); thinking = selectedThinking as Thinking;
  }
  const resolved = ctx.modelRegistry.find(provider, model);
  if (!resolved) throw new Error(`Review model unavailable: ${provider}/${model}`);
  const auth = await ctx.modelRegistry.getApiKeyAndHeaders(resolved);
  if (!auth.ok) throw new Error(`Review model authentication failed: ${auth.error}`);
  const config = { provider, model, thinking };
  await saveConfig(config);
  ctx.ui.notify(`Pinned review model: ${provider}/${model} (${thinking})`, "info");
  return config;
}
async function pickRequest(ctx: ExtensionContext): Promise<ReviewRequest | undefined> {
  if (!ctx.hasUI) throw new Error("Specify a review target explicitly in non-interactive mode");
  const choice = await ctx.ui.select("What should we review?", ["Whole branch", "Dirty changes", "Staged changes", "Commit comparison", "GitHub PR"]);
  if (!choice) return;
  const defaults = { context: "", exclude: [] as string[] };
  if (choice === "Whole branch") return { ...defaults, target: { kind: "branch" } };
  if (choice === "Dirty changes") return { ...defaults, target: { kind: "dirty" } };
  if (choice === "Staged changes") return { ...defaults, target: { kind: "staged" } };
  if (choice === "GitHub PR") {
    const reference = await ctx.ui.input("GitHub PR URL or owner/repo#123");
    return reference ? { ...defaults, target: { kind: "pr", reference } } : undefined;
  }
  const base = await ctx.ui.input("Base revision (append ... for merge-base comparison)");
  if (!base) return;
  const head = await ctx.ui.input("Target revision", "HEAD");
  return head ? { ...defaults, target: { kind: "range", base, head } } : undefined;
}

export default function (pi: ExtensionAPI) {
  let active: AbortController | undefined;
  let alive = true;
  pi.on("session_start", () => { alive = true; });
  pi.on("session_shutdown", () => { alive = false; active?.abort(); });
  pi.registerMessageRenderer("pr-review", (message, options) => new Markdown(
    String((message.details as { fullReport?: string } | undefined)?.fullReport ?? message.content), options.outputPad, 0, getMarkdownTheme(),
  ));

  function publish(ctx: ExtensionContext, content: string, details?: Record<string, unknown>): void {
    const safe = clean(content);
    pi.sendMessage({ customType: "pr-review", content: truncate(safe, undefined, "[Report context truncated; full report remains visible and available in saved files.]"), display: true, details: { ...details, fullReport: safe } });
    // PrintMode emits assistant text, not custom messages; command results need an explicit stdout path.
    if (ctx.mode === "print") process.stdout.write(`${safe}\n`);
  }

  async function executeReview(request: ReviewRequest, ctx: ExtensionContext, controller: AbortController, update?: (text: string) => void, onStages?: (activities: ReadonlyMap<Stage, string>) => void): Promise<{ run: ReviewRun; directory: string }> {
    const signal = controller.signal;
    let config = await loadConfig();
    if (!config) config = await configure(ctx);
    if (!config) throw new Error("Review cancelled: no fixed model configured");
    if (request.target.kind === "pr") {
      if (!ctx.hasUI || !await ctx.ui.confirm("Retrieve GitHub PR?", "This uses gh and Git to download PR metadata and source objects into a temporary directory. No checkout, tests, or repository code execution.", { signal }))
        throw new Error("PR retrieval requires interactive approval");
    }
    update?.("Capturing matching base/target snapshots…");
    const started = Date.now();
    const snapshot = await prepareSnapshot(ctx.cwd, request, signal);
    try {
      snapshot.root = await scopeRoot(ctx.cwd);
      snapshot.feedback = await relevantRebuttals(getAgentDir(), snapshot, request.useFeedback !== false);
      if (request.useFeedback === false) snapshot.limitations.push("Saved rebuttals intentionally omitted (--no-feedback).");
      signal.throwIfAborted();
      const preview = `${snapshot.label}\n${snapshot.changedFiles.length} changed files · ${Buffer.byteLength(snapshot.diff)} diff bytes\nModel: ${config.provider}/${config.model} (${config.thinking})\n${snapshot.changedFiles.slice(0, 20).join("\n")}${snapshot.changedFiles.length > 20 ? "\n…" : ""}\n\n${snapshot.feedback.length} scoped historical explanations supplied (not automatic suppression).\nInspection only. ${snapshot.limitations.join("\n")}`;
      if (ctx.hasUI && !await ctx.ui.confirm("Start multi-agent review?", preview, { signal })) throw new Error("Review cancelled");
      const model = ctx.modelRegistry.find(config.provider, config.model);
      if (!model) throw new Error("Pinned review model no longer exists; run /pr-review config");
      // Reuse effective host provider composition/auth, but never host project resources/history.
      const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal });
      const provider = ctx.modelRegistry.getProvider(config.provider);
      if (provider) runtime.registerNativeProvider(provider);
      const auth = await ctx.modelRegistry.getApiKeyAndHeaders(model);
      if (!auth.ok) throw new Error(auth.error);
      if (auth.apiKey && !ctx.modelRegistry.isUsingOAuth(model)) await runtime.setRuntimeApiKey(config.provider, auth.apiKey, { signal });
      const activities = new Map<Stage, string>(STAGES.map(stage => [stage, "queued"]));
      const runner = createStageRunner({ snapshot, config, model, modelRuntime: runtime, signal,
        onProgress: (stage, activity) => {
          activities.set(stage, activity);
          const text = [...activities].map(([name, state]) => `${name}: ${state}`).join(" · ");
          update?.(text);
          onStages?.(activities);
        },
      });
      const stages = await runPipeline(snapshot, runner);
      signal.throwIfAborted();
      const usage = emptyUsage();
      for (const stage of stages) addUsage(usage, stage.usage);
      const { workspace: _workspace, files: _files, ...savedSnapshot } = snapshot;
      const run: ReviewRun = { version: 2, id: randomUUID(), createdAt: new Date().toISOString(), config, request, snapshot: savedSnapshot,
        stages, complete: stages.length === 6 && stages.every(s => s.status === "done"), elapsedMs: Date.now() - started, usage,
        limitations: ["No merge recommendation. Runtime-dependent concerns require separately approved testing."] };
      const directory = await saveReport(getAgentDir(), run);
      signal.throwIfAborted();
      return { run, directory };
    } finally { await removeSnapshot(snapshot); }
  }

  async function withController<T>(ctx: ExtensionContext, work: (controller: AbortController) => Promise<T>, signal?: AbortSignal): Promise<T> {
    if (active) throw new Error("A review is already running; use /pr-review cancel first");
    const controller = new AbortController(); active = controller;
    const abort = () => controller.abort();
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) abort();
    try { return await work(controller); }
    finally {
      signal?.removeEventListener("abort", abort);
      if (active === controller) active = undefined;
      if (alive) ctx.ui.setStatus("pr-review", undefined);
    }
  }
  async function reviewCommand(request: ReviewRequest, ctx: ExtensionCommandContext) {
    // The loader is an overlay: selection/confirmation dialogs temporarily take input.
    const result = await withController(ctx, async controller => {
      if (ctx.mode !== "tui") return executeReview(request, ctx, controller, text => ctx.ui.setStatus("pr-review", text));
      // One stage rail per full review. Escape aborts work; closure waits for all cleanup before closing.
      return ctx.ui.custom<{ run: ReviewRun; directory: string } | { error: Error }>((tui, theme, keybindings, done) => {
        const panel = new ReviewProgressPanel(tui, theme, keybindings, () => controller.abort());
        void executeReview(request, ctx, controller, undefined, activities => panel.setActivities(activities))
          .then(done, error => done({ error: error instanceof Error ? error : new Error(String(error)) }));
        return panel;
      }, { overlay: true, overlayOptions: { width: "75%", maxHeight: 20 } });
    });
    if (!result || "error" in result) throw result?.error ?? new Error("Review cancelled");
    if (!alive) return;
    publish(ctx, `${renderReport(result.run)}\nSaved: \`${result.directory}\`\nUse /pr-review details to inspect stage reports; discuss findings here.`, { reportDirectory: result.directory });
    pi.appendEntry("pr-review-report", { id: result.run.id, directory: result.directory });
  }

  pi.registerCommand("pr-review", {
    description: "Independent four-agent review + skeptical verification. Inspection only. No args opens target picker.",
    getArgumentCompletions: prefix => ["branch", "dirty", "staged", "range", "pr", "config", "last", "details", "rebut", "rebuttals", "forget", "cancel", "help"]
      .filter(value => value.startsWith(prefix)).map(value => ({ value, label: value })),
    handler: async (args, ctx) => {
      try {
        const [command, ...rest] = tokenize(args);
        if (command === "help" || command === "--help") { publish(ctx, HELP); return; }
        if (command === "cancel") { active?.abort(); ctx.ui.notify(active ? "Cancelling review…" : "No active review", "info"); return; }
        if (command === "config") { if (active) throw new Error("Wait for the active review before changing config"); await configure(ctx, rest.join(" ")); return; }
        if (command === "rebuttals") {
          if (rest.length) throw new Error("Usage: /pr-review rebuttals");
          const records = await listRebuttals(getAgentDir(), await scopeRoot(ctx.cwd));
          publish(ctx, records.length ? records.map(record => `### ${record.id} (${record.withdrawnAt ? "withdrawn" : "active"})\nScope: ${record.scope} · ${record.findingId} in review ${record.reviewId}\n${record.title}\n${record.explanation}`).join("\n\n") : "No saved rebuttals for this repository.");
          return;
        }
        if (command === "rebut" || command === "forget") {
          if (active) throw new Error("Wait for the active review before changing feedback");
          const root = await scopeRoot(ctx.cwd);
          if (command === "forget") {
            if (rest.length !== 1) throw new Error("Usage: /pr-review forget REBUTTAL_ID");
            await withdrawRebuttal(getAgentDir(), root, rest[0]);
            publish(ctx, `Rebuttal ${rest[0]} withdrawn; its audit record is retained.`); return;
          }
          if (!rest[0]) throw new Error('Usage: /pr-review rebut CANDIDATE_ID "explanation"');
          const run = await loadLast(getAgentDir(), root);
          const explanation = rest.slice(1).join(" ") || (ctx.hasUI ? await ctx.ui.editor("Explain this finding (saved for later reviews in the same scope)") : undefined);
          if (!explanation?.trim()) return;
          if (ctx.hasUI && !await ctx.ui.confirm("Save scoped rebuttal?", `Saved locally and supplied to future review models for ${run.snapshot.feedbackScope ?? "legacy/unknown scope"}. This will not close or suppress the finding. Check your explanation for secrets.\n\n${explanation}`)) return;
          const record = await recordRebuttal(getAgentDir(), run, rest[0], explanation);
          publish(ctx, `Saved rebuttal ${record.id} for ${record.findingId}. Scope: ${record.scope}. Use --no-feedback to omit explanations, or /pr-review forget ${record.id} to withdraw it.`);
          return;
        }
        if (command === "last" || command === "details") {
          const run = await loadLast(getAgentDir(), await scopeRoot(ctx.cwd));
          publish(ctx, renderReport(run, command === "details")); return;
        }
        if (active) throw new Error("A review is already running");
        const request = parseRequest(args) ?? await pickRequest(ctx);
        if (request) await reviewCommand(request, ctx);
      } catch (error) {
        if (!alive) return;
        const message = (error as Error).message;
        if (ctx.hasUI) ctx.ui.notify(message, /cancel|abort/i.test(message) ? "info" : "error");
        else publish(ctx, `Review error: ${message}`);
      }
    },
  });

  pi.registerTool({
    name: "review_changes", label: "Multi-agent review",
    description: "Run an inspection-only four-reviewer + skeptical-verifier review. Use ONLY when the user explicitly requests multi-agent review; never automatically after edits. Requires a configured fixed model. Specify args like 'branch --base origin/main', 'dirty', 'staged', 'range BASE HEAD', or 'pr URL'. No tests or fixes are executed.",
    parameters: Type.Object({ args: Type.String({ description: "Explicit /pr-review target and optional --context/--exclude flags" }) }),
    async execute(_id, params, signal, onUpdate, ctx) {
      const request = parseRequest(params.args);
      if (!request) throw new Error("Explicit target required for review_changes");
      const result = await withController(ctx, controller => executeReview(request, ctx, controller, text => {
        onUpdate?.({ content: [{ type: "text", text }], details: {} });
      }), signal);
      // Complete pipeline results are not summarized/reclassified by the parent. Keep the exact report accessible.
      const report = renderReport(result.run);
      const usage = emptyModelUsage();
      for (const stage of result.run.stages) if (stage.modelUsage) addModelUsage(usage, stage.modelUsage);
      return { content: [{ type: "text", text: `${truncate(report, undefined, "[Report truncated for model context; read the full saved review.md for remaining findings.]")}\nFull saved reports: ${result.directory}` }], details: { run: result.run, reportDirectory: result.directory }, usage, terminate: true };
    },
    renderResult(result, { expanded }) {
      const details = result.details as { run?: ReviewRun; reportDirectory?: string } | undefined;
      const text = details?.run ? `${renderReport(details.run, expanded)}\nSaved: ${details.reportDirectory}`
        : result.content.filter(c => c.type === "text").map(c => c.text).join("\n");
      return new Markdown(text, 0, 0, getMarkdownTheme());
    },
  });
}
