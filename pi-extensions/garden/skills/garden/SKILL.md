---
name: garden

description: Run any task across every repository in a GitHub org using parallel subagents — one per repo. Defaults to the adbc-drivers org. Use for cross-repo queries ("what Go version does each repo use?"), bulk changes ("update go toolchain to 1.26 in all repos with a go.mod"), audits, or any per-repo investigation. Triggered via /garden or the garden tool.
disable-model-invocation: true
---

# garden

Run any task across every repository in a GitHub org using **parallel subagents** — one per repo.

## What it can do

The worker agent is generic. Tell it what to do in plain English and it figures out the right approach:

| Example task                                               | What happens                                                                                  |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `What Go version is declared in go.mod?`                   | Worker reads the file via GitHub API, answers concisely                                       |
| `Update go toolchain to go1.26 in all repos with a go.mod` | Worker clones, edits, pushes branch, opens draft PR, monitors CI, fixes failures, marks ready |
| `Does this repo have a CODEOWNERS file?`                   | Worker checks via API, answers yes/no                                                         |
| `List all GitHub Actions workflow files`                   | Worker lists `.github/workflows/` contents                                                    |

The orchestrator collects all worker outputs and asks the LLM to synthesize them into an appropriate summary — a table for queries, a status list for bulk changes, etc.

## How to invoke

### Slash command

```
/garden What Go version is declared in go.mod?
/garden --dry-run update go toolchain to 1.26 in all repos
/garden --org=my-other-org audit dependency versions
/garden --org amoeba --repo ac-server-monitor create prs to upgrade the go toolchain to 1.26.0
/garden --file-filter go.mod update go toolchain to 1.26 in all repos
```

The org defaults to `adbc-drivers`. All flags (`--org`, `--repo`, `--file-filter`, `--dry-run`) are optional; anything remaining after stripping flags is treated as the task.

### Natural language (LLM calls the `garden` tool)

```
What Go version does each adbc-drivers repo use?
Update the go toolchain to 1.26 in all adbc-drivers repos that have a go.mod
What Go version does each repo in my-other-org use?
```

The LLM defaults to `adbc-drivers` unless another org is mentioned.

## Parameters

| Parameter    | Description                                                        |
| ------------ | ------------------------------------------------------------------ |
| `org`        | GitHub org to target (default: `adbc-drivers`). Override via `--org=<name>` |
| `task`       | What each worker agent should do — freeform, as specific as needed |
| `fileFilter` | _(optional)_ Only target repos containing this file. Accepts an exact path (`go/go.mod`) or a bare filename (`go.mod`) which is matched anywhere in the tree. |
| `dryRun`     | _(optional)_ Preview the repo list without spawning workers        |

## adbc-drivers repo categories

A repo is a **driver repo** if and only if it has both `manifest.toml` and `.github/workflows/generate.toml`. Non-driver repos have neither.

| Target set | fileFilter |
|------------|-----------|
| All driver repos | `manifest.toml` |
| Go driver repos | `go/manifest.toml` |
| Rust driver repos | `rust/manifest.toml` |

See `docs/adbc-drivers-repo-taxonomy.md` for the full catalogue.

## Architecture

```
/garden <task>
    |
    +-- gh repo list <org>               (+ optional file-presence filter)
    |
    +-- gardener (repo-1)  -> pi --mode json  -+
    +-- gardener (repo-2)  -> pi --mode json   +-- up to 4 concurrent
    +-- gardener (repo-3)  -> pi --mode json   |
    +-- gardener (repo-N)  -> pi --mode json  -+
    |
    +-- LLM synthesizes all worker outputs into a summary
```

## Files

```
src/index.ts                            - orchestrator extension
agents/gardener.md                 - per-repo worker agent system prompt
docs/adbc-drivers-repo-taxonomy.md      - repo category reference (driver vs infra vs stub)
skills/garden/SKILL.md                  - this file
```

## Prerequisites

- `gh` CLI authenticated (`gh auth status`)
- For PR tasks: push access to branches in target org
- `pi` on `$PATH`
