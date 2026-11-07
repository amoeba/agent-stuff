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

/**
 * Live stage rail shown in the review overlay. Renders one row per pipeline stage,
 * a stage progress bar, and the elapsed time. Escape/Ctrl+C aborts via the bound keybinding.
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

  private running(): boolean {
    return [...this.activities.values()].some(state => !SETTLED.has(state));
  }

  private state(stage: Stage): string {
    return this.activities.get(stage) ?? "queued";
  }

  private glyph(state: string): string {
    if (state === "queued") return this.theme.fg("dim", "·");
    if (state === "done") return this.theme.fg("success", "✓");
    if (state === "failed") return this.theme.fg("error", "✗");
    return this.theme.fg("accent", SPINNER[this.frame % SPINNER.length]!);
  }

  private activity(state: string): string {
    if (state === "queued") return this.theme.fg("dim", "queued");
    if (state === "done") return this.theme.fg("success", "done");
    if (state === "failed") return this.theme.fg("error", "failed");
    if (state === "starting") return this.theme.fg("muted", "starting…");
    return this.theme.fg("text", state);
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

  private bar(width: number): string {
    const done = STAGES.filter(stage => this.state(stage) === "done").length;
    const cells = Math.max(6, Math.min(28, width - 16));
    const filled = Math.round((done / STAGES.length) * cells);
    return `  ${this.theme.fg("success", "█".repeat(filled))}${this.theme.fg("dim", "░".repeat(cells - filled))} ${this.theme.fg("muted", `${done}/${STAGES.length}`)}`;
  }

  render(width: number): string[] {
    const done = STAGES.filter(stage => this.state(stage) === "done").length;
    const failed = STAGES.filter(stage => this.state(stage) === "failed").length;
    const header = [
      this.theme.fg("accent", "Multi-agent review"),
      this.theme.fg("dim", "·"),
      this.theme.fg("text", `${done}/${STAGES.length}`),
      ...(failed ? [this.theme.fg("dim", "·"), this.theme.fg("error", `${failed} failed`)] : []),
      this.theme.fg("dim", "·"),
      this.theme.fg("muted", this.timing()),
    ].join(" ");

    const lines: string[] = [this.border(width), ` ${truncateToWidth(header, Math.max(0, width - 2), "…")}`];
    for (const stage of STAGES) {
      const state = this.state(stage);
      const prefix = `  ${this.glyph(state)} ${this.theme.fg("muted", stage.padEnd(10))}`;
      const available = Math.max(0, width - visibleWidth(prefix) - 2);
      lines.push(`${prefix} ${truncateToWidth(this.activity(state), available, "…")}`);
    }
    lines.push(this.bar(width), this.border(width), `  ${this.hint()}`);
    return lines.map(line => truncateToWidth(line, width, ""));
  }
}
