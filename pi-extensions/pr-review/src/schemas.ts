import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import type { Finding, ReviewerReport, Snapshot, SynthesisReport, VerificationReport } from "./types.ts";
import { safeRelative } from "./files.ts";

const text = () => Type.String({ maxLength: 6000 });
const requiredText = () => Type.String({ minLength: 1, pattern: "\\S", maxLength: 6000 });
const texts = () => Type.Array(text(), { maxItems: 40 });
export const findingSchema = Type.Object({
  id: requiredText(), title: requiredText(), severity: StringEnum(["critical", "high", "medium", "low"] as const),
  kind: StringEnum(["defect", "improvement"] as const, { description: "Defect: owned behavior is wrong in a concrete reachable case. Improvement: behavior works but a consequential test/documentation/maintenance change is warranted. Independent of evidence status." }),
  topic: Type.Optional(StringEnum(["security", "tests", "documentation", "performance", "design"] as const)),
  security: Type.Optional(Type.Object({ actor: requiredText(), control: requiredText(), boundary: requiredText(), capability: requiredText(), asset: requiredText(), introducedRisk: requiredText() }, { additionalProperties: false })),
  file: requiredText(), line: Type.Integer({ minimum: 1 }), changedFile: requiredText(),
  change: requiredText(), scenario: requiredText(), consequence: requiredText(), evidence: texts(), assumptions: texts(),
  inspected: texts(), gap: text(), suggestedTest: text(), fix: text(),
}, { additionalProperties: false });
export const reviewerSchema = Type.Object({ summary: text(), findings: Type.Array(findingSchema, { maxItems: 100 }), limitations: texts() }, { additionalProperties: false });
export const verificationSchema = Type.Object({ verdicts: Type.Array(Type.Object({
  candidateId: requiredText(), status: StringEnum(["supported", "needs-testing", "rejected"] as const),
  reason: requiredText(), disconfirmation: requiredText(),
  severityOverride: Type.Optional(StringEnum(["critical", "high", "medium", "low"] as const)),
  severityReason: Type.Optional(requiredText()),
  evidence: texts(), inspected: texts(), gap: text(), suggestedTest: text(),
}, { additionalProperties: false }), { maxItems: 400 }), limitations: texts() }, { additionalProperties: false });
export const synthesisSchema = Type.Object({ summary: text(), groups: Type.Array(Type.Object({ candidateIds: Type.Array(requiredText(), { minItems: 1, maxItems: 400 }), title: requiredText() }, { additionalProperties: false }), { maxItems: 400 }), limitations: texts() }, { additionalProperties: false });

export function validateReviewer(report: ReviewerReport, snapshot: Snapshot): void {
  for (const finding of report.findings) {
    if (!["defect", "improvement"].includes(finding.kind)) throw new Error("Every new finding must distinguish defect from improvement");
    if (finding.topic === "security" && (!finding.security || Object.values(finding.security).some(value => !value.trim())))
      throw new Error("Security findings require actor, control, boundary, capability, asset, and introduced-risk evidence");
    if (!snapshot.changedFiles.includes(finding.changedFile)) throw new Error(`Finding must name a reviewed changedFile: ${finding.changedFile}`);
    if (!safeRelative(finding.file) || ![...snapshot.files.base, ...snapshot.files.target].includes(finding.file))
      throw new Error(`Finding location is not in the snapshot: ${finding.file}`);
    if (!finding.evidence.length && !finding.gap.trim()) throw new Error("A candidate requires evidence or a named evidence gap");
  }
}
export function validateVerification(report: VerificationReport, candidates: Finding[]): void {
  const remaining = new Set(candidates.map(candidate => candidate.id));
  for (const verdict of report.verdicts) {
    if (!remaining.delete(verdict.candidateId)) throw new Error(`Unknown or duplicate candidate: ${verdict.candidateId}`);
    if (!verdict.disconfirmation?.trim()) throw new Error("Every verdict must describe disconfirming checks, including guards, invariants, or contradictory assumptions");
    if (verdict.severityOverride) {
      if (verdict.status === "rejected") throw new Error("Rejected findings cannot receive severity overrides");
      if (!verdict.severityReason?.trim() || !verdict.evidence.some(item => item.trim()))
        throw new Error("Severity corrections require a concrete impact/trigger explanation and evidence");
    } else if (verdict.severityReason) throw new Error("severityReason requires severityOverride");
    if (verdict.status === "supported" && (!verdict.evidence.some(item => item.trim()) || !verdict.inspected.some(item => item.trim())))
      throw new Error("Supported verdicts require evidence and inspected source locations");
    if (verdict.status === "needs-testing" && (!verdict.gap.trim() || !verdict.suggestedTest.trim()))
      throw new Error("Needs-testing verdicts require a specific evidence gap and focused proposed test");
  }
  if (remaining.size) throw new Error(`Verifier omitted candidates: ${[...remaining].join(", ")}`);
}
export function validateSynthesis(report: SynthesisReport, verification: VerificationReport, candidates: Finding[] = []): void {
  const remaining = new Set(verification.verdicts.filter(v => v.status !== "rejected").map(v => v.candidateId));
  const statuses = new Map(verification.verdicts.map(v => [v.candidateId, v.status]));
  const kinds = new Map(candidates.map(finding => [finding.id, finding.kind]));
  for (const group of report.groups) {
    if (new Set(group.candidateIds.map(id => kinds.get(id))).size > 1)
      throw new Error("Do not merge defects and improvements into the same group");
    if (new Set(group.candidateIds.map(id => statuses.get(id))).size > 1)
      throw new Error("Do not merge supported and needs-testing findings into the same group");
    for (const id of group.candidateIds) {
      if (!remaining.delete(id)) throw new Error(`Unknown, rejected, or duplicated synthesis candidate: ${id}`);
    }
  }
  if (remaining.size) throw new Error(`Synthesis omitted surviving candidates: ${[...remaining].join(", ")}`);
}
