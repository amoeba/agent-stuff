import { type ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

import type { WorkerResult } from "./types";
import { runGarden } from "./run";
import { WIDGET_KEY } from "./constants";

const ICONS = { done: "✅", running: "⏳", error: "❌" } as const;

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

      // Dry-run: preview without spawning workers
      if (dryRun) {
        const { repos, summary } = await runGarden({
          org, task, repoFilter, fileFilter, dryRun: true,
          onProgress: (msg) => ctx.ui.setStatus(WIDGET_KEY, msg),
        });
        ctx.ui.setStatus(WIDGET_KEY, "");
        if (repos.length === 0) {
          ctx.ui.notify("No matching repos found.", "warning");
          return;
        }
        ctx.ui.notify(`Dry run: ${repos.length} repos would be targeted`, "info");
        pi.sendMessage({ customType: "garden", content: summary, display: true }, { triggerTurn: false });
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
            const icon = ICONS[r.status];
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
        onPlansReady: async (plans) => {
          ctx.ui.setWidget(WIDGET_KEY, []);
          const rows = plans.map(
            (p) => `| \`${p.repo}\` | \`${p.branchName}\` | ${p.diffSummary.split("\n")[0]} |`,
          );
          const body = [
            `**${plans.length} branch${plans.length === 1 ? "" : "es"} will be pushed to GitHub:**`,
            ``,
            `| Repo | Branch | Change |`,
            `|------|--------|--------|`,
            ...rows,
            ``,
            `Approve to push all branches. You will be asked about each PR individually afterwards.`,
          ].join("\n");
          const approved = await ctx.ui.confirm(
            `Push ${plans.length} branch${plans.length === 1 ? "" : "es"} to GitHub?`,
            body,
          );
          return approved ?? false;
        },
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
