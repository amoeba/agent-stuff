import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";

import {
  buildSummaryPrompt,
  getWorkerSystemPrompt,
  ghListRepos,
  mapConcurrent,
  matchesRepoPattern,
  repoHasFile,
  runWorker,
} from "./helpers";

import { MAX_CONCURRENCY } from "./constants";

export async function runGarden(params: {
  org: string;
  task: string;
  /** Exact name, wildcard pattern (e.g. "driver-*"), or undefined for all repos */
  repoFilter?: string;
  fileFilter?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  onResults?: (results: WorkerResult[]) => void;
  /** Called once per repo when a proposal is ready — return true to open the PR */
  onProposal?: (proposal: ProposedPR) => Promise<boolean>;
}): Promise<{ repos: RepoInfo[]; results: WorkerResult[]; summary: string }> {
  const {
    org,
    task,
    repoFilter,
    fileFilter,
    dryRun,
    signal = new AbortController().signal,
  } = params;

  // Discover repos
  params.onProgress?.(`Listing repos in ${org}…`);
  let repos = await ghListRepos(org, signal);

  // Apply repo name filter (exact match or wildcard)
  if (repoFilter?.trim()) {
    repos = repos.filter((r) => matchesRepoPattern(r.name, repoFilter.trim()));
  }

  if (fileFilter?.trim()) {
    params.onProgress?.(`Filtering to repos containing '${fileFilter}'…`);
    const checks = await Promise.all(
      repos.map((r) => repoHasFile(org, r.name, fileFilter.trim(), signal)),
    );
    repos = repos.filter((_, i) => checks[i]);
  }

  if (repos.length === 0)
    return { repos, results: [], summary: "No matching repos found." };

  if (dryRun) {
    const plan = [
      `## 🌱 garden dry-run`,
      ``,
      `**Org:** ${org}`,
      `**Task:** ${task}`,
      repoFilter?.trim() ? `**Repo filter:** \`${repoFilter.trim()}\`` : `**Repo filter:** all repos`,
      fileFilter?.trim()
        ? `**File filter:** \`${fileFilter.trim()}\``
        : `**File filter:** none`,
      ``,
      `### Repos that would be targeted (${repos.length})`,
      ``,
      ...repos.map(
        (r) => `- \`${r.name}\` (default branch: \`${r.defaultBranch}\`)`,
      ),
      ``,
      `_Re-run without \`--dry-run\` to execute._`,
    ].join("\n");
    return { repos, results: [], summary: plan };
  }

  // Create a unique workspace that all subagents share for clones.
  // It is removed in the finally block once the entire run is complete.
  const workspace = await fs.promises.mkdtemp(
    path.join(os.tmpdir(), "garden-"),
  );

  try {
    return await runWithWorkspace({ ...params, org, task, repoFilter, fileFilter, signal, repos, workspace });
  } finally {
    await fs.promises.rm(workspace, { recursive: true, force: true });
  }
}

async function runWithWorkspace(params: {
  org: string;
  task: string;
  repoFilter?: string;
  fileFilter?: string;
  signal: AbortSignal;
  repos: RepoInfo[];
  workspace: string;
  onProgress?: (msg: string) => void;
  onResults?: (results: WorkerResult[]) => void;
  onProposal?: (proposal: ProposedPR) => Promise<boolean>;
}): Promise<{ repos: RepoInfo[]; results: WorkerResult[]; summary: string }> {
  const { org, task, signal, repos, workspace } = params;

  const systemPrompt = getWorkerSystemPrompt();

  // ── Phase 1: propose ────────────────────────────────────────────────────────
  // Each worker clones, applies the change, pushes a branch, and outputs a
  // PROPOSED_PR block. It does NOT open a PR.

  const results: WorkerResult[] = repos.map((r) => ({
    repo: r.name,
    status: "running" as const,
    output: "",
  }));

  await mapConcurrent(repos, MAX_CONCURRENCY, async (repo, i) => {
    const job: WorkerJob = {
      org,
      repo: repo.name,
      defaultBranch: repo.defaultBranch,
      task,
      workspace,
      phase: "propose",
    };
    results[i] = await runWorker(job, systemPrompt, signal, (r) => {
      results[i] = r;
      params.onResults?.([...results]);
    });
    params.onResults?.([...results]);
  });

  // ── PR approval gate ────────────────────────────────────────────────────────
  // For each result that has a proposal, ask the caller whether to open the PR.
  // If approved, open it and run phase 2 (CI monitor) in-process.

  if (params.onProposal) {
    for (let i = 0; i < results.length; i++) {
      const result = results[i];
      if (!result.proposal) continue;

      const approved = await params.onProposal(result.proposal);
      if (!approved) {
        result.notes = "PR not approved by user";
        results[i] = result;
        params.onResults?.([...results]);
        continue;
      }

      // Open the PR
      params.onProgress?.(`Opening PR for ${result.repo}…`);
      const prNumber = await openPR(result.proposal, signal);
      if (prNumber === null) {
        result.status = "error";
        result.notes = "Failed to open PR";
        results[i] = result;
        params.onResults?.([...results]);
        continue;
      }

      // Phase 2: monitor CI in a worker
      result.output += `\n\nPR #${prNumber} opened. Monitoring CI…`;
      result.status = "running";
      results[i] = result;
      params.onResults?.([...results]);

      const monitorJob: WorkerJob = {
        org: result.proposal.org,
        repo: result.proposal.repo,
        defaultBranch: result.proposal.defaultBranch,
        task,
        workspace,
        phase: "monitor",
        prNumber,
        branchName: result.proposal.branchName,
      };

      results[i] = await runWorker(monitorJob, systemPrompt, signal, (r) => {
        results[i] = { ...r, proposal: result.proposal };
        params.onResults?.([...results]);
      });
      results[i].proposal = result.proposal;
      params.onResults?.([...results]);
    }
  }

  const summaryPrompt = buildSummaryPrompt(task, results);
  return { repos, results, summary: summaryPrompt };
}

async function openPR(
  proposal: ProposedPR,
  signal: AbortSignal,
): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [
      "pr", "create",
      "--repo", `${proposal.org}/${proposal.repo}`,
      "--head", proposal.branchName,
      "--base", proposal.defaultBranch,
      "--title", proposal.prTitle,
      "--body", proposal.prBody,
      "--draft",
    ];
    let out = "";
    let err = "";
    const proc = spawn("gh", args, { shell: false, stdio: ["ignore", "pipe", "pipe"] });
    proc.stdout.on("data", (d: Buffer) => { out += d.toString(); });
    proc.stderr.on("data", (d: Buffer) => { err += d.toString(); });
    proc.on("close", (code) => {
      if (code !== 0) { console.error(`gh pr create failed: ${err}`); resolve(null); return; }
      // gh pr create outputs the PR URL; extract number from it
      const match = out.trim().match(/\/pull\/(\d+)/);
      resolve(match ? parseInt(match[1], 10) : null);
    });
    proc.on("error", () => resolve(null));
    signal.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
  });
}
