import type { CliEvent } from "../cli/types.js";

export interface TaskActivity {
  toolName: string;
  label: string;
  detail?: string;
  durationMs: number;
  failed: boolean;
}

export interface TaskProgressSnapshot {
  current: string;
  currentToolName?: string;
  currentDetail?: string;
  elapsedMs: number;
  toolCount: number;
  completedCount: number;
  activities: TaskActivity[];
  contextUsedTokens?: number;
  contextStartTokens?: number;
  contextWindowTokens?: number;
  startedNewSession?: boolean;
}

interface ActiveTool {
  toolName: string;
  label: string;
  detail?: string;
  startedAt: number;
}

export class TaskProgressTracker {
  private readonly startedAt: number;
  private readonly activeTools = new Map<string, ActiveTool>();
  private readonly activities: TaskActivity[] = [];
  private toolCount = 0;
  private completedCount = 0;
  private contextUsedTokens: number | undefined;
  private contextStartTokens: number | undefined;

  constructor(
    private readonly now: () => number = Date.now,
    private readonly contextWindowTokens?: number,
    private readonly startedNewSession = false,
  ) {
    this.startedAt = now();
  }

  accept(event: CliEvent): TaskProgressSnapshot {
    if (event.type === "context") {
      this.contextStartTokens ??= event.usedTokens;
      this.contextUsedTokens = event.usedTokens;
    }
    if (event.type === "tool_start") {
      this.toolCount += 1;
      this.activeTools.set(event.toolUseId, {
        toolName: event.toolName,
        label: event.label,
        detail: event.detail,
        startedAt: this.now(),
      });
    }
    if (event.type === "tool_end") {
      const tool = this.activeTools.get(event.toolUseId);
      if (tool) {
        this.activeTools.delete(event.toolUseId);
        this.completedCount += 1;
        this.activities.unshift({
          toolName: tool.toolName,
          label: tool.label,
          ...(tool.detail ? { detail: tool.detail } : {}),
          durationMs: Math.max(0, this.now() - tool.startedAt),
          failed: event.failed,
        });
        this.activities.splice(12);
      }
    }
    return this.snapshot();
  }

  snapshot(): TaskProgressSnapshot {
    const active = [...this.activeTools.values()].at(-1);
    return {
      current: active?.label ?? (this.toolCount ? "正在分析执行结果" : "正在理解任务"),
      ...(active ? { currentToolName: active.toolName } : {}),
      ...(active?.detail ? { currentDetail: active.detail } : {}),
      elapsedMs: Math.max(0, this.now() - this.startedAt),
      toolCount: this.toolCount,
      completedCount: this.completedCount,
      activities: [...this.activities],
      ...(this.contextUsedTokens !== undefined ? { contextUsedTokens: this.contextUsedTokens } : {}),
      ...(this.contextStartTokens !== undefined ? { contextStartTokens: this.contextStartTokens } : {}),
      ...(this.contextWindowTokens !== undefined ? { contextWindowTokens: this.contextWindowTokens } : {}),
      ...(this.startedNewSession ? { startedNewSession: true } : {}),
    };
  }
}
