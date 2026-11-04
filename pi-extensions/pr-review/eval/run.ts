import * as fs from "node:fs/promises";
import * as path from "node:path";
import * as os from "node:os";
import { createHash, randomUUID } from "node:crypto";
import { fileURLToPath } from "node:url";
import { getAgentDir, ModelRuntime } from "@earendil-works/pi-coding-agent";
import { cases, type EvaluationCase } from "./cases.ts";
import { createStageRunner, runPipeline } from "../src/engine.ts";
import { candidatesFrom } from "../src/findings.ts";
import { git } from "../src/git.ts";
import { prepareSnapshot, removeSnapshot } from "../src/snapshot.ts";
import { addUsage, emptyUsage, type ReviewConfig, type StageResult, type VerificationReport } from "../src/types.ts";

const args = process.argv.slice(2);
const run = args.includes("--run");
let caseId: string | undefined;
for (let i = 0; i < args.length; i++) {
  if (args[i] === "--run") continue;
  if (args[i] === "--case" && args[i + 1]) { caseId = args[++i]; continue; }
  throw new Error("Usage: npm run eval:pr-review -- [--case ID] [--run]");
}
const selected = cases.filter(fixture => !caseId || fixture.id === caseId);
if (!selected.length) throw new Error(`Unknown case ${caseId}`);
const variants = [
  { name: "baseline", directory: fileURLToPath(new URL("./baseline/", import.meta.url)) },
  { name: "current", directory: fileURLToPath(new URL("../agents/", import.meta.url)) },
];
console.log(`${run ? "RUN" : "PLAN ONLY"}: ${selected.length} cases × 2 prompt sets × up to 6 stages (${selected.length * 12} stage requests before retries/tool turns).`);
console.log(selected.map(fixture => `- ${fixture.id}: ${fixture.expected.description}`).join("\n"));
if (!run) {
  console.log("No model calls made. Add --run to opt into potentially paid calls using the pinned /pr-review config. Expected answers are NEVER sent to agents.");
} else {
  const config = JSON.parse(await fs.readFile(path.join(getAgentDir(), "pr-review", "config.json"), "utf8")) as ReviewConfig;
  if (!config.provider || !config.model || !["off", "minimal", "low", "medium", "high", "xhigh", "max"].includes(config.thinking)) throw new Error("Configure a fixed model with /pr-review config first");
  const controller = new AbortController();
  const abort = () => controller.abort();
  process.once("SIGINT", abort); process.once("SIGTERM", abort);
  const runtime = await ModelRuntime.create({ allowModelNetwork: false, signal: controller.signal });
  const model = runtime.getModel(config.provider, config.model);
  if (!model) throw new Error("Pinned model is unavailable to the standalone runtime. Eval does not load provider extensions; use a model in auth.json/models.json.");
  const output = path.join(getAgentDir(), "pr-review", "evaluations", randomUUID());
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  const hashes = await Promise.all(variants.map(async variant => {
    const roles = await Promise.all(["shared", "bug", "test", "impact", "quality", "verify", "synthesize"].map(async role => ({ role, content: await fs.readFile(path.join(variant.directory, `${role}.md`), "utf8") })));
    const frozen = path.join(output, "prompts", variant.name);
    await fs.mkdir(frozen, { recursive: true, mode: 0o700 });
    for (const { role, content } of roles) await fs.writeFile(path.join(frozen, `${role}.md`), content, { mode: 0o600 });
    variant.directory = frozen;
    return { name: variant.name, sha256: createHash("sha256").update(JSON.stringify(roles)).digest("hex") };
  }));
  const records: { caseId: string; variant: string; expected: EvaluationCase["expected"]; stages: StageResult[]; assessment: "pending-human-review" }[] = [];
  try {
    for (let index = 0; index < selected.length; index++) {
      const fixture = selected[index];
      controller.signal.throwIfAborted();
      const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "pr-review-eval-"));
      try {
        const write = async (files: Record<string, string>) => {
          for (const [file, text] of Object.entries(files)) {
            await fs.mkdir(path.dirname(path.join(workspace, file)), { recursive: true });
            await fs.writeFile(path.join(workspace, file), text, { mode: 0o600 });
          }
        };
        await write(fixture.base);
        await git(workspace, ["init", "--quiet", "--initial-branch=fixture"], controller.signal);
        await git(workspace, ["add", "--all", "--force"], controller.signal);
        await git(workspace, ["-c", "user.name=Review fixture", "-c", "user.email=fixture@example.invalid", "commit", "--quiet", "-m", "baseline"], controller.signal);
        await write(fixture.target);
        const snapshot = await prepareSnapshot(workspace, { target: { kind: "dirty" }, context: fixture.intent, exclude: fixture.exclude ?? [], useFeedback: false }, controller.signal);
        try {
          // Alternate ordering to reduce a systematic first/second variant bias. Context/schema/tools are identical.
          const order = index % 2 ? [...variants].reverse() : variants;
          for (const variant of order) {
            console.log(`${fixture.id}: ${variant.name}`);
            const runner = createStageRunner({ snapshot, config, model, modelRuntime: runtime, signal: controller.signal, promptDirectory: variant.directory });
            const stages = await runPipeline(snapshot, runner);
            records.push({ caseId: fixture.id, variant: variant.name, expected: fixture.expected, stages, assessment: "pending-human-review" });
          }
        } finally { await removeSnapshot(snapshot); }
      } finally { await fs.rm(workspace, { recursive: true, force: true }); }
    }
  } finally {
    process.removeListener("SIGINT", abort); process.removeListener("SIGTERM", abort);
    const usage = emptyUsage();
    const summary: string[] = ["# Prompt comparison", "", `Model: ${config.provider}/${config.model} (${config.thinking})`,
      "Same current schema, tools, metadata, and inspection pipeline; only prompts differ. These are small calibration fixtures, not a representative performance benchmark.",
      "Human assessment is pending: location/word matches are not proof of correct reasoning. Compare real issues found, speculative findings, evidence labels, severity, and missed expected issues. No automatic precision/recall claims.", ""];
    for (const record of records) {
      for (const stage of record.stages) addUsage(usage, stage.usage);
      const verify = record.stages.find(stage => stage.stage === "verify" && stage.status === "done")?.output as VerificationReport | undefined;
      const survivors = new Set(verify?.verdicts.filter(verdict => verdict.status !== "rejected").map(verdict => verdict.candidateId));
      const candidates = candidatesFrom(record.stages);
      const failedStages = record.stages.filter(stage => stage.status === "failed").map(stage => ({ stage: stage.stage, error: stage.error }));
      const complete = record.stages.length === 6 && record.stages.every(stage => stage.status === "done");
      summary.push(`## ${record.caseId} / ${record.variant}`, `Expected: ${record.expected.description}`,
        complete ? "Inspection stages complete; human assessment pending." : "INCOMPLETE — do not treat an empty/unverified result as a clean review.",
        "```json", JSON.stringify({ findings: verify ? candidates.filter(candidate => survivors.has(candidate.id)) : candidates, verification: verify ?? null, failedStages }, null, 2), "```", "");
    }
    const usageScope = "Completed comparison records only; cancelled/in-flight requests can incur additional unreported charges.";
    summary.push(`Aggregate usage: ${JSON.stringify(usage)}`, usageScope, "");
    await fs.writeFile(path.join(output, "results.json"), JSON.stringify({ version: 1, config, promptSets: hashes, cancelled: controller.signal.aborted, records, usage, usageScope }, null, 2), { mode: 0o600 });
    await fs.writeFile(path.join(output, "comparison.md"), summary.join("\n"), { mode: 0o600 });
    console.log(`Saved comparison: ${output}`);
  }
}
