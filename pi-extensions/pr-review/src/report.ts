import * as fs from "node:fs/promises";
import * as path from "node:path";
import { createHash } from "node:crypto";
import { candidatesFrom, effectiveSeverity } from "./findings.ts";
import type { Finding, ReviewerReport, ReviewRun, SynthesisReport, Verdict, VerificationReport } from "./types.ts";

const severityOrder = { critical: 0, high: 1, medium: 2, low: 3 };
// Strip terminal control characters from all rendered, untrusted report text.
export function clean(text: string): string { return text.replace(/[\x00-\x08\x0b-\x1f\x7f-\x9f]/g, ""); }
export function renderReport(run: ReviewRun, expanded = false): string {
  const candidates = candidatesFrom(run.stages);
  const verification = run.stages.find(stage => stage.stage === "verify" && stage.status === "done")?.output as VerificationReport | undefined;
  const synthesis = run.stages.find(stage => stage.stage === "synthesize" && stage.status === "done")?.output as SynthesisReport | undefined;
  const byId = new Map(candidates.map(f => [f.id, f]));
  const verdicts = new Map(verification?.verdicts.map(v => [v.candidateId, v]) ?? []);
  const groups = [...(synthesis?.groups ?? candidates.filter(f => verdicts.get(f.id)?.status !== "rejected")
    .map(f => ({ title: f.title, candidateIds: [f.id] })))];
  const rank = (id: string) => severityOrder[effectiveSeverity(byId.get(id)!, verdicts.get(id))];
  groups.sort((a, b) => Math.min(...a.candidateIds.map(rank)) - Math.min(...b.candidateIds.map(rank)));
  const lines = ["# Multi-agent review", "", `**${run.complete ? "Inspection complete" : "INCOMPLETE REVIEW"}** · ${run.snapshot.label}`,
    `Model: \`${run.config.provider}/${run.config.model}\` · requested thinking: ${run.config.thinking}`,
    `Diff: \`${run.snapshot.diffHash}\` · review ID: \`${run.id}\``, ""];
  if (synthesis?.summary) lines.push(synthesis.summary, "");
  if (run.snapshot.metadata?.toolchains.length) {
    lines.push("## Declared toolchains", "", ...run.snapshot.metadata.toolchains.map(owner => `- \`${owner.manifest}\`: ${owner.declarations.join("; ") || "No version extracted; inspect manifest directly."}`), "");
  }
  if (run.snapshot.feedback?.length) lines.push(`Historical rebuttals considered: ${run.snapshot.feedback.length} (reference evidence, not automatic suppression).`, "");
  const supported = groups.filter(group => group.candidateIds.some(id => verdicts.get(id)?.status === "supported"));
  const needsTesting = groups.filter(group => !supported.includes(group));
  let number = 0;
  function findingBlock(finding: Finding, verdict?: Verdict): string[] {
    const status = verdict?.status === "supported" ? "Supported by inspection — not executed"
      : verdict?.status === "needs-testing" ? "Needs testing" : "Unverified candidate";
    return [
      `**${finding.id} · ${effectiveSeverity(finding, verdict)} · ${finding.kind ?? "unclassified (legacy)"} · ${status}** — \`${finding.file}:${finding.line}\``,
      ...(verdict?.severityOverride ? [`**Severity assessment:** reviewer: ${finding.severity}; verifier: ${verdict.severityOverride}. ${verdict.severityReason}`] : []),
      `**Caused by:** \`${finding.changedFile}\` — ${finding.change}`,
      `**Scenario:** ${finding.scenario}`, `**Consequence:** ${finding.consequence}`,
      `**Evidence:** ${[...new Set([...finding.evidence, ...(verdict?.evidence ?? [])])].join("; ") || "Not established"}`,
      ...(verdict ? [`**Verifier:** ${verdict.reason}`, ...(verdict.disconfirmation ? [`**Disconfirming checks:** ${verdict.disconfirmation}`] : [])] : []),
      ...(finding.security ? [`**Security boundary:** actor: ${finding.security.actor}; controls: ${finding.security.control}; boundary: ${finding.security.boundary}; gains: ${finding.security.capability}; asset: ${finding.security.asset}; changed risk: ${finding.security.introducedRisk}`] : []),
      `**Inspected:** ${[...new Set([...finding.inspected, ...(verdict?.inspected ?? [])])].join("; ") || "Not recorded"}`,
      ...(finding.assumptions.length ? [`**Assumptions:** ${finding.assumptions.join("; ")}`] : []),
      ...((verdict?.gap || finding.gap) ? [`**Evidence gap:** ${verdict?.gap || finding.gap}`] : []),
      ...((verdict?.suggestedTest || finding.suggestedTest) ? [`**Proposed check (not run):** ${verdict?.suggestedTest || finding.suggestedTest}`] : []),
      ...(finding.fix ? [`**Fix direction:** ${finding.fix}`] : []), "",
    ];
  }
  function section(title: string, selected: typeof groups) {
    lines.push(`## ${title}`, "");
    if (!selected.length) {
      lines.push(verification ? "None identified by the completed inspection stages." : "Not established: verification did not complete.", "");
      return;
    }
    for (const group of selected) {
      lines.push(`### ${++number}. ${group.title}`, "");
      for (const id of group.candidateIds) lines.push(...findingBlock(byId.get(id)!, verdicts.get(id)));
    }
  }
  section("Supported findings", supported);
  section(verification ? "Concrete concerns needing testing" : "Unverified candidates (verifier incomplete)", needsTesting);
  const thinkingNotes = run.stages.filter(stage => stage.effectiveThinking && stage.effectiveThinking !== run.config.thinking)
    .map(stage => `${stage.stage}: model capabilities clamped thinking to ${stage.effectiveThinking} (requested ${run.config.thinking}).`);
  const limitations = [...new Set([...run.limitations, ...thinkingNotes, ...run.snapshot.limitations,
    ...run.stages.flatMap(stage => stage.status === "failed" ? [`${stage.stage} failed: ${stage.error}`]
      : (stage.output as ReviewerReport | VerificationReport | SynthesisReport).limitations)])];
  lines.push("## Limitations", "", ...limitations.map(item => `- ${item}`), "",
    `Elapsed: ${(run.elapsedMs / 1000).toFixed(1)}s · input: ${run.usage.input} · output: ${run.usage.output} · cache read/write: ${run.usage.cacheRead}/${run.usage.cacheWrite} · estimated model cost: $${run.usage.cost.toFixed(4)}`, "");
  if (expanded) {
    if (run.snapshot.metadata || run.snapshot.feedback?.length) lines.push("## Snapshot context and rebuttals", "", "```json", JSON.stringify({ metadata: run.snapshot.metadata, feedback: run.snapshot.feedback }, null, 2), "```", "");
    lines.push("## Individual stage reports and tool-call audit", "");
    for (const stage of run.stages) lines.push(`### ${stage.stage} (${stage.status})`, "", "```json", JSON.stringify(stage, null, 2), "```", "");
    const rejected = candidates.filter(f => verdicts.get(f.id)?.status === "rejected");
    if (rejected.length) {
      lines.push("## Rejected candidates", "");
      for (const f of rejected) lines.push(`### ${f.id}: ${f.title}`, `**Rejection:** ${verdicts.get(f.id)!.reason}`, "");
    }
  }
  return clean(lines.join("\n"));
}
export function reportDirectory(agentDir: string, root: string): string {
  const scope = createHash("sha256").update(root).digest("hex").slice(0, 24);
  return path.join(agentDir, "pr-review", "reports", scope);
}
export async function saveReport(agentDir: string, run: ReviewRun): Promise<string> {
  const directory = reportDirectory(agentDir, run.snapshot.root);
  const output = path.join(directory, run.id);
  await fs.mkdir(output, { recursive: true, mode: 0o700 });
  await fs.writeFile(path.join(output, "review.json"), JSON.stringify(run, null, 2), { mode: 0o600 });
  await fs.writeFile(path.join(output, "review.md"), renderReport(run), { mode: 0o600 });
  await fs.writeFile(path.join(output, "details.md"), renderReport(run, true), { mode: 0o600 });
  const temp = path.join(directory, `.last-${run.id}`);
  await fs.writeFile(temp, run.id, { mode: 0o600 });
  await fs.rename(temp, path.join(directory, "last"));
  return output;
}
export async function loadLast(agentDir: string, root: string): Promise<ReviewRun> {
  const directory = reportDirectory(agentDir, root);
  const id = (await fs.readFile(path.join(directory, "last"), "utf8")).trim();
  if (!/^[a-f0-9-]+$/.test(id)) throw new Error("Invalid saved review ID");
  const run = JSON.parse(await fs.readFile(path.join(directory, id, "review.json"), "utf8")) as ReviewRun;
  if (![1, 2].includes(run.version) || run.snapshot.root !== root) throw new Error("Saved report version/scope mismatch");
  return run;
}
