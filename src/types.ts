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
}

interface WorkerResult {
  repo: string;
  status: "done" | "running" | "error";
  /** The worker's final assistant text output */
  output: string;
  notes?: string;
}
