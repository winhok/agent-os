import { readJsonState, preserveJsonFields } from "./json-state-reader.js";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import {
  ScheduledTaskSchema,
  ScheduledTaskPatchSchema,
  ScheduledTaskUpdateSchema,
  createScheduledTask,
  type CreateScheduledTask,
  type ScheduledTask,
  type ScheduledTaskPatch,
} from "./schedule.js";

export { ScheduledTaskSchema } from "./schedule.js";

export class ScheduleStore {
  private readonly tasks = new Map<string, ScheduledTask>();

  constructor(initialTasks: ScheduledTask[] = []) {
    for (const task of initialTasks) this.tasks.set(task.id, task);
  }

  list(): ScheduledTask[] {
    return [...this.tasks.values()].sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  }

  get(id: string): ScheduledTask | undefined {
    return this.tasks.get(id);
  }

  create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    const task = createScheduledTask(options);
    this.tasks.set(task.id, task);
    return task;
  }

  update(id: string, patch: ScheduledTaskPatch): ScheduledTask | undefined {
    const current = this.tasks.get(id);
    if (!current) return undefined;
    const validatedPatch = ScheduledTaskPatchSchema.parse(patch);
    const updated = preserveJsonFields(
      current,
      ScheduledTaskSchema.parse({
        ...current,
        ...validatedPatch,
        id: current.id,
        revision:
          current.revision + (ScheduledTaskUpdateSchema.keyof().options.some((key) => key in validatedPatch) ? 1 : 0),
        updatedAt: new Date().toISOString(),
      }),
    );
    this.tasks.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.tasks.delete(id);
  }

  protected snapshot(): ScheduledTask[] {
    return structuredClone([...this.tasks.values()]);
  }

  protected restore(tasks: ScheduledTask[]): void {
    this.tasks.clear();
    for (const task of tasks) this.tasks.set(task.id, task);
  }
}

export class JsonScheduleStore extends ScheduleStore {
  constructor(private readonly filePath: string) {
    const loaded = loadTasks(filePath);
    super(loaded.records);
    if (loaded.changed) this.persist();
  }

  override create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    return this.mutate(() => super.create(options));
  }

  override update(id: string, patch: ScheduledTaskPatch): ScheduledTask | undefined {
    return this.mutate(() => super.update(id, patch));
  }

  override delete(id: string): boolean {
    return this.mutate(() => super.delete(id));
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

function loadTasks(filePath: string): { records: ScheduledTask[]; changed: boolean } {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return { records: [], changed: false };
    throw error;
  }
  return readJsonState(content, filePath, "定时任务状态文件", ScheduledTaskSchema, {
    keys: (record) => [record.id],
    migrated: (row) => typeof row === "object" && row !== null && !("revision" in row),
  });
}
