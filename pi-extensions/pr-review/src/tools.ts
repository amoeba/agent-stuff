import * as path from "node:path";
import { defineTool } from "@earendil-works/pi-coding-agent";
import { StringEnum } from "@earendil-works/pi-ai";
import { Type } from "typebox";
import { MAX_OUTPUT_BYTES, readSafe, truncate } from "./files.ts";
import type { Snapshot } from "./types.ts";

export function createInspectionTools(snapshot: Snapshot) {
  const manifests = { base: new Set(snapshot.files.base), target: new Set(snapshot.files.target) };
  const revision = Type.Optional(StringEnum(["base", "target"] as const, { description: "Default target; base is available for comparing previous behavior" }));
  async function text(file: string, side: "base" | "target"): Promise<string> {
    const bytes = await readSafe(path.join(snapshot.workspace, side), file, manifests[side]);
    if (bytes.includes(0)) throw new Error(`Binary file cannot be inspected as text: ${file}`);
    return bytes.toString("utf8");
  }
  return [
    defineTool({
      name: "review_read", label: "Read snapshot", description: "Read a repository snapshot file with line numbers. Max 48 KiB per result; paginate using offset/limit. No symlinks, secrets, or arbitrary paths.",
      parameters: Type.Object({ path: Type.String(), revision, offset: Type.Optional(Type.Integer({ minimum: 1 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const lines = (await text(params.path, params.revision ?? "target")).split("\n");
        const start = (params.offset ?? 1) - 1, limit = params.limit ?? 200;
        const rendered = lines.slice(start, start + limit).map((line, i) => `${start + i + 1}: ${line}`);
        const header = `${params.path} (${lines.length} lines)\n`;
        const budget = Math.max(0, MAX_OUTPUT_BYTES - Buffer.byteLength(header) - 150);
        let complete = 0, bytes = 0;
        for (const line of rendered) {
          const size = Buffer.byteLength(line) + (complete ? 1 : 0);
          if (bytes + size > budget) break;
          bytes += size; complete++;
        }
        const body = truncate(rendered.join("\n"), budget);
        return { content: [{ type: "text", text: `${header}${body}${start + limit < lines.length ? "\n[More lines available; use offset.]" : ""}` }],
          details: { inspection: { file: params.path, revision: params.revision ?? "target", firstLine: start + 1, lastLine: start + complete } } };
      },
    }),
    defineTool({
      name: "review_list", label: "List snapshot", description: "List snapshot files by literal path substring, with pagination. Max 48 KiB; entire repository is searchable, not just changed files.",
      parameters: Type.Object({ contains: Type.Optional(Type.String()), revision, offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 1000 })) }),
      async execute(_id, params, signal) {
        signal?.throwIfAborted();
        const files = snapshot.files[params.revision ?? "target"].filter(file => file.includes(params.contains ?? ""));
        const start = params.offset ?? 0, limit = params.limit ?? 200;
        return { content: [{ type: "text", text: truncate(`${files.length} matching files\n${files.slice(start, start + limit).join("\n")}${start + limit < files.length ? "\n[More files; use offset.]" : ""}`) }], details: {} };
      },
    }),
    defineTool({
      name: "review_search", label: "Search snapshot", description: "Search literal text across snapshot files, optionally restricted by a literal path substring. Case-sensitive by default; no regular expressions. Paginate by match offset. Max 48 KiB per result.",
      parameters: Type.Object({ text: Type.String({ minLength: 1 }), pathContains: Type.Optional(Type.String()), revision,
        ignoreCase: Type.Optional(Type.Boolean()), offset: Type.Optional(Type.Integer({ minimum: 0 })), limit: Type.Optional(Type.Integer({ minimum: 1, maximum: 500 })) }),
      async execute(_id, params, signal) {
        const side = params.revision ?? "target", start = params.offset ?? 0, limit = params.limit ?? 100;
        const needle = params.ignoreCase ? params.text.toLowerCase() : params.text;
        const matches: string[] = [];
        let seen = 0, skipped = 0;
        for (const file of snapshot.files[side]) {
          signal?.throwIfAborted();
          if (!file.includes(params.pathContains ?? "")) continue;
          let content: string;
          try { content = await text(file, side); }
          catch (error) {
            if ((error as Error).message.startsWith("Binary file")) { skipped++; continue; }
            throw error;
          }
          for (const [i, line] of content.split("\n").entries()) {
            if (!(params.ignoreCase ? line.toLowerCase() : line).includes(needle)) continue;
            if (seen++ >= start) matches.push(`${file}:${i + 1}: ${line}`);
            if (matches.length >= limit) return { content: [{ type: "text", text: truncate(matches.join("\n") + `\n[Result limit reached; next offset ${seen}, or narrow search. ${skipped} binary files skipped.]`) }], details: {} };
          }
        }
        return { content: [{ type: "text", text: truncate(`${matches.join("\n") || "No matches."}\n[${seen} total matches; ${skipped} binary files skipped.]`) }], details: {} };
      },
    }),
  ];
}
