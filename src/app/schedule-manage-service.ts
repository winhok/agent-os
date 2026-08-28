import type { Scheduler } from "./scheduler.js";
import type { ScheduleRunStore } from "../core/schedule-run-store.js";
import { scheduleDescription, type ScheduleManageRequest, type ScheduledTask } from "../core/schedule.js";
import { buildScheduleCreatedCard, buildScheduleListCard } from "../im/card.js";

export interface ScheduleManageContext {
  scheduler: Scheduler;
  runStore: ScheduleRunStore;
  chatId: string;
  creatorOpenId: string;
}

export interface ScheduleManageOutcome {
  resultCard?: Record<string, unknown>;
  notice: string;
}

function scheduleSummary(task: ScheduledTask): string {
  const rule = scheduleDescription(task.rule);
  const next = task.nextRunAt ? `，下次 ${task.nextRunAt}` : "";
  return `- ${task.id} → ${task.targetBotId}（${rule}，${task.status}${next}）`;
}

function scheduleListNotice(tasks: ScheduledTask[]): string {
  return tasks.length
    ? `当前共 ${tasks.length} 个定时任务：\n${tasks.map(scheduleSummary).join("\n")}`
    : "当前没有定时任务。";
}

export async function executeScheduleManageRequest(
  request: ScheduleManageRequest,
  context: ScheduleManageContext,
): Promise<ScheduleManageOutcome> {
  switch (request.action) {
    case "list": {
      const tasks = context.scheduler.list();
      return {
        resultCard: buildScheduleListCard(tasks),
        notice: scheduleListNotice(tasks),
      };
    }
    case "add": {
      const task = context.scheduler.create({
        creatorOpenId: context.creatorOpenId,
        chatId: context.chatId,
        targetBotId: request.targetBotId,
        prompt: request.prompt,
        rule: request.rule,
      });
      return {
        resultCard: buildScheduleCreatedCard(task),
        notice: `定时任务 ${task.id} 已创建。\n${scheduleSummary(task)}`,
      };
    }
    case "addMany": {
      const tasks = request.schedules.map((item) =>
        context.scheduler.create({
          creatorOpenId: context.creatorOpenId,
          chatId: context.chatId,
          targetBotId: item.targetBotId,
          prompt: item.prompt,
          rule: item.rule,
        }),
      );
      return {
        resultCard: buildScheduleListCard(tasks),
        notice: `已批量创建 ${tasks.length} 个定时任务：\n${tasks.map(scheduleSummary).join("\n")}`,
      };
    }
    case "update": {
      const patch = {
        ...(request.targetBotId ? { targetBotId: request.targetBotId } : {}),
        ...(request.prompt ? { prompt: request.prompt } : {}),
        ...(request.rule ? { rule: request.rule } : {}),
      };
      const updated = context.scheduler.update(request.id, patch);
      return updated
        ? {
            resultCard: buildScheduleCreatedCard(updated),
            notice: `定时任务 ${request.id} 已更新。\n${scheduleSummary(updated)}`,
          }
        : { notice: `没有找到定时任务 ${request.id}。` };
    }
    case "remove": {
      const deleted = context.scheduler.delete(request.id);
      return {
        notice: deleted ? `定时任务 ${request.id} 已删除。` : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "removeMany": {
      const count = context.scheduler.removeMany(request.ids);
      return { notice: `已删除 ${count} 个定时任务。` };
    }
    case "removeAll": {
      const count = context.scheduler.removeAll();
      return { notice: `已删除全部 ${count} 个定时任务。` };
    }
    case "run": {
      const task = await context.scheduler.runNow(request.id);
      return {
        notice: task ? `定时任务 ${request.id} 已触发执行。` : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "pause": {
      const task = context.scheduler.pause(request.id);
      return {
        notice: task ? `定时任务 ${request.id} 已暂停。` : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "resume": {
      const task = context.scheduler.resume(request.id);
      return {
        notice: task ? `定时任务 ${request.id} 已恢复。` : `没有找到定时任务 ${request.id}。`,
      };
    }
    case "logs": {
      const allRuns = request.id
        ? context.runStore.list(request.id)
        : context.scheduler.list().flatMap((task) => context.runStore.list(task.id));
      const runs = [...allRuns].sort((a, b) => b.startedAt.localeCompare(a.startedAt)).slice(0, 10);
      const lines = runs.map(
        (run) =>
          `- [${run.status}] ${run.scheduledFor}${run.taskId ? ` task=${run.taskId}` : ""}${run.error ? ` ${run.error}` : ""}`,
      );
      return {
        notice: allRuns.length ? `最近 ${allRuns.length} 条运行记录：\n${lines.join("\n")}` : "当前没有运行记录。",
      };
    }
  }
}
