import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { dirname } from "node:path";
import { z } from "zod";

export interface ScheduledRun {
  id: string;
  scheduleId: string;
  scheduledFor: string;
  startedAt: string;
  completedAt?: string;
  status: "running" | "succeeded" | "failed" | "skipped";
  taskId?: string;
  error?: string;
}

const ScheduledRunSchema = z.object({
  id: z.string().min(1),
  scheduleId: z.string().min(1),
  scheduledFor: z.string().min(1),
  startedAt: z.string().min(1),
  completedAt: z.string().optional(),
  status: z.enum(["running", "succeeded", "failed", "skipped"]),
  taskId: z.string().optional(),
  error: z.string().optional(),
});

const MAX_RUNS_PER_SCHEDULE = 100;

export class ScheduleRunStore {
  private readonly runs = new Map<string, ScheduledRun>();

  constructor(initialRuns: ScheduledRun[] = []) {
    for (const run of initialRuns) this.runs.set(run.id, run);
  }

  create(scheduleId: string, scheduledFor: string): ScheduledRun | undefined {
    if (this.find(scheduleId, scheduledFor)) return undefined;
    const run: ScheduledRun = {
      id: randomUUID().replaceAll("-", "").slice(0, 12),
      scheduleId,
      scheduledFor,
      startedAt: new Date().toISOString(),
      status: "running",
    };
    this.runs.set(run.id, run);
    this.prune(scheduleId);
    return run;
  }

  find(scheduleId: string, scheduledFor: string): ScheduledRun | undefined {
    return [...this.runs.values()].find((run) => run.scheduleId === scheduleId && run.scheduledFor === scheduledFor);
  }

  latestRunning(scheduleId: string): ScheduledRun | undefined {
    return [...this.runs.values()]
      .filter((run) => run.scheduleId === scheduleId && run.status === "running")
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt))[0];
  }

  list(scheduleId: string): ScheduledRun[] {
    return [...this.runs.values()]
      .filter((run) => run.scheduleId === scheduleId)
      .sort((a, b) => b.startedAt.localeCompare(a.startedAt));
  }

  markSucceeded(id: string, taskId?: string): void {
    this.update(id, { status: "succeeded", taskId });
  }

  markFailed(id: string, error: string): void {
    this.update(id, { status: "failed", error });
  }

  markSkipped(id: string, reason: string): void {
    this.update(id, { status: "skipped", error: reason });
  }

  private update(id: string, patch: Partial<ScheduledRun>): void {
    const current = this.runs.get(id);
    if (!current) return;
    this.runs.set(id, {
      ...current,
      ...patch,
      completedAt: new Date().toISOString(),
    });
  }

  private prune(scheduleId: string): void {
    const runs = this.list(scheduleId);
    if (runs.length <= MAX_RUNS_PER_SCHEDULE) return;
    for (const run of runs.slice(MAX_RUNS_PER_SCHEDULE)) {
      this.runs.delete(run.id);
    }
  }

  protected snapshot(): ScheduledRun[] {
    return structuredClone([...this.runs.values()]);
  }

  protected restore(runs: ScheduledRun[]): void {
    this.runs.clear();
    for (const run of runs) this.runs.set(run.id, run);
  }
}

export class JsonScheduleRunStore extends ScheduleRunStore {
  constructor(private readonly filePath: string) {
    super(loadRuns(filePath));
  }

  override create(scheduleId: string, scheduledFor: string): ScheduledRun | undefined {
    return this.mutate(() => super.create(scheduleId, scheduledFor));
  }

  override markSucceeded(id: string, taskId?: string): void {
    this.mutate(() => {
      super.markSucceeded(id, taskId);
      return true;
    });
  }

  override markFailed(id: string, error: string): void {
    this.mutate(() => {
      super.markFailed(id, error);
      return true;
    });
  }

  override markSkipped(id: string, reason: string): void {
    this.mutate(() => {
      super.markSkipped(id, reason);
      return true;
    });
  }

  private mutate<T>(operation: () => T): T {
    const previous = this.snapshot();
    try {
      const result = operation();
      this.persist();
      return result;
    } catch (error) {
      this.restore(previous);
      throw error;
    }
  }

  private persist(): void {
    mkdirSync(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp`;
    writeFileSync(temporaryPath, `${JSON.stringify(this.snapshot(), null, 2)}\n`, "utf8");
    renameSync(temporaryPath, this.filePath);
  }
}

function loadRuns(filePath: string): ScheduledRun[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error(`定时任务运行记录文件格式错误: ${filePath}`);
  }
  return rows.flatMap((row) => {
    const result = ScheduledRunSchema.safeParse(row);
    return result.success ? [result.data] : [];
  });
}
