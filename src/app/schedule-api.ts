import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { Scheduler } from "./scheduler.js";
import type { ScheduleStore } from "../core/schedule-store.js";
import type { ScheduleRunStore } from "../core/schedule-run-store.js";
import { CreateScheduledTaskSchema, ScheduleManageRequestSchema } from "../core/schedule.js";
import { executeScheduleManageRequest } from "./schedule-manage-service.js";

export interface ScheduleApiOptions {
  scheduler: Scheduler;
  scheduleStore: ScheduleStore;
  runStore: ScheduleRunStore;
  port: number;
  token?: string;
}

export function startScheduleApi(options: ScheduleApiOptions): void {
  const { scheduler, scheduleStore, runStore, port, token } = options;
  const server = createServer(async (req, res) => {
    try {
      if (!isAuthorized(req, token)) {
        return sendJson(res, 401, { error: "未授权" });
      }
      const url = new URL(req.url ?? "/", "http://localhost");
      const method = req.method ?? "GET";
      const segments = url.pathname.split("/").filter(Boolean);

      if (method === "GET" && matches(segments, ["api", "schedules"])) {
        return sendJson(res, 200, { schedules: scheduler.list() });
      }
      if (method === "POST" && matches(segments, ["api", "schedules"])) {
        const body = await readJson(req);
        const parsed = CreateScheduledTaskSchema.safeParse(body);
        if (!parsed.success) {
          return sendJson(res, 400, { error: "参数不合法", issues: parsed.error.issues });
        }
        const task = scheduler.create(parsed.data);
        return sendJson(res, 201, { schedule: task });
      }
      if (method === "POST" && matches(segments, ["api", "schedules", "manage"])) {
        const body = (await readJson(req)) as {
          request?: unknown;
          chatId?: string;
          creatorOpenId?: string;
        };
        const parsed = ScheduleManageRequestSchema.safeParse(body?.request);
        if (!parsed.success) {
          return sendJson(res, 400, {
            error: "参数不合法",
            issues: parsed.error.issues,
          });
        }
        if (!body?.chatId || !body?.creatorOpenId) {
          return sendJson(res, 400, { error: "缺少 chatId 或 creatorOpenId" });
        }
        const outcome = await executeScheduleManageRequest(parsed.data, {
          scheduler,
          runStore,
          chatId: body.chatId,
          creatorOpenId: body.creatorOpenId,
        });
        return sendJson(res, 200, { ok: true, notice: outcome.notice });
      }
      if (method === "PATCH" && segments[0] === "api" && segments[1] === "schedules" && segments[2]) {
        const id = segments[2];
        const body = (await readJson(req)) as { action?: unknown };
        const action = typeof body.action === "string" ? body.action : "";
        const task = action === "pause" ? scheduler.pause(id) : action === "resume" ? scheduler.resume(id) : undefined;
        if (!task) return sendJson(res, 404, { error: "定时任务不存在或状态不支持" });
        return sendJson(res, 200, { schedule: task });
      }
      if (method === "DELETE" && segments[0] === "api" && segments[1] === "schedules" && segments[2]) {
        const deleted = scheduler.delete(segments[2]);
        return sendJson(res, deleted ? 200 : 404, deleted ? { ok: true } : { error: "定时任务不存在" });
      }
      if (
        method === "POST" &&
        segments[0] === "api" &&
        segments[1] === "schedules" &&
        segments[2] &&
        segments[3] === "run"
      ) {
        const task = await scheduler.runNow(segments[2]);
        if (!task) return sendJson(res, 404, { error: "定时任务不存在" });
        return sendJson(res, 200, { schedule: task });
      }
      if (
        method === "GET" &&
        segments[0] === "api" &&
        segments[1] === "schedules" &&
        segments[2] &&
        segments[3] === "runs"
      ) {
        return sendJson(res, 200, { runs: runStore.list(segments[2]) });
      }
      return sendJson(res, 404, { error: "接口不存在" });
    } catch (error) {
      return sendJson(res, 500, { error: (error as Error).message });
    }
  });
  server.listen(port, () => {
    console.log(`[API] 定时任务管理接口已启动 http://localhost:${port}/api/schedules`);
  });
}

function matches(segments: string[], pattern: string[]): boolean {
  return segments.length === pattern.length && pattern.every((part, index) => segments[index] === part);
}

function isAuthorized(req: IncomingMessage, token?: string): boolean {
  if (!token) return true;
  return req.headers["x-api-token"] === token;
}

async function readJson(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : {};
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
