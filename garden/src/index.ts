import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import { ghListRepos, repoHasFile, matchesRepoPattern, getWorkerSystemPrompt } from "./helpers";
import { runGarden } from "./run";
import { WIDGET_KEY } from "./constants";

export default function (pi: ExtensionAPI) {
  // ── /garden command ────────────────────────────────────────────────────────
  pi.registerCommand("garden", {
    description:
      "Run any task across all repos in a GitHub org using parallel subagents. " +
      "Pass --dry-run to preview without executing.",
    handler: async (args, ctx) => {
      // Parse flags: --org=<name>  --repo=<pattern>  --dry-run
      const dryRun = /--dry-run\b/.test(args ?? "");
      let cleanArgs = (args ?? "").replace(/--dry-run\b/, "").trim();
      ctx.ui.notify(
        dryRun ? "🌱 garden: dry-run" : "🌱 garden: starting…",
        "info",
      );

      const orgMatch = /--org[= ](\S+)/.exec(cleanArgs);
      if (orgMatch) cleanArgs = cleanArgs.replace(orgMatch[0], "").trim();
      const org = orgMatch?.[1] ?? "adbc-drivers";

      const repoMatch = /--repo[= ](\S+)/.exec(cleanArgs);
      if (repoMatch) cleanArgs = cleanArgs.replace(repoMatch[0], "").trim();
      const repoFilter = repoMatch?.[1];

      const fileFilterMatch = /--file-filter[= ](\S+)/.exec(cleanArgs);
      if (fileFilterMatch) cleanArgs = cleanArgs.replace(fileFilterMatch[0], "").trim();
      const fileFilter = fileFilterMatch?.[1] ?? "";

      const task =
        cleanArgs ||
        (await ctx.ui.input(
          "Task",
          "What should each repo's worker agent do? e.g. 'What Go version is used?' or 'Update go toolchain to 1.26'",
        ));
      if (task == null || task === "") {
        ctx.ui.notify("Cancelled — no task specified.", "warning");
        return;
      }

      // List repos for confirm / dry-run preview
      ctx.ui.setStatus(WIDGET_KEY, `Listing ${org} repos…`);
      let previewRepos: RepoInfo[];
      try {
        previewRepos = await ghListRepos(org, new AbortController().signal);
        if (repoFilter?.trim()) {
          previewRepos = previewRepos.filter((r) =>
            matchesRepoPattern(r.name, repoFilter.trim())
          );
        }
        if (fileFilter.trim()) {
          const checks = await Promise.all(
            previewRepos.map((r) =>
              repoHasFile(
                org,
                r.name,
                fileFilter.trim(),
                new AbortController().signal,
              ),
            ),
          );
          previewRepos = previewRepos.filter((_, i) => checks[i]);
        }
      } catch (e: any) {
        ctx.ui.notify(`Failed to list repos: ${e.message}`, "error");
        ctx.ui.setStatus(WIDGET_KEY, "");
        return;
      }

      if (previewRepos.length === 0) {
        ctx.ui.notify("No matching repos found.", "warning");
        ctx.ui.setStatus(WIDGET_KEY, "");
        return;
      }

      ctx.ui.setStatus(WIDGET_KEY, "");

      // Dry-run: show plan immediately without spawning workers
      if (dryRun) {
        const plan = [
          `## 🌱 garden dry-run`,
          ``,
          `**Org:** ${org}`,
          `**Task:** ${task}`,
          fileFilter.trim()
            ? `**File filter:** \`${fileFilter.trim()}\``
            : `**File filter:** none (all repos)`,
          ``,
          `### Repos that would be targeted (${previewRepos.length})`,
          ``,
          ...previewRepos.map(
            (r) => `- \`${r.name}\` (default branch: \`${r.defaultBranch}\`)`,
          ),
          ``,
          `_Re-run without \`--dry-run\` to execute._`,
        ].join("\n");
        ctx.ui.notify(
          `Dry run: ${previewRepos.length} repos would be targeted`,
          "info",
        );
        pi.sendMessage(
          { customType: "garden", content: plan, display: true },
          { triggerTurn: false },
        );
        return;
      }

      let systemPrompt: string;
      try {
        systemPrompt = getWorkerSystemPrompt();
      } catch (e: any) {
        ctx.ui.notify(e.message, "error");
        return;
      }

      // Live progress widget
      const renderWidget = (results: WorkerResult[]) => {
        const running = results.filter((r) => r.status === "running").length;
        const done = results.filter((r) => r.status === "done").length;
        const errors = results.filter((r) => r.status === "error").length;
        ctx.ui.setWidget(WIDGET_KEY, [
          `🌱 garden  ${done} done, ${running} running${errors > 0 ? `, ${errors} errors` : ""}`,
          ...results.map((r) => {
            const icon = { done: "✅", running: "⏳", error: "❌" }[r.status];
            const snippet = r.output
              ? "  " + r.output.trim().split("\n")[0].slice(0, 72)
              : r.status === "running"
                ? "  working…"
                : "";
            return `  ${icon} ${r.repo}${snippet ? `\n${snippet}` : ""}`;
          }),
        ]);
      };

      const { results, summary } = await runGarden({
        org,
        task,
        repoFilter: repoFilter || undefined,
        fileFilter: fileFilter || undefined,
        dryRun: false,
        onProgress: (msg) => ctx.ui.setStatus(WIDGET_KEY, msg),
        onResults: renderWidget,
        onProposal: async (proposal) => {
          // Pause the widget while we show the confirm dialog
          ctx.ui.setWidget(WIDGET_KEY, []);
          const approved = await ctx.ui.confirm(
            `Open PR for ${proposal.org}/${proposal.repo}?`,
            [
              `**Branch:** \`${proposal.branchName}\``,
              `**Title:** ${proposal.prTitle}`,
              ``,
              `**Changes:**`,
              proposal.diffSummary,
              ``,
              `**PR body:**`,
              proposal.prBody,
            ].join("\n"),
          );
          return approved ?? false;
        },
      });

      ctx.ui.setStatus(WIDGET_KEY, "");
      ctx.ui.setWidget(WIDGET_KEY, []);

      const errors = results.filter((r) => r.status === "error").length;
      ctx.ui.notify(
        `Done: ${results.length} repos processed${errors > 0 ? `, ${errors} errors` : ""}`,
        errors > 0 ? "warning" : undefined,
      );

      // Ask the LLM to synthesize the worker outputs into a summary
      pi.sendMessage(
        { customType: "garden", content: summary, display: false },
        { triggerTurn: true },
      );
    },
  });

  // ── garden tool (LLM-callable) ─────────────────────────────────────────────
  pi.registerTool({
    name: "garden",
    label: "Garden",
    description:
      "Run any task across all (or filtered) repositories in a GitHub org using parallel subagents. " +
      "Each subagent receives the task and the repo context, then acts autonomously — it might answer a " +
      "question, inspect files, apply a code change, open a PR, or anything else. " +
      "Use this for cross-repo queries ('what Go version does each repo use?'), bulk changes " +
      "('update go toolchain to 1.26 in all repos'), or any per-repo investigation.",
    parameters: Type.Object({
      org: Type.String({
        description:
          "GitHub org to target. Defaults to 'adbc-drivers' if not specified.",
        default: "adbc-drivers",
      }),
      task: Type.String({
        description:
          "The task to run in each repo. Be specific — the worker agent sees only this text and the " +
          "repo's name and default branch. Examples: " +
          "'What Go version is declared in go.mod?', " +
          "'Update the go toolchain directive in go.mod to go1.26, open a draft PR, and get CI green.'",
      }),
      repo: Type.Optional(
        Type.String({
          description:
            "Target a specific repo or wildcard pattern, e.g. 'adbc-driver-go' or 'adbc-driver-*'. Omit for all repos.",
        }),
      ),
      fileFilter: Type.Optional(
        Type.String({
          description:
            "Only target repos containing this file path, e.g. 'go.mod'. Omit for all repos.",
        }),
      ),
      dryRun: Type.Optional(
        Type.Boolean({
          description:
            "If true, list repos and show the plan but do not spawn any workers.",
          default: false,
        }),
      ),
    }),

    async execute(_id, params, signal, onUpdate) {
      onUpdate?.({
        content: [
          { type: "text", text: `🌱 garden starting for org: ${params.org}…` },
        ],
        details: {},
      });

      const { repos, results, summary } = await runGarden({
        org: params.org,
        task: params.task,
        repoFilter: params.repo,
        fileFilter: params.fileFilter,
        dryRun: params.dryRun ?? false,
        signal,
        onProgress: (msg) =>
          onUpdate?.({ content: [{ type: "text", text: msg }], details: {} }),
        onResults: (r) => {
          const running = r.filter((x) => x.status === "running").length;
          const done = r.filter((x) => x.status === "done").length;
          onUpdate?.({
            content: [
              {
                type: "text",
                text: `Progress: ${done}/${r.length} done, ${running} running…`,
              },
            ],
            details: { results: r },
          });
        },
      });

      return {
        content: [{ type: "text", text: summary }],
        details: { repos, results },
      };
    },
  });
}
