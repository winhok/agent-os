import { z } from "zod";
import { createServer, type IncomingMessage, type ServerResponse, type Server } from "node:http";
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

const ManageBodySchema = z.object({
  request: ScheduleManageRequestSchema,
  chatId: z.string().trim().min(1),
  creatorOpenId: z.string().trim().min(1),
});
const ActionBodySchema = z.object({ action: z.enum(["pause", "resume"]) });
// A full batch has 20 × 2,000 prompt code units: up to 240 KB when JSON-escaped.
// Leave room for rules, identifiers and serialization overhead.
const MAX_BODY_BYTES = 512 * 1024;

class RequestError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

export function startScheduleApi(options: ScheduleApiOptions): Server {
  const { scheduler, runStore, port, token } = options;
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
        const parsed = ManageBodySchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return sendJson(res, 400, { error: "参数不合法", issues: parsed.error.issues });
        }
        const outcome = await executeScheduleManageRequest(parsed.data.request, {
          scheduler,
          runStore,
          chatId: parsed.data.chatId,
          creatorOpenId: parsed.data.creatorOpenId,
        });
        return sendJson(res, 200, { ok: true, notice: outcome.notice });
      }
      if (method === "PATCH" && segments[0] === "api" && segments[1] === "schedules" && segments[2]) {
        const id = segments[2];
        const parsed = ActionBodySchema.safeParse(await readJson(req));
        if (!parsed.success) {
          return sendJson(res, 400, { error: "参数不合法", issues: parsed.error.issues });
        }
        const action = parsed.data.action;
        const task = action === "pause" ? scheduler.pause(id) : scheduler.resume(id);
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
      if (error instanceof RequestError) return sendJson(res, error.status, { error: error.message });
      console.error("[API] 定时任务管理失败:", error);
      return sendJson(res, 500, { error: "定时任务管理失败" });
    }
  });
  server.listen(port, "127.0.0.1", () => {
    console.log(`[API] 定时任务管理接口已启动 http://127.0.0.1:${port}/api/schedules`);
  });
  return server;
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
  let size = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new RequestError(413, "请求体过大");
    chunks.push(buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8");
  try {
    return text ? JSON.parse(text) : {};
  } catch {
    throw new RequestError(400, "请求体不是合法 JSON");
  }
}

function sendJson(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json; charset=utf-8" });
  res.end(JSON.stringify(data));
}
