import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as path from "node:path";

import { getAgentDir } from "@mariozechner/pi-coding-agent";

import type { RepoInfo, WorkerJob, WorkerResult, ProposedPR } from "./types";

type SpawnOpts = { signal?: AbortSignal; cwd?: string };

export async function spawnCapture(
  command: string,
  args: string[],
  opts: SpawnOpts = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "", err = "";
    const proc = spawn(command, args, { shell: false, stdio: ["ignore", "pipe", "pipe"], cwd: opts.cwd });
    proc.stdout.on("data", (d: Buffer) => { out += d; });
    proc.stderr.on("data", (d: Buffer) => { err += d; });
    proc.on("close", (code) => code === 0 ? resolve(out) : reject(new Error(`${command} failed: ${err.trim()}`)));
    proc.on("error", reject);
    opts.signal?.addEventListener("abort", () => proc.kill("SIGTERM"), { once: true });
  });
}

/**
 * Match a repo name against a pattern.
 * Supports exact names and glob-style wildcards: * matches any sequence of chars.
 * e.g. "driver-*", "*-go", "adbc-*"
 */
export function matchesRepoPattern(name: string, pattern: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

export function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

export async function ghListRepos(org: string, signal: AbortSignal): Promise<RepoInfo[]> {
  const out = await spawnCapture(
    "gh",
    ["repo", "list", org, "--limit", "100", "--json", "name,defaultBranchRef",
     "--jq", '.[] | [.name, (.defaultBranchRef.name // "main")] | @tsv'],
    { signal },
  );
  return out.trim().split("\n").filter(Boolean).map((line) => {
    const [name, defaultBranch] = line.split("\t");
    return { name, defaultBranch: defaultBranch ?? "main" };
  });
}

export async function repoHasFile(
  org: string,
  repo: string,
  filePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  // Exact path (contains "/"): check directly. Bare filename: search full tree recursively.
  const isExactPath = filePath.includes("/");
  const [apiPath, jq] = isExactPath
    ? [`repos/${org}/${repo}/contents/${filePath}`, ".name"]
    : [
        `repos/${org}/${repo}/git/trees/HEAD?recursive=1`,
        `.tree[] | select(.type == "blob" and (.path | split("/") | last) == "${filePath}") | .path`,
      ];
  try {
    const out = await spawnCapture("gh", ["api", apiPath, "--jq", jq], { signal });
    return out.trim().length > 0;
  } catch {
    return false;
  }
}

export function getWorkerSystemPrompt(): string {
  // Resolve relative to this file's location so it works whether installed
  // globally or run from the project directory.
  const candidates = [
    path.join(
      path.dirname(new URL(import.meta.url).pathname),
      "..",
      "agents",
      "gardener.md",
    ),
    path.join(getAgentDir(), "agents", "gardener.md"),
  ];
  for (const agentFile of candidates) {
    if (fs.existsSync(agentFile)) {
      const raw = fs.readFileSync(agentFile, "utf-8");
      const match = raw.match(/^---\n[\s\S]*?\n---\n([\s\S]*)$/);
      return match ? match[1].trim() : raw.trim();
    }
  }
  throw new Error(
    `gardener.md not found. Checked:\n${candidates.join("\n")}`,
  );
}

function getPiInvocation(args: string[]): { command: string; args: string[] } {
  const script = process.argv[1];
  if (script && fs.existsSync(script)) {
    return { command: process.execPath, args: [script, ...args] };
  }
  return { command: "pi", args };
}

async function writePromptFile(content: string): Promise<string> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "garden-worker-"));
  const file = path.join(dir, "system-prompt.md");
  await fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 });
  return file;
}

