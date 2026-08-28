import { randomUUID } from "node:crypto";
import { Cron } from "croner";
import type { ScheduleRunStore } from "../core/schedule-run-store.js";
import type { ScheduleStore } from "../core/schedule-store.js";
import type { CreateScheduledTask, ScheduledTask } from "../core/schedule.js";
import type { AppRuntime } from "./runtime.js";
import { dispatchScheduledTask } from "./scheduled-task-dispatcher.js";

const ONCE_GRACE_MS = 5 * 60 * 1000;

export class Scheduler {
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private running = false;

  constructor(
    private readonly options: {
      runtime: AppRuntime;
      scheduleStore: ScheduleStore;
      runStore: ScheduleRunStore;
      defaultProductDeliveryMode: "local" | "lark-doc";
      now?: () => Date;
    },
  ) {}

  async start(): Promise<void> {
    if (this.running) return;
    this.running = true;
    this.recoverInterruptedRuns();
    for (const task of this.options.scheduleStore.list()) {
      if (task.status !== "active") continue;
      if (task.rule.kind === "once") {
        const runAt = new Date(task.rule.runAt).getTime();
        if (runAt <= (this.options.now?.() ?? new Date()).getTime()) {
          const skipped = this.options.runStore.create(task.id, task.rule.runAt);
          if (skipped) {
            this.options.runStore.markSkipped(skipped.id, "重启时已经错过一次性任务");
          }
          this.options.scheduleStore.update(task.id, { status: "completed" });
          continue;
        }
      }
      this.schedule(task);
    }
  }

  stop(): void {
    this.running = false;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }

  list(): ScheduledTask[] {
    return this.options.scheduleStore.list();
  }

  get(id: string): ScheduledTask | undefined {
    return this.options.scheduleStore.get(id);
  }

  create(options: CreateScheduledTask & { id?: string }): ScheduledTask {
    const task = this.options.scheduleStore.create(options);
    if (task.status === "active") this.schedule(task);
    return task;
  }

  pause(id: string): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task || task.status !== "active") return task;
    this.clearTimer(id);
    return this.options.scheduleStore.update(id, { status: "paused" });
  }

  resume(id: string): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task || task.status !== "paused") return task;
    const updated = this.options.scheduleStore.update(id, { status: "active" });
    if (updated) this.schedule(updated);
    return updated;
  }

  delete(id: string): boolean {
    this.clearTimer(id);
    return this.options.scheduleStore.delete(id);
  }

  update(
    id: string,
    patch: Partial<Pick<ScheduledTask, "targetBotId" | "prompt" | "rule" | "status" | "chatId" | "creatorOpenId">>,
  ): ScheduledTask | undefined {
    const task = this.options.scheduleStore.get(id);
    if (!task) return undefined;
    const updated = this.options.scheduleStore.update(id, patch);
    if (updated) {
      this.clearTimer(id);
      if (updated.status === "active") this.schedule(updated);
    }
    return updated;
  }

  removeMany(ids: string[]): number {
    let count = 0;
    for (const id of ids) {
      if (this.delete(id)) count += 1;
    }
    return count;
  }

  removeAll(): number {
    return this.removeMany(this.list().map((task) => task.id));
  }

  async runNow(id: string): Promise<ScheduledTask | undefined> {
    const task = this.options.scheduleStore.get(id);
    if (!task) return undefined;
    await this.trigger(task, this.options.now?.()?.toISOString() ?? new Date().toISOString());
    return this.options.scheduleStore.get(id);
  }

  private schedule(task: ScheduledTask): void {
    this.clearTimer(task.id);
    const delayMs = this.nextRunDelay(task);
    if (delayMs === undefined) return;
    const updated = this.options.scheduleStore.update(task.id, {
      nextRunAt: new Date(Date.now() + delayMs).toISOString(),
    });
    if (!updated) return;
    const timer = setTimeout(() => {
      this.timers.delete(task.id);
      void this.onDue(updated);
    }, delayMs);
    timer.unref?.();
    this.timers.set(task.id, timer);
  }

  private nextRunDelay(task: ScheduledTask): number | undefined {
    const now = this.options.now?.() ?? new Date();
    if (task.rule.kind === "once") {
      const runAt = new Date(task.rule.runAt).getTime();
      if (runAt <= now.getTime()) return undefined;
      return runAt - now.getTime();
    }
    if (task.rule.kind === "interval") return task.rule.everyMs;

    try {
      const cron = new Cron(task.rule.expression, {
        timezone: task.rule.timezone,
      });
      const next = cron.msToNext();
      return next === null || next === undefined ? undefined : Math.max(1_000, next);
    } catch (error) {
      console.error(`[定时] Cron 表达式无效，已暂停任务 ${task.id}:`, (error as Error).message);
      this.options.scheduleStore.update(task.id, { status: "paused" });
      return undefined;
    }
  }

  private async onDue(task: ScheduledTask): Promise<void> {
    const current = this.options.scheduleStore.get(task.id);
    if (!current || current.status !== "active") return;
    const scheduledFor = new Date().toISOString();
    await this.trigger(current, scheduledFor);

    if (current.rule.kind === "once") {
      this.options.scheduleStore.update(current.id, { status: "completed" });
    } else {
      const refreshed = this.options.scheduleStore.get(current.id);
      if (refreshed?.status === "active") this.schedule(refreshed);
    }
  }

  private async trigger(task: ScheduledTask, scheduledFor: string): Promise<void> {
    if (this.options.runStore.find(task.id, scheduledFor)) return;
    const running = this.options.runStore.latestRunning(task.id);
    if (running) {
      const skipped = this.options.runStore.create(task.id, scheduledFor);
      if (skipped) this.options.runStore.markSkipped(skipped.id, "上一轮仍在执行，本轮跳过");
      return;
    }
    const run = this.options.runStore.create(task.id, scheduledFor);
    if (!run) return;
    const taskId = randomUUID().replaceAll("-", "").slice(0, 24);
    this.options.scheduleStore.update(task.id, { lastRunAt: scheduledFor });
    try {
      await dispatchScheduledTask({
        runtime: this.options.runtime,
        task,
        scheduledFor,
        defaultProductDeliveryMode: this.options.defaultProductDeliveryMode,
      });
      this.options.runStore.markSucceeded(run.id, taskId);
      console.log(`[定时] task=${task.id} run=${run.id} -> ${task.targetBotId} succeeded`);
    } catch (error) {
      this.options.runStore.markFailed(run.id, (error as Error).message);
      console.error(`[定时] task=${task.id} run=${run.id} 执行失败:`, (error as Error).message);
    }
  }

  private recoverInterruptedRuns(): void {
    for (const task of this.options.scheduleStore.list()) {
      for (const run of this.options.runStore.list(task.id)) {
        if (run.status === "running") {
          this.options.runStore.markFailed(run.id, "进程重启，运行中断");
        }
      }
    }
  }

  private clearTimer(id: string): void {
    const timer = this.timers.get(id);
    if (timer) clearTimeout(timer);
    this.timers.delete(id);
  }
}
