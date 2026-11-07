import {
  KeybindingsManager, type Component, type TUI, truncateToWidth, visibleWidth,
} from "@earendil-works/pi-tui";
import type { Theme } from "@earendil-works/pi-coding-agent";
import { REVIEWERS, type Stage } from "./types.ts";

/** Pipeline order: parallel reviewers first, then verification, then synthesis. */
export const STAGES: Stage[] = [...REVIEWERS, "verify", "synthesize"];

const SPINNER = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
/** Activity strings that mean a stage is no longer consuming model/tool time. */
const SETTLED = new Set(["queued", "done", "failed"]);

type StageColor = "dim" | "success" | "error" | "muted" | "text";

function padTo(text: string, width: number): string {
  const current = visibleWidth(text);
  return current >= width ? text : text + " ".repeat(width - current);
}

function fit(text: string, width: number): string {
  return padTo(truncateToWidth(text, Math.max(0, width), "…"), width);
}

/**
 * Live workflow graph shown in the review overlay: the four reviewers fan in to
 * the verifier, which feeds synthesis. Escape/Ctrl+C aborts via the bound keybinding.
 */
export class ReviewProgressPanel implements Component {
  private readonly activities = new Map<Stage, string>(STAGES.map(stage => [stage, "queued"]));
  private readonly timer: ReturnType<typeof setInterval>;
  private readonly tui: TUI;
  private readonly theme: Theme;
  private readonly keybindings: KeybindingsManager;
  private readonly onAbort: () => void;
  private frame = 0;
  private startedAt: number | undefined;
  private disposed = false;

  constructor(tui: TUI, theme: Theme, keybindings: KeybindingsManager, onAbort: () => void) {
    this.tui = tui;
    this.theme = theme;
    this.keybindings = keybindings;
    this.onAbort = onAbort;
    this.timer = setInterval(() => {
      if (this.disposed) return;
      this.frame++;
      if (this.running()) this.tui.requestRender();
    }, 90);
  }

  setActivities(activities: ReadonlyMap<Stage, string>): void {
    for (const [stage, activity] of activities) this.activities.set(stage, activity);
    if (this.startedAt === undefined && [...this.activities.values()].some(state => !SETTLED.has(state)))
      this.startedAt = Date.now();
    this.tui.requestRender();
  }

  handleInput(data: string): void {
    if (this.keybindings.matches(data, "tui.select.cancel")) this.onAbort();
  }

  invalidate(): void {}

  dispose(): void {
    this.disposed = true;
    clearInterval(this.timer);
  }

  render(width: number): string[] {
    const lines: string[] = [this.border(width), this.headerLine(width)];
    lines.push(...(this.graphLines(width) ?? this.compactLines(width)));
    lines.push(this.border(width), `  ${this.hint()}`);
    return lines.map(line => truncateToWidth(line, width, ""));
  }

  private running(): boolean {
    return [...this.activities.values()].some(state => !SETTLED.has(state));
  }

  private state(stage: Stage): string {
    return this.activities.get(stage) ?? "queued";
  }

  private colorFor(state: string): StageColor {
    if (state === "queued") return "dim";
    if (state === "done") return "success";
    if (state === "failed") return "error";
    if (state === "starting") return "muted";
    return "text";
  }

  private activityText(state: string): string {
    return state === "starting" ? "starting…" : state;
  }

  private glyphFor(state: string): string {
    if (state === "queued") return this.theme.fg("dim", "·");
    if (state === "done") return this.theme.fg("success", "✓");
    if (state === "failed") return this.theme.fg("error", "✗");
    return this.theme.fg("accent", SPINNER[this.frame % SPINNER.length]!);
  }

  private timing(): string {
    if (this.startedAt === undefined) return "preparing…";
    const total = Math.max(0, Math.floor((Date.now() - this.startedAt) / 1000));
    return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
  }

  private border(width: number): string {
    return this.theme.fg("border", "─".repeat(Math.max(1, width)));
  }

  private hint(): string {
    const keys = this.keybindings.getKeys("tui.select.cancel").join("/");
    return `${this.theme.fg("dim", keys)} ${this.theme.fg("muted", "cancel")}`;
  }

  private headerLine(width: number): string {
    const done = STAGES.filter(stage => this.state(stage) === "done").length;
    const failed = STAGES.filter(stage => this.state(stage) === "failed").length;
    const cells = Math.max(6, Math.min(14, width - 34));
    const filled = Math.round((done / STAGES.length) * cells);
    const bar = this.theme.fg("success", "█".repeat(filled)) + this.theme.fg("dim", "░".repeat(cells - filled));
    return ` ${this.theme.fg("accent", "Multi-agent review")}  ${bar}  `
      + `${this.theme.fg("text", `${done}/${STAGES.length}`)} ${this.theme.fg("dim", "·")} `
      + `${this.theme.fg("muted", this.timing())}`
      + (failed ? ` ${this.theme.fg("error", `· ${failed} failed`)}` : "");
  }