export async function runWorker(
  job: WorkerJob,
  systemPrompt: string,
  signal: AbortSignal | undefined,
  onUpdate: (r: WorkerResult) => void,
): Promise<WorkerResult> {
  const result: WorkerResult = {
    repo: job.repo,
    status: "running",
    output: "",
  };
  const promptFile = await writePromptFile(systemPrompt);

  try {
    const jobJson = JSON.stringify(job, null, 2);
    const userMessage = `Here is your job:\n\`\`\`json\n${jobJson}\n\`\`\``;

    const piArgs = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--append-system-prompt", promptFile,
      userMessage,
    ];

    await new Promise<void>((resolve) => {
      const invocation = getPiInvocation(piArgs);
      const proc = spawn(invocation.command, invocation.args, {
        cwd: job.workspace,
        shell: false,
        stdio: ["ignore", "pipe", "pipe"],
      });
      let buffer = "";

      const processLine = (line: string) => {
        if (!line.trim()) return;
        let event: any;
        try { event = JSON.parse(line); } catch { return; }

        // Capture final assistant text from message_end and tool_result_end
        if (
          (event.type === "message_end" || event.type === "tool_result_end") &&
          event.message?.role === "assistant"
        ) {
          for (const part of event.message.content ?? []) {
            if (part.type === "text" && part.text) {
              result.output = part.text;
              onUpdate({ ...result });
            }
          }
        }
      };

      proc.stdout.on("data", (data: Buffer) => {
        buffer += data.toString();
        const lines = buffer.split("\n");
        buffer = lines.pop() ?? "";
        for (const line of lines) processLine(line);
      });
      proc.stderr.on("data", (data: Buffer) => {
        result.notes = (result.notes ?? "") + data.toString();
      });
      proc.on("close", (code) => {
        if (buffer.trim()) processLine(buffer);
        if (code !== 0 && result.status === "running") {
          result.status = "error";
          result.notes = (result.notes ?? "") + `\nProcess exited with code ${code}`;
        }
        resolve();
      });
      proc.on("error", (err: Error) => {
        result.status = "error";
        result.notes = err.message;
        resolve();
      });
      if (signal) {
        const kill = () => {
          proc.kill("SIGTERM");
          setTimeout(() => { if (!proc.killed) proc.kill("SIGKILL"); }, 5000);
        };
        if (signal.aborted) kill();
        else signal.addEventListener("abort", kill, { once: true });
      }
    });

    if (result.status === "running") result.status = "done";
    // Parse any PROPOSED_PR block out of the final output
    result.proposal = parseProposal(result.output, job);
    return result;
  } finally {
    await fs.promises.rm(path.dirname(promptFile), { recursive: true, force: true }).catch(() => {});
    onUpdate({ ...result });
  }
}

export async function mapConcurrent<T, U>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<U>,
): Promise<U[]> {
  const results: U[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    async () => {
      while (true) {
        const i = next++;
        if (i >= items.length) return;
        results[i] = await fn(items[i], i);
      }
    },
  );
  await Promise.all(workers);
  return results;
}

/**
 * Parse a PROPOSED_PR JSON block from worker output.
 * Workers emit a fenced ```json block with a "PROPOSED_PR" marker.
 */
export function parseProposal(output: string, job: WorkerJob): ProposedPR | undefined {
  const match = output.match(/```json\s*PROPOSED_PR\s*([\s\S]*?)```/i);
  if (!match) return undefined;
  try {
    const data = JSON.parse(match[1].trim());
    return {
      repo: job.repo,
      org: job.org,
      defaultBranch: job.defaultBranch,
      branchName: data.branchName ?? "",
      prTitle: data.prTitle ?? "",
      prBody: data.prBody ?? "",
      diffSummary: data.diffSummary ?? "",
    };
  } catch {
    return undefined;
  }
}

// ── Cached checkout helpers ──────────────────────────────────────────────────

const CACHE_UPDATE_INTERVAL_SECS = 300;

function spawnPromise(command: string, args: string[], opts: SpawnOpts = {}): Promise<void> {
  return spawnCapture(command, args, opts).then(() => {});
}

