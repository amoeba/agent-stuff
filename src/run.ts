import * as path from "node:path";
import * as fs from "node:fs";
import * as os from "node:os";

import {
  buildSummaryPrompt,
  getWorkerSystemPrompt,
  ghListRepos,
  mapConcurrent,
  repoHasFile,
  runWorker,
  slugify,
} from "./helpers";

import { MAX_CONCURRENCY } from "./constants";

export async function runGarden(params: {
  org: string;
  task: string;
  fileFilter?: string;
  dryRun?: boolean;
  signal?: AbortSignal;
  onProgress?: (msg: string) => void;
  onResults?: (results: WorkerResult[]) => void;
}): Promise<{ repos: RepoInfo[]; results: WorkerResult[]; summary: string }> {
  const {
    org,
    task,
    fileFilter,
    dryRun,
    signal = new AbortController().signal,
  } = params;

  // Discover repos
  params.onProgress?.(`Listing repos in ${org}…`);
  let repos = await ghListRepos(org, signal);

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
      fileFilter?.trim()
        ? `**File filter:** \`${fileFilter.trim()}\``
        : `**File filter:** none (all repos)`,
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

  // Prepare workspace
  const workspace = path.join(os.tmpdir(), "garden", slugify(task));
  fs.mkdirSync(workspace, { recursive: true });

  const systemPrompt = getWorkerSystemPrompt();

  // Fan out workers
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
    };
    results[i] = await runWorker(job, systemPrompt, signal, (r) => {
      results[i] = r;
      params.onResults?.([...results]);
    });
    params.onResults?.([...results]);
  });

  // Build a synthesis prompt for the LLM to summarize all worker outputs
  const summaryPrompt = buildSummaryPrompt(task, results);

  return { repos, results, summary: summaryPrompt };
}
