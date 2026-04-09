# The Garden Extension — Pi SDK Explained

Garden is a cross-repo automation tool: you give it a task, it fans out one sub-agent per GitHub repo (up to 20 at a time), collects results, optionally asks for human approval on PRs, and synthesizes everything back into a summary in the parent conversation.

---

## 1. Registering a Slash Command

**File:** `src/index.ts`

```typescript
export default function (pi: ExtensionAPI) {
  pi.registerCommand("garden", {
    description: "Run any task across all repos in a GitHub org…",
    handler: async (args, ctx) => { ... }
  });
}
```

`pi.registerCommand(name, options)` is the extension API call. It does two things:
- Makes `/garden <args>` available in the pi TUI as a typed slash command (with tab-complete)
- Gives the handler a **`ctx: ExtensionCommandContext`** — a superset of the normal event context that includes session-control methods like `ctx.waitForIdle()`, `ctx.newSession()`, etc., which would deadlock if called from a regular event handler

The handler also receives `args` as a raw string (everything after `/garden`), so the command parses its own `--org`, `--repo`, `--dry-run` flags manually from that string.

Separately, `pi.registerTool(...)` registers the same logic as an **LLM-callable tool** — so the AI can invoke garden autonomously mid-conversation without the user typing `/garden`. This is a common pi pattern: expose the same capability as both a slash command (human-triggered) and a registered tool (LLM-triggered).

---

## 2. Spawning a Sub-Agent with Context

**File:** `src/helpers.ts` — `runWorker()`

Pi doesn't have a built-in "spawn sub-agent" SDK call. Instead, garden uses a **subprocess pattern**: it spawns `pi` itself in `--mode json -p` (non-interactive, JSON-streaming, print-and-exit mode) with specific flags:

```typescript
const piArgs = [
  "--mode", "json",      // emit NDJSON events on stdout
  "-p",                  // print mode (single-shot, exits when done)
  "--no-session",        // no session file, pure in-memory
  "--append-system-prompt", file,  // inject the gardener.md system prompt
  userMessage,           // the job JSON as the first user message
];
```

The **context** injected into the sub-agent has two parts:

**System prompt** — loaded from `agents/gardener.md`, written to a temp file, and passed via `--append-system-prompt`. This file tells the sub-agent its persona ("you are a garden worker agent"), its two-phase PR workflow, commit style conventions, and how to emit a `PROPOSED_PR` block. The `getWorkerSystemPrompt()` helper strips the YAML frontmatter before injecting it.

**User message** — a JSON blob called a `WorkerJob`:
```json
{
  "org": "adbc-drivers",
  "repo": "bigquery",
  "defaultBranch": "main",
  "task": "Update go toolchain to go1.26",
  "workspace": "/tmp/garden-abc123",
  "phase": "propose"
}
```

This is the sub-agent's entire brief. It gets `bash`, `read`, `edit`, and `write` tools (declared in the `gardener.md` frontmatter) and acts fully autonomously on that one repo.

Up to 20 sub-agents run concurrently via the `mapConcurrent()` helper (a bounded concurrency pool, not Promise.all).

---

## 3. Putting Sub-Agent Results Back into the Parent Agent

**File:** `src/helpers.ts` — reading stdout; `src/index.ts` — injecting the summary

**Reading the sub-agent's output:**

The sub-agent process emits NDJSON events on stdout (because `--mode json`). Garden reads these line by line and looks for events with `type === "message_end"` and `message.role === "assistant"` to capture the final text:

```typescript
if (event.type === "message_end" && event.message?.role === "assistant") {
  for (const part of event.message.content ?? []) {
    if (part.type === "text" && part.text) {
      result.output = part.text;
      onUpdate({ ...result });
    }
  }
}
```

It also looks for a `PROPOSED_PR` fenced block in the output and parses it via `parseProposal()` — that's how the sub-agent communicates structured data back to the orchestrator.

**Injecting back into the parent conversation:**

Once all workers are done, `buildSummaryPrompt()` assembles all outputs into a prompt, and the command handler calls:

```typescript
pi.sendMessage(
  { customType: "garden", content: summary, display: false },
  { triggerTurn: true },
);
```

`pi.sendMessage()` injects a custom message into the **parent agent's session**. The key options here:
- `customType: "garden"` — a type tag for custom rendering (the extension could register a `pi.registerMessageRenderer` for this)
- `display: false` — hidden from the user's chat view (it's just context fuel for the LLM)
- `triggerTurn: true` — immediately triggers an LLM response turn

