import type { Usage as ModelUsage } from "@earendil-works/pi-ai";

export const REVIEWERS = ["bug", "test", "impact", "quality"] as const;
export type Reviewer = typeof REVIEWERS[number];
export type Stage = Reviewer | "verify" | "synthesize";
export type Thinking = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";
export interface ReviewConfig { provider: string; model: string; thinking: Thinking }
export type Target =
  | { kind: "branch"; base?: string; includeDirty?: boolean }
  | { kind: "dirty" }
  | { kind: "staged" }
  | { kind: "range"; base: string; head: string }
  | { kind: "pr"; reference: string };
export interface ReviewRequest { target: Target; context: string; exclude: string[]; useFeedback?: boolean }
export type Severity = "critical" | "high" | "medium" | "low";
export type FindingKind = "defect" | "improvement";
export interface ContextMetadata {
  allChangedFiles: string[];
  excludedChangedFiles: string[];
  unavailableChangedFiles: string[];
  unavailableFiles: string[];
  dependencies: { path: string; state: "added" | "modified" | "deleted" | "unavailable"; inDiff: boolean }[];
  toolchains: { manifest: string; declarations: string[] }[];
}
export interface Rebuttal {
  version: 1;
  id: string;
  reviewId: string;
  findingId: string;
  scope: string;
  createdAt: string;
  withdrawnAt?: string;
  file: string;
  changedFile: string;
  title: string;
  explanation: string;
  diffHash: string;
}
export interface Snapshot {
  workspace: string;
  root: string;
  label: string;
  baseRevision: string;
  targetRevision: string;
  diff: string;
  diffHash: string;
  changedFiles: string[];
  files: { base: string[]; target: string[] };
  limitations: string[];
  context: string;
  metadata?: ContextMetadata;
  feedbackScope?: string;
  feedback?: Rebuttal[];
}
export interface Finding {
  id: string;
  title: string;
  severity: Severity;
  kind: FindingKind;
  topic?: "security" | "tests" | "documentation" | "performance" | "design";
  security?: { actor: string; control: string; boundary: string; capability: string; asset: string; introducedRisk: string };
  file: string;
  line: number;
  changedFile: string;
  change: string;
  scenario: string;
  consequence: string;
  evidence: string[];
  assumptions: string[];
  inspected: string[];
  gap: string;
  suggestedTest: string;
  fix: string;
}
export interface ReviewerReport { summary: string; findings: Finding[]; limitations: string[] }
export interface Verdict {
  candidateId: string;
  status: "supported" | "needs-testing" | "rejected";
  reason: string;
  disconfirmation: string;
  severityOverride?: Severity;
  severityReason?: string;
  evidence: string[];
  inspected: string[];
  gap: string;
  suggestedTest: string;
}
export interface VerificationReport { verdicts: Verdict[]; limitations: string[] }
export interface SynthesisReport {
  summary: string;
  groups: { candidateIds: string[]; title: string }[];
  limitations: string[];
}
export interface Usage { input: number; output: number; cacheRead: number; cacheWrite: number; cost: number }
export interface StageResult {
  stage: Stage;
  status: "done" | "failed";
  output?: ReviewerReport | VerificationReport | SynthesisReport;
  error?: string;
  usage: Usage;
  modelUsage?: ModelUsage;
  effectiveThinking?: Thinking;
  calls: { toolCallId?: string; tool: string; args: unknown; completed?: boolean; inspection?: { file: string; revision: "base" | "target"; firstLine: number; lastLine: number }; error?: string }[];
}
export interface ReviewRun {
  version: 1 | 2;
  id: string;
  createdAt: string;
  config: ReviewConfig;
  request: ReviewRequest;
  snapshot: Omit<Snapshot, "workspace" | "files">;
  stages: StageResult[];
  complete: boolean;
  limitations: string[];
  elapsedMs: number;
  usage: Usage;
}
export const emptyModelUsage = (): ModelUsage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } });
export function addModelUsage(total: ModelUsage, usage: ModelUsage): void {
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "totalTokens"] as const) total[key] += usage[key];
  for (const key of ["input", "output", "cacheRead", "cacheWrite", "total"] as const) total.cost[key] += usage.cost[key];
  for (const key of ["cacheWrite1h", "reasoning"] as const) if (usage[key] !== undefined) total[key] = (total[key] ?? 0) + usage[key];
}
export const emptyUsage = (): Usage => ({ input: 0, output: 0, cacheRead: 0, cacheWrite: 0, cost: 0 });
export function addUsage(total: Usage, usage: Usage): void {
  for (const key of Object.keys(total) as (keyof Usage)[]) total[key] += usage[key];
}
