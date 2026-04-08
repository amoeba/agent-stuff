interface RepoInfo {
  name: string;
  defaultBranch: string;
}

interface WorkerJob {
  /** GitHub org/owner */
  org: string;
  repo: string;
  defaultBranch: string;
  /** The full task description passed verbatim to the worker */
  task: string;
  /** Shared scratch directory for clones */
  workspace: string;
  /**
   * Phase 1 (default): clone, apply change, push branch, output PROPOSED_PR block.
   * Phase 2: given an open PR number, monitor CI, fix failures, mark ready.
   */
  phase: "propose" | "monitor";
  /** Phase 2 only — the PR number to monitor */
  prNumber?: number;
  /** Phase 2 only — the branch name already pushed */
  branchName?: string;
  /**
   * Pre-populated cached checkout path: ~/.cache/checkouts/github.com/{org}/{repo}
   * Present when the orchestrator successfully ran ensureCachedCheckout before spawning.
   * Workers should prefer this for reads and as a --reference for clones.
   */
  cachedCheckoutPath?: string;
}

interface ProposedPR {
  repo: string;
  org: string;
  branchName: string;
  defaultBranch: string;
  prTitle: string;
  prBody: string;
  diffSummary: string;
}

interface WorkerResult {
  repo: string;
  status: "done" | "running" | "error";
  /** The worker's final assistant text output */
  output: string;
  /** Parsed proposal, present when phase=propose and a change was found */
  proposal?: ProposedPR;
  notes?: string;
}
