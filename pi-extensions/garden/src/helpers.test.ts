/**
 * Smoke tests for pure helper functions.
 * Run with: node --experimental-strip-types --test pi-extensions/garden/src/helpers.test.ts
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  matchesRepoPattern,
  slugify,
  parseProposal,
  buildSummaryPrompt,
  mapConcurrent,
} from "./helpers.ts";
import type { WorkerJob, WorkerResult } from "./types.ts";

// ── matchesRepoPattern ────────────────────────────────────────────────────────

describe("matchesRepoPattern", () => {
  it("exact match", () => {
    assert.ok(matchesRepoPattern("adbc-driver-go", "adbc-driver-go"));
  });

  it("trailing wildcard", () => {
    assert.ok(matchesRepoPattern("adbc-driver-go", "adbc-driver-*"));
    assert.ok(matchesRepoPattern("adbc-driver-python", "adbc-driver-*"));
  });

  it("leading wildcard", () => {
    assert.ok(matchesRepoPattern("adbc-driver-go", "*-go"));
  });

  it("middle wildcard", () => {
    assert.ok(matchesRepoPattern("adbc-driver-go", "adbc-*-go"));
  });

  it("no match", () => {
    assert.ok(!matchesRepoPattern("adbc-driver-go", "adbc-driver-python"));
    assert.ok(!matchesRepoPattern("adbc-driver-go", "other-*"));
  });

  it("wildcard does not partially match — must cover the full name", () => {
    assert.ok(!matchesRepoPattern("adbc-driver-go-extra", "adbc-driver-go"));
  });
});

// ── slugify ───────────────────────────────────────────────────────────────────

describe("slugify", () => {
  it("lowercases", () => {
    assert.equal(slugify("Hello World"), "hello-world");
  });

  it("replaces spaces and specials with hyphens", () => {
    assert.equal(slugify("foo bar_baz"), "foo-bar-baz");
  });

  it("collapses consecutive non-alphanumeric chars into one hyphen", () => {
    assert.equal(slugify("a  b"), "a-b");
    assert.equal(slugify("a--b"), "a-b");
  });

  it("strips leading and trailing hyphens", () => {
    assert.equal(slugify("  hello  "), "hello");
    assert.equal(slugify("--hello--"), "hello");
  });

  it("truncates to 60 chars", () => {
    const long = "a".repeat(80);
    assert.equal(slugify(long).length, 60);
  });
});

// ── parseProposal ─────────────────────────────────────────────────────────────

const baseJob: WorkerJob = {
  org: "acme",
  repo: "my-repo",
  defaultBranch: "main",
  task: "update go toolchain",
  workspace: "/tmp/garden-test",
  phase: "propose",
};

describe("parseProposal", () => {
  it("parses a valid PROPOSED_PR block", () => {
    const output = `
Some text before.

\`\`\`json PROPOSED_PR
{
  "branchName": "feat/update-go",
  "prTitle": "Update go toolchain",
  "prBody": "Bumped go directive.",
  "diffSummary": "go.mod: go 1.21 → 1.26"
}
\`\`\`

Some text after.
`;
    const result = parseProposal(output, baseJob);
    assert.ok(result, "should return a proposal");
    assert.equal(result!.repo, "my-repo");
    assert.equal(result!.org, "acme");
    assert.equal(result!.branchName, "feat/update-go");
    assert.equal(result!.prTitle, "Update go toolchain");
    assert.equal(result!.diffSummary, "go.mod: go 1.21 → 1.26");
  });

  it("returns undefined when no PROPOSED_PR block is present", () => {
    assert.equal(parseProposal("no proposal here", baseJob), undefined);
  });

  it("returns undefined on malformed JSON", () => {
    const output = "```json PROPOSED_PR\n{ bad json }\n```";
    assert.equal(parseProposal(output, baseJob), undefined);
  });

  it("fills in empty strings for missing fields", () => {
    const output = "```json PROPOSED_PR\n{}\n```";
    const result = parseProposal(output, baseJob);
    assert.ok(result);
    assert.equal(result!.branchName, "");
    assert.equal(result!.prTitle, "");
  });

  it("attaches org/repo/defaultBranch from job, not from JSON", () => {
    const output = `\`\`\`json PROPOSED_PR\n{"branchName":"b","prTitle":"t","prBody":"","diffSummary":""}\n\`\`\``;
    const result = parseProposal(output, { ...baseJob, org: "other-org", repo: "other-repo" });
    assert.equal(result!.org, "other-org");
    assert.equal(result!.repo, "other-repo");
  });
});

// ── buildSummaryPrompt ────────────────────────────────────────────────────────

describe("buildSummaryPrompt", () => {
  it("includes the task in the prompt", () => {
    const prompt = buildSummaryPrompt("What Go version?", []);
    assert.ok(prompt.includes("What Go version?"));
  });

  it("includes repo name and output for done results", () => {
    const results: WorkerResult[] = [
      { repo: "my-repo", status: "done", output: "go 1.21" },
    ];
    const prompt = buildSummaryPrompt("task", results);
    assert.ok(prompt.includes("my-repo"));
    assert.ok(prompt.includes("go 1.21"));
  });

  it("marks error results with ERROR header", () => {
    const results: WorkerResult[] = [
      { repo: "bad-repo", status: "error", output: "", notes: "clone failed" },
    ];
    const prompt = buildSummaryPrompt("task", results);
    assert.ok(prompt.includes("ERROR"));
    assert.ok(prompt.includes("clone failed"));
  });

  it("mentions the repo count", () => {
    const results: WorkerResult[] = [
      { repo: "r1", status: "done", output: "ok" },
      { repo: "r2", status: "done", output: "ok" },
    ];
    const prompt = buildSummaryPrompt("task", results);
    assert.ok(prompt.includes("2"));
  });
});

// ── mapConcurrent ─────────────────────────────────────────────────────────────

describe("mapConcurrent", () => {
  it("maps all items", async () => {
    const results = await mapConcurrent([1, 2, 3], 2, async (x) => x * 2);
    assert.deepEqual(results, [2, 4, 6]);
  });

  it("preserves order regardless of completion order", async () => {
    // Item 0 is slow, items 1-2 are fast — result order must still be 0,1,2.
    const results = await mapConcurrent([100, 1, 1], 3, async (delay, i) => {
      await new Promise((r) => setTimeout(r, delay));
      return i;
    });
    assert.deepEqual(results, [0, 1, 2]);
  });

  it("respects concurrency limit", async () => {
    let active = 0;
    let maxSeen = 0;
    await mapConcurrent([1, 2, 3, 4, 5], 2, async () => {
      active++;
      maxSeen = Math.max(maxSeen, active);
      await new Promise((r) => setTimeout(r, 10));
      active--;
    });
    assert.ok(maxSeen <= 2, `expected max concurrency 2, got ${maxSeen}`);
  });

  it("handles an empty array", async () => {
    const results = await mapConcurrent([], 4, async (x) => x);
    assert.deepEqual(results, []);
  });
});
