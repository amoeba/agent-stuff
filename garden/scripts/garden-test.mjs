#!/usr/bin/env -S node --input-type=module
/**
 * garden-test.mjs
 *
 * Smoke-tests the phase 1 → approval → phase 2 flow without touching GitHub.
 *
 * It stubs out `ghListRepos`, `repoHasFile`, and the worker subprocess so that:
 *   - Phase 1 immediately returns a fake PROPOSED_PR block
 *   - The approval prompt fires (you interact with it)
 *   - Phase 2 immediately returns a fake CI success message
 *
 * Run with:
 *   node scripts/garden-test.mjs
 *
 * You will be asked interactively whether to open the fake PR.
 * No GitHub API calls are made and no real files are changed.
 */

import * as readline from "node:readline";

// ── Wildcard matching (mirrors helpers.ts matchesRepoPattern) ─────────────

function matchesRepoPattern(name, pattern) {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*");
  return new RegExp(`^${escaped}$`).test(name);
}

// ── Minimal stubs ──────────────────────────────────────────────────────────

const allFakeRepos = [
  { name: "fake-driver-go", defaultBranch: "main" },
  { name: "fake-driver-rust", defaultBranch: "main" },
  { name: "fake-driver-java", defaultBranch: "main" },
  { name: "fake-utils", defaultBranch: "main" },
];

// Fake worker: returns a PROPOSED_PR block for phase=propose, CI success for phase=monitor
function fakeWorkerOutput(job) {
  if (job.phase === "propose") {
    return [
      `Checked \`${job.workspace}/${job.repo}/go/go.mod\` — toolchain was \`go1.23.4\`, updated to \`go1.26\`.`,
      ``,
      "```json PROPOSED_PR",
      JSON.stringify({
        branchName: "chore/go-toolchain-1.26",
        prTitle: `chore(go): bump to go1.26`,
        prBody: `Updates the Go toolchain directive in \`go/go.mod\` to go1.26.\n\nAutomated via garden.`,
        diffSummary: `go/go.mod: \`toolchain go1.23.4\` → \`toolchain go1.26\``,
      }, null, 2),
      "```",
    ].join("\n");
  }

  if (job.phase === "monitor") {
    return `PR #${job.prNumber} — all CI checks passed ✅. Marked ready for review.`;
  }

  return "(no output)";
}

// ── Inline approval prompt (simulates ctx.ui.confirm) ─────────────────────

async function confirm(title, body) {
  console.log(`\n${"─".repeat(60)}`);
  console.log(`❓ ${title}`);
  console.log(`${"─".repeat(60)}`);
  console.log(body);
  console.log(`${"─".repeat(60)}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question("Approve? [y/N] ", (ans) => {
      rl.close();
      resolve(ans.trim().toLowerCase() === "y");
    });
  });
}

// ── Fake openPR ────────────────────────────────────────────────────────────

let fakePrCounter = 100;
async function fakeOpenPR(proposal) {
  const n = ++fakePrCounter;
  console.log(`\n  [test] would run: gh pr create --repo fake-org/${proposal.repo} --head ${proposal.branchName} --draft`);
  console.log(`  [test] fake PR #${n} opened: https://github.com/fake-org/${proposal.repo}/pull/${n}`);
  return n;
}

// ── Fake parseProposal ─────────────────────────────────────────────────────

function parseProposal(output, job) {
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

// ── Main test run ──────────────────────────────────────────────────────────

async function run() {
  // Parse CLI args: node garden-test.mjs [--repo=<pattern>] [--org=<org>]
  const repoArg = process.argv.find(a => a.startsWith("--repo="))?.slice(7);
  const orgArg  = process.argv.find(a => a.startsWith("--org="))?.slice(6) ?? "fake-org";

  const org = orgArg;
  const task = "Update go toolchain to go1.26";
  const workspace = "/tmp/garden-test-stub";

  // Apply repo filter
  const fakeRepos = repoArg
    ? allFakeRepos.filter(r => matchesRepoPattern(r.name, repoArg))
    : allFakeRepos;

  console.log(`\n🌱 garden test run`);
  console.log(`   org: ${org}   task: ${task}`);
  if (repoArg) console.log(`   repo filter: ${repoArg}`);
  console.log(`   repos: ${fakeRepos.map(r => r.name).join(", ") || "(none matched)"}\n`);

  if (fakeRepos.length === 0) {
    console.log("No repos matched the filter. Exiting.");
    return;
  }

  // ── Phase 1: propose ──
  console.log("── Phase 1: propose ──────────────────────────────────────");
  const results = [];
  for (const repo of fakeRepos) {
    const job = { org, repo: repo.name, defaultBranch: repo.defaultBranch, task, workspace, phase: "propose" };
    const output = fakeWorkerOutput(job);
    const proposal = parseProposal(output, job);
    const result = { repo: repo.name, status: "done", output, proposal };
    results.push(result);
    console.log(`  ✅ ${repo.name}: proposal ready`);
    if (proposal) console.log(`     branch: ${proposal.branchName}  title: ${proposal.prTitle}`);
  }

  // ── Approval gate ──
  console.log("\n── Approval gate ─────────────────────────────────────────");
  for (const result of results) {
    if (!result.proposal) continue;

    const approved = await confirm(
      `Open PR for ${result.repo}?`,
      [
        `Branch:  ${result.proposal.branchName}`,
        `Title:   ${result.proposal.prTitle}`,
        ``,
        `Changes: ${result.proposal.diffSummary}`,
        ``,
        `PR body:`,
        result.proposal.prBody,
      ].join("\n"),
    );

    if (!approved) {
      result.notes = "PR not approved by user";
      console.log(`  ⏭  ${result.repo}: skipped`);
      continue;
    }

    // Open the PR
    const prNumber = await fakeOpenPR(result.proposal);

    // ── Phase 2: monitor ──
    console.log(`\n── Phase 2: monitor (${result.repo} PR #${prNumber}) ──────────`);
    const monitorJob = {
      org,
      repo: result.repo,
      defaultBranch: result.proposal.defaultBranch,
      task,
      workspace,
      phase: "monitor",
      prNumber,
      branchName: result.proposal.branchName,
    };
    const monitorOutput = fakeWorkerOutput(monitorJob);
    result.output += `\n\n${monitorOutput}`;
    result.status = "done";
    console.log(`  ✅ ${result.repo}: ${monitorOutput}`);
  }

  console.log(`\n${"─".repeat(60)}`);
  console.log("🌱 garden test complete\n");
  for (const r of results) {
    const icon = r.notes ? "⏭ " : "✅";
    console.log(`  ${icon} ${r.repo}${r.notes ? " — " + r.notes : ""}`);
  }
  console.log("");
}

run().catch((e) => { console.error(e); process.exit(1); });
