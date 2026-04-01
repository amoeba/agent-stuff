import * as fs from "node:fs";
import * as os from "node:os";
import { spawn } from "node:child_process";
import * as path from "node:path";

import { getAgentDir, withFileMutationQueue } from "@mariozechner/pi-coding-agent";

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

export async function ghListRepos(
  org: string,
  signal: AbortSignal,
): Promise<RepoInfo[]> {
  return new Promise((resolve, reject) => {
    const args = [
      "repo",
      "list",
      org,
      "--limit",
      "100",
      "--json",
      "name,defaultBranchRef",
      "--jq",
      '.[] | [.name, (.defaultBranchRef.name // "main")] | @tsv',
    ];
    let out = "";
    let err = "";
    const proc = spawn("gh", args, {
      shell: false,
      stdio: ["ignore", "pipe", "pipe"],
    });
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.stderr.on("data", (d: Buffer) => {
      err += d.toString();
    });
    proc.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`gh repo list failed: ${err}`));
        return;
      }
      const repos: RepoInfo[] = out
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const [name, defaultBranch] = line.split("\t");
          return { name, defaultBranch: defaultBranch ?? "main" };
        });
      resolve(repos);
    });
    proc.on("error", reject);
    signal.addEventListener("abort", () => proc.kill("SIGTERM"), {
      once: true,
    });
  });
}

export async function repoHasFile(
  org: string,
  repo: string,
  filePath: string,
  signal: AbortSignal,
): Promise<boolean> {
  // filePath may be an exact path like "go/go.mod", or just a filename like "go.mod".
  // For an exact path, check directly. For a bare filename, use the git tree API
  // to search recursively so we find it in any subdirectory (e.g. go/go.mod).
  const isExactPath = filePath.includes("/");

  if (isExactPath) {
    return new Promise((resolve) => {
      const proc = spawn(
        "gh",
        ["api", `repos/${org}/${repo}/contents/${filePath}`, "--jq", ".name"],
        { shell: false, stdio: ["ignore", "pipe", "pipe"] },
      );
      let out = "";
      proc.stdout.on("data", (d: Buffer) => {
        out += d.toString();
      });
      proc.on("close", (code) => {
        resolve(code === 0 && out.trim().length > 0);
      });
      proc.on("error", () => resolve(false));
      signal.addEventListener("abort", () => proc.kill("SIGTERM"), {
        once: true,
      });
    });
  }

  // Bare filename — search the full tree recursively
  return new Promise((resolve) => {
    const proc = spawn(
      "gh",
      [
        "api",
        `repos/${org}/${repo}/git/trees/HEAD?recursive=1`,
        "--jq",
        `.tree[] | select(.type == "blob" and (.path | split("/") | last) == "${filePath}") | .path`,
      ],
      { shell: false, stdio: ["ignore", "pipe", "pipe"] },
    );
    let out = "";
    proc.stdout.on("data", (d: Buffer) => {
      out += d.toString();
    });
    proc.on("close", (code) => {
      resolve(code === 0 && out.trim().length > 0);
    });
    proc.on("error", () => resolve(false));
    signal.addEventListener("abort", () => proc.kill("SIGTERM"), {
      once: true,
    });
  });
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
  const currentScript = process.argv[1];
  if (currentScript && fs.existsSync(currentScript)) {
    return { command: process.execPath, args: [currentScript, ...args] };
  }
  const execName = path.basename(process.execPath).toLowerCase();
  const isGenericRuntime = /^(node|bun)(\.exe)?$/.test(execName);
  if (!isGenericRuntime) {
    return { command: process.execPath, args };
  }
  return { command: "pi", args };
}

async function writePromptFile(content: string): Promise<{ dir: string; file: string }> {
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "garden-"));
  const file = path.join(dir, "system-prompt.md");
  await withFileMutationQueue(file, async () => {
    await fs.promises.writeFile(file, content, { encoding: "utf-8", mode: 0o600 });
  });
  return { dir, file };
}

async function cleanupPromptFile(dir: string, file: string): Promise<void> {
  try { await fs.promises.unlink(file); } catch { /* ignore */ }
  try { await fs.promises.rmdir(dir); } catch { /* ignore */ }
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
  const { dir, file } = await writePromptFile(systemPrompt);

  try {
    const jobJson = JSON.stringify(job, null, 2);
    const userMessage = `Here is your job:\n\`\`\`json\n${jobJson}\n\`\`\``;

    const piArgs = [
      "--mode", "json",
      "-p",
      "--no-session",
      "--append-system-prompt", file,
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
    await cleanupPromptFile(dir, file);
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
