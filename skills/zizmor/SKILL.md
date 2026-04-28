---
name: zizmor
description: Audit GitHub Actions workflows in a repository for security vulnerabilities using zizmor. Finds and fixes dangerous triggers, template injection, excessive permissions, unpinned actions, and more.
---

# zizmor Audit Skill

## Why This Matters

GitHub Actions is the primary attack surface for supply chain compromise. Real incidents tracing to a handful of recurring misconfigurations:

- **spotbugs/reviewdog/tj-actions chain (2024–2025)**: `pull_request_target` ran fork code with base-repo secrets. A stolen PAT propagated to 23,000 downstream repos via mutable `@v1` tags.
- **Ultralytics (2024)**: `pull_request_target` poisoned the Actions cache; the legitimate release workflow later restored the payload and shipped a crypto miner to PyPI.
- **nx/s1ngularity (2025)**: PR title interpolated as `${{ github.event.pull_request.title }}` directly into a `run:` step — shell injection with an npm publish token in scope.
- **elementary-data (2026)**: `issue_comment` trigger, no `permissions:` block, `${{ github.event.comment.body }}` in bash. One comment → forged commit → malicious wheel on PyPI in 10 minutes.

The same five features keep recurring: `pull_request_target`/`workflow_run`, `${{ ... }}` expansion into shell, write-scoped default `GITHUB_TOKEN`, mutable action tags, and cross-trust-boundary caches.

## Step 1 — Run the Audit

From the repository root:

```bash
zizmor .
```

If `zizmor` is not installed: `brew install zizmor` (macOS) or `cargo install zizmor`.

## Step 2 — Apply Safe Auto-fixes

```bash
zizmor --fix .
```

This safely resolves: `unpinned-uses` (hash-pins action refs), `template-injection` (moves expansions to env vars), `insecure-commands`, `ref-version-mismatch`, and others flagged as auto-fixable. Re-run the audit after to see remaining findings.

Do **not** run `--fix=all` without user confirmation — unsafe fixes can break workflows.

## Step 3 — Fix Remaining Findings by Priority

Work through findings in this order:

### 1. `dangerous-triggers` (Critical)

`pull_request_target` and `workflow_run` run with the base repo's secrets and write token, triggerable by untrusted forks.

- **Replace `pull_request_target` with `pull_request`** unless the job genuinely needs write access to the base repo (e.g., posting a comment or label on a fork PR). `pull_request` runs with a read-only token scoped to the fork.
- If `pull_request_target` is truly required: never `uses: actions/checkout` on `github.event.pull_request.head.sha` inside it, and add `if: github.event.pull_request.head.repo.full_name == github.repository` to restrict to same-repo PRs.
- **Replace `workflow_run` with `workflow_call`** (reusable workflow) wherever possible.

### 2. `template-injection` (Critical)

`${{ github.event.* }}` expands before the shell sees the script — attacker controls the string.

Auto-fix moves them to env vars, but verify the result:

```yaml
# BAD
- run: echo "${{ github.event.pull_request.title }}"

# GOOD (auto-fix produces this; confirm it uses ${VAR} not ${{ env.VAR }})
- run: echo "${TITLE}"
  env:
    TITLE: ${{ github.event.pull_request.title }}
```

Attacker-controllable contexts: `github.event.**.title`, `github.event.**.body`, `github.event.**.head.ref`, `github.event.comment.body`, `github.head_ref`.

### 3. `excessive-permissions` (High)

Default `GITHUB_TOKEN` is write-scoped on repos created before Feb 2023. No `permissions:` block = whatever the org/repo default is.

Add to every workflow file:

```yaml
permissions: {} # deny all at workflow level
```

Then add the minimum needed at the job level:

```yaml
jobs:
  build:
    permissions:
      contents: read
```

Common minimal sets: `contents: read` for checkout, `id-token: write` + `contents: read` for trusted publishing, `pull-requests: write` for PR comments.

### 4. `unpinned-uses` (High)

