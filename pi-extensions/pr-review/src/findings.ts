import { REVIEWERS, type Finding, type ReviewerReport, type StageResult, type Verdict } from "./types.ts";

export function candidatesFrom(stages: StageResult[]): Finding[] {
  return stages.filter(stage => REVIEWERS.includes(stage.stage as typeof REVIEWERS[number]) && stage.status === "done")
    .flatMap(stage => (stage.output as ReviewerReport).findings.map((finding, index) => ({ ...finding, id: `${stage.stage}-${index + 1}` })));
}
export function effectiveSeverity(finding: Finding, verdict?: Verdict): Finding["severity"] {
  return verdict?.severityOverride ?? finding.severity;
}