  /** Full fan-in flowchart; returns undefined when the terminal is too narrow. */
  private graphLines(width: number): string[] | undefined {
    const count = REVIEWERS.length;
    const gap = 2;
    const boxW = Math.min(18, Math.floor((width - 4 - (count - 1) * gap) / count));
    if (boxW < 13) return undefined;

    const total = count * boxW + (count - 1) * gap;
    const start = Math.max(1, Math.floor((width - total) / 2));
    const xs = REVIEWERS.map((_, index) => start + index * (boxW + gap));
    const centers = xs.map(x => x + Math.floor(boxW / 2));
    const drop = Math.floor((centers[0]! + centers[centers.length - 1]!) / 2);

    const nodeW = Math.min(30, Math.max(24, boxW + 4));
    const nodeX = drop - Math.floor(nodeW / 2);

    return [
      this.boxRow(xs, boxW, REVIEWERS.map(() => this.boxTop(boxW))),
      this.boxRow(xs, boxW, REVIEWERS.map(stage => this.boxLabel(stage, boxW))),
      this.boxRow(xs, boxW, REVIEWERS.map(stage => this.boxActivity(stage, boxW))),
      this.boxRow(xs, boxW, REVIEWERS.map(() => this.boxStem(boxW))),
      this.columnRow(centers, "│", width),
      this.junctionRow(centers, drop, width),
      this.columnRow([drop], "▼", width),
      this.nodeTop(nodeX, nodeW),
      this.nodeContent("verify", nodeX, nodeW),
      this.nodeStem(nodeX, nodeW),
      this.columnRow([drop], "▼", width),
      this.nodeTop(nodeX, nodeW),
      this.nodeContent("synthesize", nodeX, nodeW),
      this.nodeFlat(nodeX, nodeW),
    ];
  }

  private boxRow(xs: number[], boxW: number, parts: string[]): string {
    let line = "";
    let cursor = 0;
    for (let index = 0; index < parts.length; index++) {
      const x = xs[index]!;
      if (x > cursor) line += " ".repeat(x - cursor);
      line += parts[index]!;
      cursor = x + boxW;
    }
    return line;
  }

  private boxTop(boxW: number): string {
    return this.theme.fg("border", "┌" + "─".repeat(boxW - 2) + "┐");
  }

  private boxLabel(stage: Stage, boxW: number): string {
    const state = this.state(stage);
    const content = ` ${this.glyphFor(state)} ${this.theme.fg("muted", stage)}`;
    return this.theme.fg("border", "│") + fit(content, boxW - 2) + this.theme.fg("border", "│");
  }

  private boxActivity(stage: Stage, boxW: number): string {
    const state = this.state(stage);
    const content = ` ${this.theme.fg(this.colorFor(state), this.activityText(state))}`;
    return this.theme.fg("border", "│") + fit(content, boxW - 2) + this.theme.fg("border", "│");
  }

  private boxStem(boxW: number): string {
    const center = Math.floor(boxW / 2);
    return this.theme.fg("border",
      "└" + "─".repeat(center - 1) + "┬" + "─".repeat(boxW - 2 - center) + "┘");
  }

  private columnRow(columns: number[], glyph: string, width: number): string {
    const chars = Array<string>(width).fill(" ");
    for (const column of columns) if (column >= 0 && column < width) chars[column] = glyph;
    return this.theme.fg("border", chars.join(""));
  }

  private junctionRow(centers: number[], drop: number, width: number): string {
    const chars = Array<string>(width).fill(" ");
    const first = centers[0]!;
    const last = centers[centers.length - 1]!;
    for (let column = first; column <= last; column++) chars[column] = "─";
    chars[first] = "└";
    chars[last] = "┘";
    for (let index = 1; index < centers.length - 1; index++) chars[centers[index]!] = "┴";
    chars[drop] = centers.includes(drop) ? "┼" : "┬";
    return this.theme.fg("border", chars.join(""));
  }

  private nodeTop(x: number, nodeW: number): string {
    return " ".repeat(x) + this.theme.fg("border", "┌" + "─".repeat(nodeW - 2) + "┐");
  }

  private nodeContent(stage: Stage, x: number, nodeW: number): string {
    const state = this.state(stage);
    const innerWidth = nodeW - 2;
    const prefix = ` ${this.glyphFor(state)} ${this.theme.fg("muted", stage)}${this.theme.fg("dim", " · ")}`;
    const room = Math.max(0, innerWidth - visibleWidth(prefix));
    const activity = this.theme.fg(this.colorFor(state), truncateToWidth(this.activityText(state), room, "…"));
    return " ".repeat(x) + this.theme.fg("border", "│") + padTo(prefix + activity, innerWidth) + this.theme.fg("border", "│");
  }

  private nodeStem(x: number, nodeW: number): string {
    const center = Math.floor(nodeW / 2);
    return " ".repeat(x) + this.theme.fg("border",
      "└" + "─".repeat(center - 1) + "┬" + "─".repeat(nodeW - 2 - center) + "┘");
  }

  private nodeFlat(x: number, nodeW: number): string {
    return " ".repeat(x) + this.theme.fg("border", "└" + "─".repeat(nodeW - 2) + "┘");
  }

  /** Narrow-terminal fallback: one row per stage. */
  private compactLines(width: number): string[] {
    return STAGES.map(stage => {
      const state = this.state(stage);
      const prefix = `  ${this.glyphFor(state)} ${this.theme.fg("muted", stage.padEnd(10))}`;
      const available = Math.max(0, width - visibleWidth(prefix) - 2);
      return `${prefix} ${truncateToWidth(this.theme.fg(this.colorFor(state), this.activityText(state)), available, "…")}`;
    });
  }
}