Mutable tags (`@v4`, `@main`) were the vector in the tj-actions and Trivy incidents. `--fix` hash-pins them; confirm the version comment is correct:

```yaml
uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
```

After pinning, add Dependabot or Renovate to keep hashes current.

### 5. `impostor-commit` (High, online only)

A SHA pin that only exists in a fork — not on any branch of the upstream repo. The runner executes it anyway. The only fix is to replace it with a commit that is verifiably on the upstream.

### 6. `artipacked` / `cache-poisoning` (Medium)

**`artipacked`**: `actions/checkout` without `persist-credentials: false` leaves the GitHub token in `.git/config`, readable if the workspace is later uploaded as an artifact or shared with a subsequent job from an untrusted source.

```yaml
- uses: actions/checkout@<sha> # vX.Y.Z
  with:
    persist-credentials: false
```

**`cache-poisoning`**: Actions like `setup-go` and `setup-uv` enable caching by default. If the workflow has both a `pull_request` trigger (where a PR branch can write a cache entry) and a publishing step (which later restores from cache), a malicious PR could poison the cache that a release build consumes — shipping attacker-controlled artifacts. The fix is `cache: false` / `enable-cache: false` on those setup actions.

However, **do not blindly disable caching on every job**. Evaluate per-job:

- **Jobs that publish artifacts** (create releases, push to PyPI, publish Docker images): always set `cache: false`. The release build must start clean.
- **Non-publishing jobs** (snapshot builds, test runs, lint): weigh the risk against the build-time cost. A job guarded by `if: !github.event.pull_request.head.repo.fork` meaningfully reduces the attack surface — only contributors with repo write access can write cache entries, the cache key is usually `go.sum`/`uv.lock`-derived (so influencing it requires a visible lockfile change in the PR diff), and the output is never published. Accepting the finding here is a reasonable tradeoff.

A good split for a workflow that has both snapshot and release jobs:

```yaml
# snapshot job — non-publishing, fork PRs excluded: keep caching
- uses: actions/setup-go@<sha>
  with:
    go-version-file: './go.mod'
    # cache: true (default)

# production_deploy job — publishes a real release: no cache
- uses: actions/setup-go@<sha>
  with:
    go-version-file: './go.mod'
    cache: false
```

### 7. `github-env` (Medium)

Writing attacker-controlled values to `GITHUB_ENV` or `GITHUB_PATH` inside `pull_request_target`/`workflow_run` can allow `LD_PRELOAD` or PATH-shadowing attacks. Avoid entirely; use `GITHUB_OUTPUT` for inter-step state.

### 8. `secrets-inherit` (Medium)

`secrets: inherit` forwards every secret to a reusable workflow. Replace with an explicit `secrets:` block listing only what the called workflow actually needs.

### 9. Other findings

- `known-vulnerable-actions`: Upgrade to the fixed version shown in the advisory.
- `insecure-commands`: Remove `ACTIONS_ALLOW_UNSECURE_COMMANDS: true`; use `GITHUB_OUTPUT`/`GITHUB_PATH` env files instead.
- `overprovisioned-secrets`/`unredacted-secrets`: Access secrets individually by name, not as `toJSON(secrets)` or `fromJSON(secrets.X).field`.
- `unsound-condition`, `unsound-contains`: Follow the inline remediation — replace string `contains()` checks with `fromJSON(...)` array form or explicit equality.

## Step 4 — Verify

```bash
zizmor .
```

Expect zero High/Critical findings. Informational findings (e.g., `self-hosted-runner`, pedantic permission comments) can be deferred; discuss with the user.

## Decisions NOT to Make

- Do **not** add `zizmorcore/zizmor-action` to CI unless the user asks.
- Do **not** run `--fix=all` without user confirmation.
- Do **not** convert `pull_request_target` to `pull_request` if the workflow explicitly posts comments, labels, or otherwise writes back to the PR — ask the user what the intended behavior is.
- Do **not** remove entire workflow steps to fix a finding; fix the misconfiguration surgically.
