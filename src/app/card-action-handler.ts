import type { CardAction, CardActionResponse } from "../im/lark.js";
import { buildResumeCard } from "../im/card.js";
import type { BotConfig } from "../core/bot-registry.js";
import { requestTaskAbort } from "../core/task-abort.js";
import { getCliAdapter } from "../cli/registry.js";
import { listNativeCliSessions } from "../cli/native-sessions.js";
import type { AppRuntime } from "./runtime.js";

export function createCardActionHandler(options: {
  runtime: AppRuntime;
  config: BotConfig;
}): (action: CardAction) => Promise<CardActionResponse | undefined> {
  const { runtime, config } = options;
  return async (action) => {
    if (action.value.action === "resume_cli_session") {
      const agentSessionId = typeof action.value.agentSessionId === "string" ? action.value.agentSessionId : "";
      const cliSessionId = typeof action.value.cliSessionId === "string" ? action.value.cliSessionId : "";
      const session = runtime.sessions.get(agentSessionId);
      if (!session || session.botId !== config.id || !cliSessionId) {
        return { toast: { type: "error", content: "这条会话记录已经失效。" } };
      }
      if (session.status === "active") {
        return {
          toast: { type: "warning", content: "当前任务结束后才能切换会话。" },
        };
      }
      if (session.status === "closed") {
        return {
          toast: { type: "warning", content: "当前话题的会话已经关闭。" },
        };
      }
      try {
        const cliAdapter = getCliAdapter(session.cliId);
        const nativeSessions = await listNativeCliSessions({
          adapter: cliAdapter,
          cwd: session.workspaceDir,
        });
        if (!nativeSessions.some((item) => item.id === cliSessionId)) {
          return {
            toast: {
              type: "error",
              content: "这个 CLI 会话已经不在当前工作目录中。",
            },
          };
        }
        const updated = await runtime.sessions.setCliSessionId(session.id, cliSessionId);
        return {
          toast: { type: "success", content: "已切换到选中的历史会话。" },
          card: {
            type: "raw",
            data: buildResumeCard({
              agentSessionId: updated.id,
              cliName: cliAdapter.displayName,
              currentCliSessionId: updated.cliSessionId,
              sessions: nativeSessions,
            }),
          },
        };
      } catch (error) {
        return { toast: { type: "error", content: (error as Error).message } };
      }
    }

    if (action.value.action !== "abort_task") return undefined;
    const sessionId = typeof action.value.sessionId === "string" ? action.value.sessionId : "";
    const outcome = requestTaskAbort(runtime.activeRuns, sessionId, action.operatorOpenId);
    if (outcome === "not_found") {
      return {
        toast: { type: "info", content: "任务已经结束，无需再次停止。" },
      };
    }
    if (outcome === "forbidden") {
      return {
        toast: { type: "warning", content: "只有任务发起人可以停止它。" },
      };
    }
    if (outcome === "already_stopping") {
      return { toast: { type: "info", content: "正在停止任务，请稍候。" } };
    }
    return { toast: { type: "success", content: "已发送停止指令。" } };
  };
}
