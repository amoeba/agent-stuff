import type { ReviewRequest, Target } from "./types.ts";

export const HELP = `Usage:
/pr-review                         Pick branch, dirty, staged, range, or PR
/pr-review branch [--base REF] [--include-dirty]
/pr-review dirty                   Staged + unstaged + untracked (non-ignored)
/pr-review staged
/pr-review range BASE HEAD         Exact two-tree comparison
/pr-review range BASE...HEAD       Merge-base comparison
/pr-review pr URL|owner/repo#123
Append --context "intent", repeat --exclude "glob", or use --no-feedback.
/pr-review rebut CANDIDATE_ID "explanation"  Save scoped feedback on the last report
/pr-review rebuttals                List saved explanations and their scopes
/pr-review forget REBUTTAL_ID        Withdraw an explanation (preserves its audit)
/pr-review config                  Choose and pin model/thinking
/pr-review config PROVIDER/MODEL [THINKING]
/pr-review last                    Redisplay this repository's last saved report
/pr-review details                 Show individual reports and rejected candidates
/pr-review cancel                  Cancel capture and all active agents
No tests or repository code are executed. GitHub PR retrieval requires gh and confirmation.`;

export function tokenize(input: string): string[] {
  const tokens: string[] = [];
  let value = "", quote = "", started = false;
  for (let i = 0; i < input.length; i++) {
    const c = input[i];
    if (c === "\\" && quote !== "'") {
      if (++i >= input.length) throw new Error("Trailing escape in arguments");
      value += input[i]; started = true;
    } else if (quote) {
      if (c === quote) quote = ""; else value += c;
    } else if (c === "'" || c === '"') { quote = c; started = true; }
    else if (/\s/.test(c)) {
      if (started) tokens.push(value);
      value = ""; started = false;
    } else { value += c; started = true; }
  }
  if (quote) throw new Error("Unclosed quote in arguments");
  if (started) tokens.push(value);
  return tokens;
}

export function parseRequest(args: string): ReviewRequest | undefined {
  const tokens = tokenize(args);
  const positional: string[] = [], exclude: string[] = [];
  let context = "", base: string | undefined, includeDirty = false, useFeedback: false | undefined;
  for (let i = 0; i < tokens.length; i++) {
    const token = tokens[i];
    if (["--context", "--exclude", "--base"].includes(token)) {
      const value = tokens[++i];
      if (!value || value.startsWith("--")) throw new Error(`Missing value for ${token}`);
      if (token === "--context") context = value;
      if (token === "--exclude") exclude.push(value);
      if (token === "--base") base = value;
    } else if (token === "--include-dirty") includeDirty = true;
    else if (token === "--no-feedback") useFeedback = false;
    else if (token.startsWith("-")) throw new Error(`Unknown option: ${token}`);
    else positional.push(token);
  }
  if (!positional.length) {
    if (context || exclude.length || base || includeDirty || useFeedback === false) throw new Error("Specify a target before options");
    return undefined;
  }
  const [kind, ...rest] = positional;
  if (kind !== "branch" && (base || includeDirty)) throw new Error("--base and --include-dirty apply only to branch reviews");
  let target: Target;
  if (kind === "branch" && !rest.length) target = { kind, base, includeDirty };
  else if ((kind === "dirty" || kind === "staged") && !rest.length) target = { kind };
  else if (kind === "range" && rest.length === 2) target = { kind, base: rest[0], head: rest[1] };
  else if (kind === "range" && rest.length === 1 && rest[0].includes("...")) {
    const parts = rest[0].split("...");
    if (parts.length !== 2 || !parts.every(Boolean)) throw new Error("Expected BASE...HEAD");
    target = { kind, base: `${parts[0]}...`, head: parts[1] };
  } else if (kind === "pr" && rest.length === 1) target = { kind, reference: rest[0] };
  else throw new Error(HELP);
  return { target, context, exclude, ...(useFeedback === false ? { useFeedback } : {}) };
}

export function parsePR(reference: string): { repo: string; number: string } {
  const match = /^https:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/pull\/(\d+)(?:\/(?:files|commits|changes))?\/?(?:[?#].*)?$/.exec(reference)
    ?? /^([\w.-]+\/[\w.-]+)#(\d+)$/.exec(reference);
  if (!match || Number(match[2]) < 1) throw new Error("Expected a GitHub PR URL or owner/repo#123");
  return { repo: match[1], number: match[2] };
}
