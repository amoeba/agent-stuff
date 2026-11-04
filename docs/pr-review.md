# Inspection-only multi-agent review

`pi-extensions/pr-review/src/index.ts` adds `/pr-review` and the explicitly invoked `review_changes` tool. `skills/pr-review/SKILL.md` provides companion guidance. This is an independent review pipeline, not four personas in one context or an agent debate.

## Setup

Requires macOS/Linux, Node.js 22.13+ (including `path.matchesGlob`), Git, and pi 0.84.3+ from `@earendil-works`. GitHub reviews also require an authenticated `gh` CLI for private repositories. Model authentication comes from the active pi provider configuration; it is never stored in review configuration or reports.

From this package:

```sh
pi install /absolute/path/to/agent-stuff
# Restart pi or /reload as applicable.
```

For a one-session trial:

```sh
pi -e /absolute/path/to/agent-stuff/pi-extensions/pr-review/src/index.ts
```

Configure once before reviewing:

```text
/pr-review config
/pr-review config PROVIDER/MODEL high
```

The picker can pin your currently active model, but reviews do **not** silently follow later `/model` changes. The same pinned model/thinking is used for all four reviewers, verification, and synthesis. Configuration lives at `<pi-agent-dir>/pr-review/config.json`. The extension does not read repository-local review configuration or auto-install dependencies.

The existing `garden` extension still uses its original pi imports; it has not been migrated. The package now declares the new review extension's pi packages as peers, with matching development dependencies for tests.

## Usage

```text
/pr-review                         # target picker
/pr-review branch                  # default branch merge-base → HEAD
/pr-review branch --base origin/main
/pr-review branch --include-dirty
/pr-review dirty                   # HEAD → staged + unstaged + untracked
/pr-review staged                  # HEAD → index
/pr-review range HEAD~3 HEAD        # exact tree comparison
/pr-review range origin/main...HEAD # merge-base comparison
/pr-review pr owner/repo#123
/pr-review pr https://github.com/owner/repo/pull/123
/pr-review dirty --context "The API must remain backward compatible" --exclude "**/*.lock"
/pr-review help
/pr-review last
/pr-review details
/pr-review rebut bug-1 "The caller validates this before entering the changed function."
/pr-review rebuttals
/pr-review forget REBUTTAL_ID
/pr-review dirty --no-feedback
/pr-review cancel
```

No-argument invocation requires interactive UI. In non-interactive mode configure the model beforehand and pass an explicit local target, for example:

```sh
pi -p '/pr-review dirty'
```

Local non-interactive reviews run without dialogs; the explicit invocation supplies the target. PR retrieval currently requires interactive approval. RPC supports ordinary dialogs and `/pr-review cancel`; the progress overlay is TUI-only. Escape cancels a TUI review; cleanup waits for all reviewer sessions to stop.

The locally recorded default branch is `refs/remotes/origin/HEAD`. If missing, use `--base`; the extension does not guess `main` versus `master` or fetch remote branches behind your back. Local comparisons use already available Git objects. Partial clones with missing objects must be hydrated separately (lazy fetching is disabled).

Exclusion patterns use Node's `path.matchesGlob`. They affect review scope, not safe read/search context. Branch and range reviews ignore unrelated dirty work. Dirty mode excludes ignored untracked files but includes tracked ignored files. Dirty and staged reviews also support an unborn branch (empty baseline). Snapshot capture rejects index conflicts for staged reviews and detects ordinary edits/index changes during dirty capture; review while other writers are idle.

## Pipeline

1. Resolve actual revisions and capture matching base/target snapshots into a disposable directory.
2. Show the resolved comparison, changed-file preview, model, and limitations for approval in interactive mode.
3. Run Bug Hunter, Test Reviewer, Impact Analyzer, and Code Quality concurrently, each with a fresh session and only snapshot inspection tools.
4. Run a skeptical verifier with the same inspection tools. It must provide exactly one verdict per candidate, and supported findings require a completed independent read that includes the cited line in full (enforced in code; unrelated ranges and partially truncated lines do not qualify). Single-reviewer findings can survive: evidence, not votes, determines status.
5. Synthesize a short summary and duplicate groups. The synthesizer has only a structured submission tool, cannot introduce findings, and must preserve every surviving candidate.
6. Render severity-ranked findings and limitations, save reports, and delete the snapshots.

Reviewer prompts are editable under `pi-extensions/pr-review/agents/`. They actively investigate the codebase when needed, including unchanged callers and coordinated updates. Findings must identify a causal changed file. Project guidance is read as convention evidence from the snapshot (root/relevant nested `AGENTS.md`, `CLAUDE.md`, or `AGENTS.override.md`); the implementation conversation and global context files are not automatically inherited. Supply intent explicitly with `--context`.

## Review discipline

The four roles now explicitly check removed invariants, reachable triggers and disconfirming guards, version-specific claims, meaningful test value, and concrete security boundaries. Deleted behavior must have a missing required guarantee, not merely fewer lines. Version-dependent claims use owning target manifests/lockfiles and available definitions/contracts rather than stale model memory. Missing definitions are limits, not proof that an API does not exist. Quality/convention findings cite an applicable rule or comparable code and a concrete alternative.

