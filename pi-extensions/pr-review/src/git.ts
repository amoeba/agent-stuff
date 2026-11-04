import { spawn } from "node:child_process";

/** No shell, no optional locks, no repository fsmonitor/attributes/hooks or external diff. */
export async function capture(command: string, args: string[], cwd: string, signal?: AbortSignal, maxBytes = 16 * 1024 * 1024): Promise<Buffer> {
  signal?.throwIfAborted();
  return new Promise((resolve, reject) => {
    const env = { ...process.env };
    // Do not let a caller's Git overrides redirect a snapshot or load extra configuration.
    for (const key of Object.keys(env)) if (key.startsWith("GIT_")) delete env[key];
    Object.assign(env, { GIT_CONFIG_NOSYSTEM: "1", GIT_CONFIG_GLOBAL: "/dev/null", GIT_TERMINAL_PROMPT: "0", GIT_NO_LAZY_FETCH: "1" });
    const child = spawn(command, args, { cwd, env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
    const chunks: Buffer[] = [];
    let size = 0, stderr = "", failure: Error | undefined, killTimer: NodeJS.Timeout | undefined;
    const stop = (error: Error) => {
      failure ??= error;
      child.kill("SIGTERM");
      killTimer ??= setTimeout(() => child.kill("SIGKILL"), 2000);
      killTimer.unref();
    };
    const abort = () => stop(new Error("Review cancelled"));
    signal?.addEventListener("abort", abort, { once: true });
    child.stdout.on("data", (chunk: Buffer) => {
      size += chunk.length;
      if (size > maxBytes) stop(new Error(`${command} output exceeds ${maxBytes} bytes; narrow the review`));
      else chunks.push(chunk);
    });
    child.stderr.on("data", chunk => { stderr = (stderr + chunk.toString()).slice(-8192); });
    child.on("error", error => { failure = error; });
    child.on("close", code => {
      signal?.removeEventListener("abort", abort);
      if (killTimer) clearTimeout(killTimer);
      if (failure) reject(failure);
      else if (code !== 0) reject(new Error(`${command} failed (${code}): ${stderr.trim()}`));
      else resolve(Buffer.concat(chunks));
    });
    if (signal?.aborted) abort();
  });
}
export function git(cwd: string, args: string[], signal?: AbortSignal, maxBytes?: number): Promise<Buffer> {
  return capture("git", ["--no-optional-locks", "-c", "core.hooksPath=/dev/null", "-c", "core.fsmonitor=false",
    "-c", "core.attributesFile=/dev/null", ...args], cwd, signal, maxBytes);
}
export async function revision(cwd: string, ref: string, signal?: AbortSignal): Promise<string> {
  if (!ref || ref.startsWith("-") || ref.includes("\0")) throw new Error(`Invalid revision: ${ref}`);
  return (await git(cwd, ["rev-parse", "--verify", "--end-of-options", `${ref}^{commit}`], signal)).toString().trim();
}
export async function defaultBase(cwd: string, signal?: AbortSignal): Promise<string> {
  try { return (await git(cwd, ["symbolic-ref", "refs/remotes/origin/HEAD"], signal)).toString().trim(); }
  catch {
    // Do not guess main/master: either could exist without being the default branch.
    throw new Error("Default branch is not recorded locally. Use --base REF (or set origin/HEAD with git remote set-head origin -a yourself).");
  }
}
export async function mapConcurrent<T, R>(items: T[], concurrency: number, fn: (item: T) => Promise<R>): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  let failure: unknown;
  let failed = false;
  await Promise.all(Array.from({ length: Math.min(concurrency, items.length) }, async () => {
    while (!failed && next < items.length) {
      const i = next++;
      try { results[i] = await fn(items[i]); }
      catch (error) { if (!failed) { failed = true; failure = error; } }
    }
  }));
  if (failed) throw failure;
  return results;
}