/**
 * Ensure a cached bare-ish checkout exists at
 *   ~/.cache/checkouts/github.com/{org}/{repo}
 *
 * On the first call the repo is cloned with --filter=blob:none.
 * On subsequent calls within CACHE_UPDATE_INTERVAL_SECS the cached copy
 * is returned as-is.  Otherwise the repo is fetched and reset to a clean
 * slate from origin so workers always see a pristine working tree:
 *
 *   git fetch --prune origin
 *   git reset --hard origin/HEAD
 *   git clean -ffd
 *
 * Returns the absolute path to the checkout.  Throws on unrecoverable error
 * (callers should treat a thrown error as "cache unavailable").
 */
export async function ensureCachedCheckout(
  org: string,
  repo: string,
  signal: AbortSignal,
): Promise<string> {
  const cacheRoot = path.join(os.homedir(), ".cache", "checkouts");
  const checkoutPath = path.join(cacheRoot, "github.com", org, repo);
  const originUrl = `https://github.com/${org}/${repo}.git`;
  const gitDir = path.join(checkoutPath, ".git");

  const hasGitDir = await fs.promises
    .access(gitDir)
    .then(() => true)
    .catch(() => false);

  if (!hasGitDir) {
    await fs.promises.mkdir(path.dirname(checkoutPath), { recursive: true });
    await spawnPromise("git", ["clone", "--filter=blob:none", originUrl, checkoutPath], { signal });
    return checkoutPath;
  }

  // Throttled refresh: skip if we fetched recently.
  const lastFetchFile = path.join(gitDir, "librarian-last-fetch");
  const nowEpoch = Math.floor(Date.now() / 1000);
  let needsUpdate = true;

  try {
    const content = await fs.promises.readFile(lastFetchFile, "utf-8");
    const lastEpoch = parseInt(content.trim(), 10);
    if (!isNaN(lastEpoch) && nowEpoch - lastEpoch < CACHE_UPDATE_INTERVAL_SECS) {
      needsUpdate = false;
    }
  } catch {
    // No timestamp file yet — treat as needing update.
  }

  if (needsUpdate) {
    // Fetch latest refs.
    await spawnPromise("git", ["-C", checkoutPath, "fetch", "--prune", "origin"], { signal });
    await fs.promises.writeFile(lastFetchFile, String(nowEpoch), "utf-8");

    // Reset to a clean slate from origin so workers always see a pristine tree.
    await spawnPromise("git", ["-C", checkoutPath, "reset", "--hard", "origin/HEAD"], { signal });
    await spawnPromise("git", ["-C", checkoutPath, "clean", "-ffd"], { signal });
  }

  return checkoutPath;
}

const PROTECTED_BRANCHES = new Set(["main", "master"]);

export async function pushBranch(
  proposal: ProposedPR,
  workspace: string,
  signal: AbortSignal,
): Promise<void> {
  if (PROTECTED_BRANCHES.has(proposal.branchName.trim().toLowerCase())) {
    throw new Error(
      `Refusing to push directly to protected branch "${proposal.branchName}" in ${proposal.org}/${proposal.repo}`,
    );
  }
  const repoPath = path.join(workspace, proposal.repo);
  await spawnPromise(
    "git",
    ["-C", repoPath, "push", `https://github.com/${proposal.org}/${proposal.repo}`, proposal.branchName],
    { signal },
  );
}

export function buildSummaryPrompt(
  task: string,
  results: WorkerResult[],
): string {
  const sections = results.map((r) => {
    const header =
      r.status === "error"
        ? `### ${r.repo} — ERROR\n${r.notes ?? "(no details)"}`
        : `### ${r.repo}\n${r.output || "(no output)"}`;
    return header;
  });
  return [
    `The user asked garden to run this task across ${results.length} git repositories:`,
    ``,
    `> ${task}`,
    ``,
    `Below are the raw outputs from each per-repo worker agent. Please synthesize these into a`,
    `concise, well-formatted summary appropriate to the task. If the task was a question, produce`,
    `a markdown table with one row per repo. If it was a bulk change, summarize what was done,`,
    `what was skipped, and what failed. Use your judgment on the best format.`,
    ``,
    `---`,
    ``,
    ...sections,
  ].join("\n");
}