So the LLM "wakes up" with the raw worker outputs already in its context and synthesizes them into a readable summary (table, status list, etc.) — without the user having to do anything.

For **dry-runs**, the same call is made but with `display: true` and `triggerTurn: false` — the plan markdown is shown directly in the chat without triggering an LLM turn.

---

## 4. Stopping to Prompt the User

**File:** `src/index.ts`

The extension uses several `ctx.ui.*` methods that pause execution and await human input:

**`ctx.ui.input(title, hint)` — prompts for missing required input**

```typescript
const task = cleanArgs || (await ctx.ui.input(
  "Task",
  "What should each repo's worker agent do? e.g. 'What Go version is used?'",
));
if (task == null || task === "") {
  ctx.ui.notify("Cancelled — no task specified.", "warning");
  return;
}
```

If the user types `/garden` with no task, this opens an input dialog. Returns `null` if they cancel — in which case the command exits cleanly.

**`ctx.ui.confirm(title, body)` — PR approval gate**

This is the most important stop-point. Before any PR is actually opened, the orchestrator calls:

```typescript
const approved = await ctx.ui.confirm(
  `Open PR for ${proposal.org}/${proposal.repo}?`,
  [
    `**Branch:** \`${proposal.branchName}\``,
    `**Title:** ${proposal.prTitle}`,
    `**Changes:**`,
    proposal.diffSummary,
    `**PR body:**`,
    proposal.prBody,
  ].join("\n"),
);
return approved ?? false;
```

This fires once per repo that produced a proposal. Execution is suspended while the user reviews the diff summary and PR details in a modal dialog. Only if they approve does the orchestrator call `openPR()` (which shells out to `gh pr create`) and then spin up a phase-2 CI-monitor sub-agent.

**`ctx.ui.notify(message, level)` — fire-and-forget status toasts**

Used throughout for non-blocking status messages: `"🌱 garden: starting…"`, error messages, the final `"Done: N repos processed"`. Level can be `"info"`, `"warning"`, or `"error"`.

**`ctx.ui.setStatus(key, message)` — footer status bar**

```typescript
ctx.ui.setStatus(WIDGET_KEY, `Listing ${org} repos…`);
// ... later
ctx.ui.setStatus(WIDGET_KEY, "");  // clear it
```

A persistent one-liner in pi's status bar, keyed by `WIDGET_KEY = "garden"`. Used for transient in-progress messages.

**`ctx.ui.setWidget(key, lines)` — live multi-line progress widget**

```typescript
ctx.ui.setWidget(WIDGET_KEY, [
  `🌱 garden  ${done} done, ${running} running…`,
  ...results.map((r) => {
    const icon = { done: "✅", running: "⏳", error: "❌" }[r.status];
    return `  ${icon} ${r.repo}\n  ${r.output?.split("\n")[0].slice(0, 72)}`;
  }),
]);
```

This renders a live dashboard above the editor — one line per repo, updated on every worker callback via `onResults`. When the confirm dialog fires, the widget is temporarily cleared (`setWidget(WIDGET_KEY, [])`) so it doesn't compete visually with the modal.

---

## The Full Flow

```
User types /garden update go toolchain to 1.26 --file-filter go.mod
          │
          ▼
pi.registerCommand handler fires
  │  ctx.ui.setStatus("Listing repos…")
  │  gh repo list → filter by file presence
  │
  ▼
runGarden() called with onProposal callback
  │  mapConcurrent(repos, 20, runWorker)
  │    └─ spawns: pi --mode json -p --no-session --append-system-prompt gardener.md <job>
  │    └─ reads NDJSON stdout, extracts final assistant text + PROPOSED_PR block
  │  ctx.ui.setWidget(live dashboard)  ← updates as workers complete
  │
  ▼
For each result.proposal:
  │  ctx.ui.setWidget([])   ← pause dashboard
  │  ctx.ui.confirm(...)    ← STOP: user reviews & approves/rejects
  │  if approved: openPR() → runWorker(phase: "monitor")
  │
  ▼
buildSummaryPrompt(task, results)
pi.sendMessage({ content: summary, display: false }, { triggerTurn: true })
  └─ parent LLM wakes up, synthesizes outputs into final answer
```
