export interface RepoInfo {
  name: string;
  defaultBranch: string;
}

type WorkerJobBase = {
  /** GitHub org/owner */
  org: string;
  repo: string;
  defaultBranch: string;
  /** The full task description passed verbatim to the worker */
  task: string;
  /** Shared scratch directory for clones */
  workspace: string;
  /**
   * Pre-populated cached checkout path: ~/.cache/checkouts/github.com/{org}/{repo}
   * Present when the orchestrator successfully ran ensureCachedCheckout before spawning.
   * Workers should prefer this for reads and as a --reference for clones.
   */
  cachedCheckoutPath?: string;
};

/**
 * Phase 1 (propose): clone, apply change, commit branch locally, output PROPOSED_PR block.
 * Phase 2 (monitor): given an open PR number, monitor CI, fix failures, mark ready.
 */
export type WorkerJob = WorkerJobBase & (
  | { phase: "propose" }
  | { phase: "monitor"; prNumber: number; branchName: string }
);

export interface ProposedPR {
  repo: string;
  org: string;
  branchName: string;
  defaultBranch: string;
  prTitle: string;
  prBody: string;
  diffSummary: string;
}

export interface WorkerResult {
  repo: string;
  status: "done" | "running" | "error";
  /** The worker's final assistant text output */
  output: string;
  /** Parsed proposal, present when phase=propose and a change was found */
  proposal?: ProposedPR;
  notes?: string;
}