The Test Reviewer checks observable owned behavior and a realistic mistake an assertion would detect. It challenges self-confirming assertions, permissive fakes that bypass a regression, and unsupported duplication/impossibility claims. It also evaluates actual coverage gaps; this is not a test-deletion campaign. Additional test levels need a distinct uncovered failure.

Security candidates use a structured attacker/control/boundary/capability/asset/introduced-risk explanation. There are no blanket bans on DoS, test-only issues, or prompt injection when a real changed security outcome is evident. The verifier records disconfirming checks, checks incompatible candidate assumptions, and can correct severity with an impact/trigger explanation and evidence. The original severity and claim remain in the report/audit; a wrong core claim is rejected, not rewritten into another issue.

Snapshot context includes owning-module toolchain declarations and a dependency-metadata inventory, including available changed lockfiles excluded from the diff. Declarations/ranges do not prove effective deployment versions or API semantics. Unavailable metadata is not an absent file, and a manifest edit does not automatically require a lock/checksum edit. Oversized dirty files have availability records but no invented claim that their contents changed. No dependency loading, installation, or network lookup is added.

## Evidence and completeness

- **Supported by inspection:** code/contract evidence supports the issue; it has not been reproduced.
- **Needs testing:** a concrete scenario exists, but a named assumption/evidence gap requires a focused proposed test.
- **Rejected:** contradicted, out of scope, or insufficiently supported; available in expanded details.
- **Unverified candidate:** verifier failed; never promoted to a supported finding.

Each finding independently labels **defect** (owned behavior is wrong in a concrete case) or **improvement** (working behavior warrants a consequential coverage/documentation/maintenance change). Supported missing coverage is not a demonstrated production bug. Synthesis cannot merge defects and improvements or different evidence statuses. New reports use format version 2; version-1 reports remain readable, with missing kinds shown as unclassified rather than guessed.

Evidence, original qualifications, assumptions, inspected locations, and proposed checks are preserved rather than rewritten by the summarizer. Verified severity corrections determine ordering and are displayed beside the original rating. Rejected candidates are excluded from its groups. A source read and structured output checks establish provenance, not a mechanical proof that a model's reasoning is correct. No merge verdict, filler praise, automatic edits, or automatic GitHub comments.

Failed stages are explicit, and the report is marked incomplete. A synthesis failure falls back to individually rendered verified candidates. A verifier failure prevents synthesis and displays only unverified candidates. Context preflight and provider overflow errors are explicit: the diff and candidate reports are never silently truncated. Read/search tool results are bounded and tell the agent to paginate/narrow the query. There is no review-duration target or arbitrary tool-call quota; cancellation remains available.

The tool reports nested model usage to pi's session totals; slash-command reviews show their own usage summary. Model capability clamps on the requested thinking level are recorded per stage and surfaced as limitations. Final reports are bounded when inserted into parent-model context, with explicit notices; the full human-visible report and saved artifacts remain available.

## Inspection boundary

Agents have exactly `review_read`, `review_search`, `review_list`, and `submit_review`. The synthesizer has only `submit_review`. No bash, edits, writes, network, or test tools are exposed. Reviewer sessions use a custom resource loader that bypasses all extension, package, skill, prompt, context-file, and project-settings discovery.

The trusted extension itself runs narrowly defined Git commands to capture objects and build a synthetic diff using a temporary index. It does not mutate the original checkout/index. Git fsmonitor/hooks, global/system configuration, external diff, textconv, lazy fetching, and repository clean/process/checkout/smudge filters are avoided. Dirty capture uses raw file reads and file/index/ref fingerprints, not worktree `git diff` or `git status`, which can invoke clean filters. GitHub retrieval uses `gh api` and a shallow fetch into a temporary bare repository, with an explicit `gh auth git-credential` helper. PR metadata and fetched head identity must agree. No repository checkout or project scripts run.

Snapshots omit:

- Symlinks and submodules (no traversal into either).
- Common sensitive paths (`.env*`, credential/key files, `.npmrc`, `.netrc`, `.ssh`, `.aws`).
- Dependency trees (`node_modules`, `.venv`, `vendor`) and `.git` metadata.
- Files over 2 MiB; whole-source snapshot cap is 128 MiB.

Omissions are stated in the report and apply to both revisions of the diff as well as context, so an omitted file/subtree cannot masquerade as a source deletion or addition. Binary contents are not searched as text; Git can show binary-change notices. File-mode changes and empty-file additions/deletions are retained. Normal text files and executable bits are copied, but never executed. Filesystem tools use manifests, realpath checks, reject symlink components, and open regular files with `O_NOFOLLOW`.

**This is not an OS sandbox or a complete secret detector.** A secret embedded in an otherwise allowed source file can still reach a model/report; prompt injection may still bias model judgment. Concurrent hostile filesystem mutation is outside the snapshot threat model. Reports contain source diffs and model output: inspect them before sharing. Executing proposed tests is a separate opt-in action, not implemented by this extension.

