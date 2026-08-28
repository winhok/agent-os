import { readFileSync, watchFile, unwatchFile } from "node:fs";
import type { Scheduler } from "./scheduler.js";
import { ScheduledTaskSchema } from "../core/schedule-store.js";
import type { ScheduledTask } from "../core/schedule.js";

export interface ScheduleWatcherOptions {
  scheduler: Scheduler;
  filePath: string;
  intervalMs?: number;
  debounceMs?: number;
}

const SCHEDULE_FIELDS = ["chatId", "creatorOpenId", "targetBotId", "prompt", "rule", "status"] as const;

function readScheduleTasks(filePath: string): ScheduledTask[] {
  let content: string;
  try {
    content = readFileSync(filePath, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const rows: unknown = JSON.parse(content);
  if (!Array.isArray(rows)) {
    throw new Error("schedules.json 必须是任务数组");
  }
  return rows.map((row, index) => {
    const parsed = ScheduledTaskSchema.safeParse(row);
    if (!parsed.success) {
      throw new Error(
        `schedules.json 第 ${index + 1} 条不合法：${parsed.error.issues.map((issue) => issue.path.join(".")).join("、")}`,
      );
    }
    return parsed.data;
  });
}

function sameSchedule(current: ScheduledTask, next: ScheduledTask): boolean {
  return SCHEDULE_FIELDS.every((key) => JSON.stringify(current[key]) === JSON.stringify(next[key]));
}

export function reconcileScheduleFile(scheduler: Scheduler, filePath: string): string[] {
  const fileTasks = readScheduleTasks(filePath);
  const currentTasks = scheduler.list();
  const currentById = new Map(currentTasks.map((task) => [task.id, task]));
  const fileIds = new Set(fileTasks.map((task) => task.id));
  const changes: string[] = [];

  for (const task of currentTasks) {
    if (fileIds.has(task.id)) continue;
    if (scheduler.delete(task.id)) changes.push(`删除 ${task.id}`);
  }

  for (const fileTask of fileTasks) {
    const current = currentById.get(fileTask.id);
    if (!current) {
      scheduler.create({
        id: fileTask.id,
        chatId: fileTask.chatId,
        creatorOpenId: fileTask.creatorOpenId,
        targetBotId: fileTask.targetBotId,
        prompt: fileTask.prompt,
        rule: fileTask.rule,
      });
      if (fileTask.status !== "active") {
        scheduler.update(fileTask.id, { status: fileTask.status });
      }
      changes.push(`新增 ${fileTask.id}`);
      continue;
    }
    if (sameSchedule(current, fileTask)) continue;
    scheduler.update(fileTask.id, {
      chatId: fileTask.chatId,
      creatorOpenId: fileTask.creatorOpenId,
      targetBotId: fileTask.targetBotId,
      prompt: fileTask.prompt,
      rule: fileTask.rule,
      status: fileTask.status,
    });
    changes.push(`更新 ${fileTask.id}`);
  }

  return changes;
}

export function startScheduleFileWatcher(options: ScheduleWatcherOptions): () => void {
  const { scheduler, filePath, intervalMs = 1_000, debounceMs = 300 } = options;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let applying = false;
  let pending = false;

  const apply = () => {
    if (applying) {
      pending = true;
      return;
    }
    applying = true;
    pending = false;
    try {
      const changes = reconcileScheduleFile(scheduler, filePath);
      if (changes.length > 0) {
        console.log(`[定时] schedules.json 已热更新：${changes.join("、")}`);
      }
    } catch (error) {
      console.error("[定时] schedules.json 热更新失败:", (error as Error).message);
    } finally {
      applying = false;
      if (pending) {
        pending = false;
        timer = setTimeout(apply, debounceMs);
      }
    }
  };

  const scheduleApply = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(apply, debounceMs);
  };

  watchFile(filePath, { interval: intervalMs }, (current, previous) => {
    if (current.mtimeMs === previous.mtimeMs && current.size === previous.size) return;
    scheduleApply();
  });

  return () => unwatchFile(filePath);
}
