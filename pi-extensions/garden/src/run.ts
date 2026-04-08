import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";

import {
  buildSummaryPrompt,
  ensureCachedCheckout,
  getWorkerSystemPrompt,
  ghListRepos,
  mapConcurrent,
  matchesRepoPattern,
  pushBranch,
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
  /** Called with all planned branch pushes; return false to abort before any push happens. */
  onPlansReady?: (plans: ProposedPR[]) => Promise<boolean>;
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
  onPlansReady?: (plans: ProposedPR[]) => Promise<boolean>;
  onProposal?: (proposal: ProposedPR) => Promise<boolean>;
}): Promise<{ repos: RepoInfo[]; results: WorkerResult[]; summary: string }> {
  const { org, task, signal, repos, workspace } = params;

  const systemPrompt = getWorkerSystemPrompt();

  // Pre-populate cached checkouts for all repos before spawning workers.
  // Workers use these for reads and as --reference for clones, saving network
  // round-trips on every run after the first.
  params.onProgress?.(`Fetching cached checkouts for ${repos.length} repos…`);
  const cachedPaths = new Map<string, string>();
  await mapConcurrent(repos, 4, async (repo) => {
    try {
      const p = await ensureCachedCheckout(org, repo.name, signal);
      cachedPaths.set(repo.name, p);
    } catch {
      // Non-fatal — worker will fall back to a network clone.
    }
  });

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
      cachedCheckoutPath: cachedPaths.get(repo.name),
    };
    results[i] = await runWorker(job, systemPrompt, signal, (r) => {
      results[i] = r;
      params.onResults?.([...results]);
    });
    params.onResults?.([...results]);
  });

  // ── Bulk push approval gate ──────────────────────────────────────────────────
  // Workers have committed their branches locally; nothing has been pushed yet.
  // Collect every planned change and, if the caller provided a gate, ask for a
  // single go/no-go before any remote is touched.

  const proposals = results
    .map((r) => r.proposal)
    .filter((p): p is ProposedPR => p != null);

  if (proposals.length > 0) {
    if (params.onPlansReady) {
      const approved = await params.onPlansReady(proposals);
      if (!approved) {
        for (const r of results) {
          if (r.proposal) r.notes = "Push cancelled by user";
        }
        return { repos, results, summary: buildSummaryPrompt(task, results) };
      }
    }

    // Push all branches to the remote now that we have approval.
    params.onProgress?.(`Pushing ${proposals.length} branch${proposals.length === 1 ? "" : "es"}…`);
    await mapConcurrent(proposals, MAX_CONCURRENCY, async (proposal) => {
      const i = results.findIndex((r) => r.repo === proposal.repo);
      try {
        await pushBranch(proposal, workspace, signal);
      } catch (err: any) {
        if (i >= 0) {
          results[i].status = "error";
          results[i].notes = `Push failed: ${err.message}`;
          results[i].proposal = undefined; // exclude from PR gate
          params.onResults?.([...results]);
        }
      }
    });
  }

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
        cachedCheckoutPath: cachedPaths.get(result.proposal.repo),
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
