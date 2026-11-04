import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import * as path from "node:path";

export const MAX_FILE_BYTES = 2 * 1024 * 1024;
export const MAX_SNAPSHOT_BYTES = 128 * 1024 * 1024;
export const MAX_OUTPUT_BYTES = 48 * 1024;

/** Defense in depth, not a general secret detector. Applied to snapshots AND diffs. */
export function blockedPath(file: string): boolean {
  const parts = file.replaceAll("\\", "/").split("/");
  if (parts.some(p => [".git", "node_modules", ".venv", "vendor", ".ssh", ".aws"].includes(p.toLowerCase()))) return true;
  const name = parts.at(-1)!.toLowerCase();
  return name === ".env" || name.startsWith(".env.") || name === ".npmrc" || name === ".netrc"
    || /\.(pem|key|p12|pfx)$/.test(name) || /^(id_rsa|id_ed25519|credentials(?:\.json)?)$/.test(name);
}
export function safeRelative(file: string): boolean {
  return !!file && !file.includes("\0") && !file.includes("\\") && !path.isAbsolute(file)
    && file.split("/").every(p => p !== ".." && p !== "." && p !== "");
}
export function within(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === "" || (!relative.startsWith(`..${path.sep}`) && relative !== ".." && !path.isAbsolute(relative));
}

/** Manifest allowlist + realpath check + O_NOFOLLOW; never accept arbitrary filesystem paths. */
export async function readSafe(root: string, file: string, allowed: Set<string>): Promise<Buffer> {
  if (!safeRelative(file) || blockedPath(file) || !allowed.has(file)) throw new Error(`Access denied: ${file}`);
  const realRoot = await fs.realpath(root);
  const resolved = path.resolve(root, file);
  if (!within(realRoot, await fs.realpath(resolved))) throw new Error(`Symlink escapes snapshot: ${file}`);
  // Reject even internal symlinks, including directory aliases.
  let current = realRoot;
  for (const part of file.split("/")) {
    current = path.join(current, part);
    if ((await fs.lstat(current)).isSymbolicLink()) throw new Error(`Symlink access denied: ${file}`);
  }
  const handle = await fs.open(resolved, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat();
    if (!before.isFile()) throw new Error(`Not a regular file: ${file}`);
    if (before.size > MAX_FILE_BYTES) throw new Error(`File exceeds ${MAX_FILE_BYTES} bytes: ${file}`);
    const data = await handle.readFile();
    const after = await handle.stat();
    if (before.size !== after.size || before.mtimeMs !== after.mtimeMs || before.ctimeMs !== after.ctimeMs)
      throw new Error(`File changed during capture: ${file}`);
    return data;
  } finally { await handle.close(); }
}

export function truncate(text: string, maxBytes = MAX_OUTPUT_BYTES, notice = "[Output truncated; narrow the search or read another line range.]"): string {
  const bytes = Buffer.from(text);
  if (bytes.length <= maxBytes) return text;
  // Decode a complete UTF-8 prefix.
  let end = maxBytes;
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end--;
  return `${bytes.subarray(0, end).toString()}\n${notice}`;
}
export function excluded(file: string, patterns: string[]): boolean {
  return patterns.some(pattern => path.matchesGlob(file, pattern));
}
