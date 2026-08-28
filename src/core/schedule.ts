import { randomUUID } from "node:crypto";
import { z } from "zod";

export const ScheduleRuleSchema = z.discriminatedUnion("kind", [
  z.object({
    kind: z.literal("once"),
    runAt: z.iso.datetime(),
  }),
  z.object({
    kind: z.literal("interval"),
    everyMs: z
      .number()
      .int()
      .min(60_000)
      .max(24 * 60 * 60 * 1000),
  }),
  z.object({
    kind: z.literal("cron"),
    expression: z.string().trim().min(1).max(100),
    timezone: z.string().trim().min(1).default("Asia/Shanghai"),
  }),
]);

export type ScheduleRule = z.infer<typeof ScheduleRuleSchema>;

export const CreateScheduledTaskSchema = z.object({
  creatorOpenId: z.string().min(1),
  chatId: z.string().min(1),
  targetBotId: z.string().min(1),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
});

export type CreateScheduledTask = z.infer<typeof CreateScheduledTaskSchema>;

const ScheduleAddSchema = z.object({
  targetBotId: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,31}$/),
  prompt: z.string().trim().min(1).max(2_000),
  rule: ScheduleRuleSchema,
});

export const ScheduleManageRequestSchema = z.discriminatedUnion("action", [
  z.object({ action: z.literal("list") }),
  z.object({ action: z.literal("add"), ...ScheduleAddSchema.shape }),
  z.object({
    action: z.literal("addMany"),
    schedules: z.array(ScheduleAddSchema).min(1).max(20),
  }),
  z.object({
    action: z.literal("update"),
    id: z.string().trim().min(1).max(64),
    targetBotId: z
      .string()
      .regex(/^[a-z0-9][a-z0-9_-]{0,31}$/)
      .optional(),
    prompt: z.string().trim().min(1).max(2_000).optional(),
    rule: ScheduleRuleSchema.optional(),
  }),
  z.object({ action: z.literal("remove"), id: z.string().trim().min(1).max(64) }),
  z.object({
    action: z.literal("removeMany"),
    ids: z.array(z.string().trim().min(1)).min(1).max(100),
  }),
  z.object({ action: z.literal("removeAll"), confirm: z.literal(true) }),
  z.object({ action: z.literal("run"), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("pause"), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("resume"), id: z.string().trim().min(1).max(64) }),
  z.object({ action: z.literal("logs"), id: z.string().trim().min(1).optional() }),
]);

export type ScheduleManageRequest = z.infer<typeof ScheduleManageRequestSchema>;

export interface ScheduledTask {
  id: string;
  creatorOpenId: string;
  chatId: string;
  targetBotId: string;
  prompt: string;
  rule: ScheduleRule;
  status: "active" | "paused" | "completed";
  nextRunAt?: string;
  lastRunAt?: string;
  createdAt: string;
  updatedAt: string;
}

export function createScheduledTask(options: CreateScheduledTask & { id?: string }): ScheduledTask {
  const now = new Date().toISOString();
  return {
    id: options.id ?? randomUUID().replaceAll("-", "").slice(0, 12),
    creatorOpenId: options.creatorOpenId,
    chatId: options.chatId,
    targetBotId: options.targetBotId,
    prompt: options.prompt,
    rule: options.rule,
    status: "active",
    createdAt: now,
    updatedAt: now,
  };
}

export function scheduleKindLabel(rule: ScheduleRule): string {
  if (rule.kind === "once") return "一次性";
  if (rule.kind === "interval") return "固定间隔";
  return "Cron";
}

export function scheduleDescription(rule: ScheduleRule): string {
  if (rule.kind === "once") return rule.runAt;
  if (rule.kind === "interval") return `每 ${Math.round(rule.everyMs / 60_000)} 分钟`;
  return `${rule.expression} (${rule.timezone})`;
}