## Saved reports and follow-ups

`<pi-agent-dir>/pr-review/reports/<repository-scope>/<review-id>/` contains:

- `review.md`: findings and limitations.
- `details.md`: individual stage reports, tool-call audit, and rejected candidates.
- `review.json`: request, configuration, exact diff/revisions/hash, structured outputs, and usage.

Directories are created mode 0700 and files mode 0600. `/pr-review last` and `/pr-review details` select the last review for the current repository, not a single global last-review pointer. PR reports are scoped to the invoking repository/directory. Changing pi's agent directory changes both configuration and report storage.

The report participates in the parent pi conversation, so you can discuss a numbered finding. The independent reviewer sessions and snapshots are disposed, not silently resumed against newer source. Full evidence is available in the saved reports. A new investigation of changed source should use a new review. Saving failures are reported rather than claiming persistence succeeded.

## Scoped rebuttals

`/pr-review rebut CANDIDATE_ID "explanation"` records feedback on a candidate from this repository's last report. It saves your explanation locally and, after interactive confirmation where available, supplies it to future review models. It does **not** run a focused reassessment, close the finding, or change its original verdict. If the explanation is omitted, the interactive command opens an editor. Use candidate IDs such as `bug-1`, not the merged report's ordinal number.

Feedback is scoped to the invoking repository root plus local branch, branch-qualified range expression, or GitHub repository/PR number. Local and PR feedback do not cross scopes. Only active records whose finding/causal file overlaps the new changed-file set are included. Their original report ID and diff hash remain available so models can evaluate the rationale against current code, not assume it is still true. A disputed claim may be raised again when source evidence contradicts the explanation or circumstances changed; the verifier must explain why.

`/pr-review rebuttals` lists this repository's records and scopes. `/pr-review forget REBUTTAL_ID` withdraws a record while preserving its audit. `--no-feedback` omits all records for an individual review. These are explicit user actions; the model does not automatically save or adopt rebuttals. Records live beneath the repository's report directory in `feedback/`, with private file permissions. Do not put credentials in explanations. Legacy reports without recorded scope can be viewed, but require a fresh review before recording scoped feedback.

## Prompt comparison (opt-in)

```sh
npm run eval:pr-review                         # plan only; no credentials/model calls
npm run eval:pr-review -- --case guard-preserved
npm run eval:pr-review -- --case guard-preserved --run  # potentially paid, explicitly opted in
npm run eval:pr-review -- --run                 # all eight cases / both prompt sets
```

The harness freezes both the original prompts in `eval/baseline/` and current prompts into private evaluation artifacts, records their hashes, and uses the same pinned model/thinking, context, current schema, tools, and pipeline. This is a prompt comparison, not a reconstruction of the old implementation. It alternates variant ordering. Expected answers are not sent to agents; only the fixture code and ordinary intent are supplied. Fixtures exercise removed cleanup, preserved guards, valid/new versus unsupported language features, self-confirming tests, public secret exposure versus trusted local environments, and excluded-but-updated lockfiles.

A full run has up to 96 stage requests **before** tool turns and retries; start with one case. The standalone harness uses `auth.json`/`models.json` and does not load provider extensions. It executes only trusted harness Git setup/capture operations, not fixture code, tests, builds, or package installs. Ctrl+C cancels active sessions. Results, usage, frozen prompts, and a side-by-side `comparison.md` are saved under `<pi-agent-dir>/pr-review/evaluations/<id>/`.

Assessments start as `pending-human-review`. Compare actual failure reasoning, supported versus unresolved claims, severity, false positives, and missed expected issues. Filename/keyword matches are not proof of correct reasoning, so there are no automatic precision/recall or prompt-superiority claims. These small calibration fixtures are not a representative benchmark. No paid evaluation is part of `npm test` or ordinary review invocation.

## Development

```sh
npm install --ignore-scripts
npm run typecheck
npm test
npm run test:pr-review
```

Tests use temporary Git repositories, bounded filesystem tools, and mocked review stages; no paid/live model calls are required. They cover dirty/staged/branch/range semantics, default-branch merge-base behavior, PR object retrieval/head matching with a stubbed network transport, empty files/mode changes, original-index preservation, file boundaries, executable Git configuration suppression, structural evidence validation, successful independent verifier reads, single-reviewer survival, failures, context overflow, cancellation, and report persistence. Real SDK sessions and the full command path are exercised against a local scripted provider, including a repository extension that must not load.

Tests also cover excluded dependency metadata, nested module ownership, defect/improvement separation, corrected-severity ordering, complete cited-line provenance, scoped rebuttal persistence/withdrawal/opt-out, legacy report compatibility, and the no-model-call evaluation planner. Prompt accuracy still requires the opt-in comparison and human assessment.

Inspired by [llimllib/pr-review](https://github.com/llimllib/pr-review), with evidence-discipline ideas from [kenn-io/roborev](https://github.com/kenn-io/roborev). Reviewer instructions here are independently written for this inspection-only workflow; expected finding quotas, maximum-confidence aggregation, majority voting, automatic fixes, and merge verdicts are deliberately not adopted.
